/**
 * DSH bundle update check (T079, research.md R11).
 *
 * DSH has no plugin auto-update, so Magic Context owns the check: probe the
 * npm registry once per session boot (started by the maintenance lane, never
 * coupled to dreamer ticks), compare against the bundle actually installed
 * under `$DSH_HOME/profiles/<name>/node_modules/`, and apply an update
 * through the host command `dsh plugin --profile <name> add <pkg>@<version>`
 * — falling back to reporting exactly that command when the CLI is not
 * runnable here. An update is never applied to a dev (`link:`/`file:`) or
 * user-pinned install, never against `auto_update: false`, and is always
 * announced as restart-required because the host fixes the bundle set at
 * process start. There is no toast seam on DSH: everything is announced
 * through the core log.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	compareSemverCore,
	isValidSemver,
} from "@magic-context/core/hooks/auto-update-checker/semver";
import { log } from "@magic-context/core/shared/logger";

export const DSH_BUNDLE_PACKAGE = "@cortexkit/dsh-magic-context";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_START_DELAY_MS = 5_000;
const HOST_COMMAND_TIMEOUT_MS = 120_000;
const LOG_PREFIX = "[dsh-update]";

export type BundleProvenance = "registry" | "dev" | "pinned";

export interface DshUpdateCheckDeps {
	readonly config: { readonly auto_update?: boolean };
	readonly env?: Record<string, string | undefined>;
	/** Injectable fetch (tests run without network). */
	readonly fetchImpl?: (
		url: string,
		init: { signal?: AbortSignal },
	) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
	/** Injectable host-command runner; returns whether it succeeded. */
	readonly runCommand?: (argv: readonly string[]) => boolean;
	readonly registryUrl?: string;
	readonly fetchTimeoutMs?: number;
	/** Test seam for the lane-start delay (default 5s). */
	readonly startDelayMs?: number;
}

export interface DshUpdateCheckOutcome {
	readonly status:
		| "disabled"
		| "not-installed"
		| "dev-install"
		| "pinned"
		| "up-to-date"
		| "applied"
		| "available"
		| "registry-unreachable";
	readonly profile: string | null;
	readonly installedVersion: string | null;
	readonly latestVersion: string | null;
	readonly command: readonly string[] | null;
	readonly restartRequired: boolean;
	readonly message: string;
}

export interface DshUpdateCheckHandle {
	stop(): void;
}

function dshHome(env: Record<string, string | undefined>): string {
	const fromEnv = env["DSH_HOME"];
	if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".dsh");
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return null;
	} catch {
		return null;
	}
}

/** Dependency spec for the bundle across the manifest's dependency sections. */
function bundleSpec(manifest: Record<string, unknown>): string | null {
	for (const section of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
	]) {
		const deps = manifest[section];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
		const spec = (deps as Record<string, unknown>)[DSH_BUNDLE_PACKAGE];
		if (typeof spec === "string") return spec;
	}
	return null;
}

/** First profile (DSH_PROFILE-preferred) whose manifest carries the bundle. */
function installedTarget(
	env: Record<string, string | undefined>,
): { profile: string; spec: string } | null {
	const profilesDir = join(dshHome(env), "profiles");
	if (!existsSync(profilesDir)) return null;
	const preferred = env["DSH_PROFILE"];
	const names = readdirSync(profilesDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort();
	if (preferred && names.includes(preferred)) {
		const spec = manifestSpecFor(profilesDir, preferred);
		if (spec !== null) return { profile: preferred, spec };
	}
	for (const name of names) {
		const spec = manifestSpecFor(profilesDir, name);
		if (spec !== null) return { profile: name, spec };
	}
	return null;
}

function manifestSpecFor(profilesDir: string, profile: string): string | null {
	const manifest = readJson(join(profilesDir, profile, "package.json"));
	if (!manifest) return null;
	return bundleSpec(manifest);
}

function installedVersion(
	env: Record<string, string | undefined>,
	profile: string,
): string | null {
	const pkg = readJson(
		join(
			dshHome(env),
			"profiles",
			profile,
			"node_modules",
			...DSH_BUNDLE_PACKAGE.split("/"),
			"package.json",
		),
	);
	const version = pkg?.["version"];
	return typeof version === "string" && isValidSemver(version) ? version : null;
}

/**
 * Shared provenance/pinning rules (R11): a `link:`/`file:`/path dev install
 * is never touched; an exact version pin is the user's and only gets a
 * report; floating specs (`latest`, `^`, `~`, ranges, no version) are ours
 * to keep current.
 */
export function classifyBundleSpec(rawSpec: string): {
	provenance: BundleProvenance;
	specVersion: string | null;
} {
	let spec = rawSpec.trim();
	if (spec.startsWith("npm:")) spec = spec.slice("npm:".length);
	// Strip the package name; a trailing @ is the requested version.
	const at = spec.lastIndexOf("@cortexkit/dsh-magic-context");
	if (at !== -1)
		spec = spec.slice(at + DSH_BUNDLE_PACKAGE.length).replace(/^@/, "");
	if (spec.length === 0 || spec === "latest" || spec === "*")
		return { provenance: "registry", specVersion: null };
	if (
		spec.startsWith("link:") ||
		spec.startsWith("file:") ||
		spec.startsWith("workspace:") ||
		spec.startsWith(".") ||
		spec.startsWith("/")
	) {
		return { provenance: "dev", specVersion: null };
	}
	if (isValidSemver(spec)) return { provenance: "pinned", specVersion: spec };
	return { provenance: "registry", specVersion: null };
}

/** Dist-tag for the installed version's release channel (rc/beta/…/latest). */
export function channelForVersion(version: string): string {
	const prerelease = version.split("-")[1];
	const channel = prerelease?.match(/^(alpha|beta|rc|canary|next)/)?.[1];
	return channel ?? "latest";
}

async function fetchDistTags(
	deps: DshUpdateCheckDeps,
	env: Record<string, string | undefined>,
): Promise<Record<string, string> | null> {
	const registry = (deps.registryUrl ?? DEFAULT_REGISTRY_URL).replace(
		/\/+$/,
		"",
	);
	const url = `${registry}/${encodeURIComponent(DSH_BUNDLE_PACKAGE)}`;
	const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
	try {
		const fetchImpl =
			deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
		const response = await fetchImpl(url, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			log(
				`${LOG_PREFIX} registry probe failed (HTTP ${String(response.status)})`,
			);
			return null;
		}
		const body = await response.json();
		if (!body || typeof body !== "object" || Array.isArray(body)) return null;
		const tags = (body as Record<string, unknown>)["dist-tags"];
		if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(
			tags as Record<string, unknown>,
		)) {
			if (typeof value === "string" && isValidSemver(value)) out[key] = value;
		}
		return out;
	} catch (error) {
		log(
			`${LOG_PREFIX} registry probe errored: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

function defaultRunCommand(argv: readonly string[]): boolean {
	try {
		const result = spawnSync(argv[0] as string, argv.slice(1) as string[], {
			windowsHide: true,
			stdio: "ignore",
			timeout: HOST_COMMAND_TIMEOUT_MS,
			env: { ...process.env },
		});
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

/**
 * One update check against the machine's DSH install. Pure and injectable —
 * safe to call from tests; the maintenance lane wraps it in a once-per-boot
 * timer.
 */
export async function runDshUpdateCheck(
	deps: DshUpdateCheckDeps,
): Promise<DshUpdateCheckOutcome> {
	const env = deps.env ?? process.env;
	const outcome = (
		status: DshUpdateCheckOutcome["status"],
		extra: Partial<Omit<DshUpdateCheckOutcome, "status">> = {},
	): DshUpdateCheckOutcome => ({
		status,
		profile: null,
		installedVersion: null,
		latestVersion: null,
		command: null,
		restartRequired: false,
		message: "",
		...extra,
	});

	if (deps.config.auto_update === false) {
		return outcome("disabled", {
			message: "auto_update is off; update check skipped.",
		});
	}

	const target = installedTarget(env);
	if (target === null) {
		return outcome("not-installed", {
			message: "No profile carries the Magic Context bundle.",
		});
	}
	const { profile, spec } = target;

	const provenance = classifyBundleSpec(spec);
	if (provenance.provenance === "dev") {
		return outcome("dev-install", {
			profile,
			message: `Profile "${profile}" installs the bundle from "${spec}" (dev link); not updating.`,
		});
	}

	const installed = installedVersion(env, profile);
	if (installed === null) {
		return outcome("not-installed", {
			profile,
			message: `Profile "${profile}" declares the bundle but no installed package was found under its node_modules.`,
		});
	}

	const distTags = await fetchDistTags(deps, env);
	if (distTags === null) {
		return outcome("registry-unreachable", {
			profile,
			installedVersion: installed,
			message: "npm registry probe failed; no update decision.",
		});
	}
	const channel = channelForVersion(installed);
	const latest = distTags[channel] ?? null;
	if (latest === null) {
		return outcome("registry-unreachable", {
			profile,
			installedVersion: installed,
			message: `Registry has no "${channel}" dist-tag; no update decision.`,
		});
	}

	const base = { profile, installedVersion: installed, latestVersion: latest };
	const newer = compareSemverCore(latest, installed);
	if (newer === null || newer <= 0) {
		return outcome("up-to-date", {
			...base,
			message: `Bundle ${installed} is current for channel "${channel}".`,
		});
	}

	const command: readonly string[] = [
		"dsh",
		"plugin",
		"--profile",
		profile,
		"add",
		`${DSH_BUNDLE_PACKAGE}@${latest}`,
	];
	const updateText = `Magic Context bundle ${installed} → ${latest} (profile "${profile}")`;
	if (provenance.provenance === "pinned") {
		return outcome("pinned", {
			...base,
			command,
			message: `${updateText}: pinned to ${provenance.specVersion ?? installed}; run \`dsh plugin --profile ${profile} add ${DSH_BUNDLE_PACKAGE}@${latest}\` to update manually.`,
		});
	}

	const ran = (deps.runCommand ?? defaultRunCommand)(command);
	if (ran) {
		return outcome("applied", {
			...base,
			command,
			restartRequired: true,
			message: `${updateText}: applied via the host command. Restart dsh (profile "${profile}") — the bundle set is fixed at process start.`,
		});
	}
	return outcome("available", {
		...base,
		command,
		message: `${updateText}: could not run the host command; run \`dsh plugin --profile ${profile} add ${DSH_BUNDLE_PACKAGE}@${latest}\`.`,
	});
}

/**
 * Lane-start entry: fires exactly one check per session boot after a short
 * delay (never blocking host startup), announces through the core log, and
 * stays quiet unless `auto_update` stands. No toast seam on DSH — status and
 * the log are the announcement channel.
 */
export function startDshUpdateCheck(
	deps: DshUpdateCheckDeps,
): DshUpdateCheckHandle {
	if (deps.config.auto_update === false) {
		log(`${LOG_PREFIX} auto_update is off; no update check this session`);
		return { stop: () => {} };
	}
	{
		const env = deps.env ?? process.env;
		if (
			env["MAGIC_CONTEXT_NO_AUTO_UPDATE"] === "1" ||
			env["MAGIC_CONTEXT_TEST_DATA_DIR"] !== undefined
		) {
			// Opt-out seam; the test backstop marker additionally keeps every
			// test mount off the network and the real bundle cache.
			return { stop: () => {} };
		}
	}
	let stopped = false;
	let ran = false;
	const timer = setTimeout(() => {
		if (stopped || ran) return;
		ran = true;
		void runDshUpdateCheck(deps)
			.then((result) => {
				if (result.status === "up-to-date") return;
				log(`${LOG_PREFIX} ${result.message}`);
			})
			.catch((error: unknown) => {
				log(
					`${LOG_PREFIX} check crashed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
	}, deps.startDelayMs ?? DEFAULT_START_DELAY_MS);
	if (typeof timer === "object" && timer !== null && "unref" in timer) {
		(timer as { unref: () => void }).unref();
	}
	return {
		stop: () => {
			stopped = true;
			clearTimeout(timer);
		},
	};
}
