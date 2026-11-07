/**
 * Isolated live DSH home (T003).
 *
 * Live gates must never touch the developer's real `DSH_HOME`: profiles there are
 * user state, and the agent sandbox may expose them read-only. This helper seeds a
 * throwaway home under the repository's ignored `tmp/` tree, installs this package
 * into a `headless` profile by manifest + symlink (no package manager needed), and
 * runs one-shot headless turns against it.
 *
 * Every path is workspace-local on purpose: platform temp directories are not
 * guaranteed to survive between processes, and DSH writes profile state during boot.
 *
 * Env:
 * - `MC_DSH_TEST_ROOT` overrides the root (defaults to `<repo>/tmp/dsh-live-<pid>-<n>`).
 * - `MC_DSH_BIN` overrides the binary (defaults to `dsh` on PATH).
 */
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const PACKAGE_DIR = resolve(import.meta.dir, "..");
const DSH_BIN = process.env.MC_DSH_BIN ?? "dsh";

export interface LiveRoute {
	/** Provider id used by the profile, e.g. "test-route". */
	readonly provider: string;
	/** Provider display name. */
	readonly displayName?: string;
	/** OpenAI-compatible base URL (a mock server or a real gateway). */
	readonly baseURL: string;
	/** Env var holding the key; the caller owns providing it to the child. */
	readonly apiKeyEnv?: string;
	/** One or more model ids. */
	readonly models: readonly {
		readonly id: string;
		readonly contextWindow?: number;
		readonly maxTokens?: number;
		readonly input?: readonly ("text" | "image")[];
	}[];
}

export interface LiveHomeOptions {
	/** Profile name; defaults to "e2e". */
	readonly profile?: string;
	/** Extra profile patch rows appended after the route. */
	readonly patch?: readonly Record<string, unknown>[];
	/** Optional model route written into the profile patch. */
	readonly route?: LiveRoute;
	/** Default model id for the route; required when `route` is set. */
	readonly defaultModel?: string;
	/** Root override; defaults to the repo's ignored tmp tree. */
	readonly root?: string;
}

export interface LiveTurnResult {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly events: readonly Record<string, unknown>[];
	readonly stdout: string;
	readonly stderr: string;
}

export interface LiveHome {
	readonly home: string;
	readonly profile: string;
	readonly profileDir: string;
	dumpConfig(): string;
	runHeadless(
		prompt: string,
		options?: {
			sessionId?: string;
			args?: readonly string[];
			env?: Record<string, string>;
		},
	): LiveTurnResult;
	/**
	 * Same turn, awaited instead of blocking. Required whenever the test hosts
	 * an in-process mock provider: `spawnSync` blocks the event loop, so the
	 * server could never answer its own child.
	 */
	runHeadlessAsync(
		prompt: string,
		options?: {
			sessionId?: string;
			args?: readonly string[];
			env?: Record<string, string>;
		},
	): Promise<LiveTurnResult>;
	dispose(): void;
}

function dshEnv(
	home: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		...process.env,
		DSH_HOME: home,
		// A live gate is production: `bun test` sets NODE_ENV=test for the
		// PARENT, and the child would inherit it and redirect the store to the
		// throwaway backstop (making every gate run against an empty DB).
		NODE_ENV: "production",
		// The shared MC store follows XDG_DATA_HOME. Pointing it inside the
		// throwaway home keeps every live gate off the developer's real store
		// (and inside the workspace sandbox).
		XDG_DATA_HOME: join(home, "data"),
		...extra,
	} as Record<string, string>;
}

/** Newest mtime under a source tree. */
function newestMtime(directory: string): number {
	let newest = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "tmp") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
		else if (entry.name.endsWith(".ts") || entry.name.endsWith(".json") || entry.name.endsWith(".yml")) {
			newest = Math.max(newest, statSync(path).mtimeMs);
		}
	}
	return newest;
}

/**
 * Rebuild `dist/` when the sources are newer. The profile symlinks this
 * package and DSH loads `main` (`dist/index.js`), so a live gate that skipped
 * this would validate stale code — the worst possible evidence. Builds are
 * sub-second, so the freshness check is unconditional rather than opt-in.
 */
function ensureFreshBuild(): void {
	const distEntry = join(PACKAGE_DIR, "dist", "index.js");
	const source = newestMtime(join(PACKAGE_DIR, "src"));
	if (existsSync(distEntry) && statSync(distEntry).mtimeMs >= source) return;
	const build = spawnSync(
		"bun",
		[
			"build",
			"src/index.ts",
			"../plugin/src/features/magic-context/migration-worker.ts",
			"--outdir",
			"dist",
			"--entry-naming",
			"[name].[ext]",
			"--target",
			"node",
			"--format",
			"esm",
			"--splitting",
			"--external",
			"@deepseek-ai/cordis",
			"--external",
			"@deepseek-ai/dsh-session",
			"--external",
			"@deepseek-ai/dsh-agent",
			"--external",
			"@deepseek-ai/dsh-llm",
			"--external",
			"@deepseek-ai/dsh-tools",
			"--external",
			"@deepseek-ai/dsh-compaction",
			"--external",
			"@deepseek-ai/dsh-token-meter",
			"--external",
			"@deepseek-ai/dsh-session-query",
			"--external",
			"@deepseek-ai/dsh-attachment",
			"--external",
			"@deepseek-ai/dsh-commands",
			"--external",
			"node:sqlite",
		],
		{ cwd: PACKAGE_DIR, encoding: "utf8", timeout: 120_000 },
	);
	if (build.status !== 0) throw new Error(`dsh-magic-context build failed: ${build.stderr || build.stdout}`);
}

/** Seed a throwaway `headless` profile that loads this package as a bundle. */
export function createLiveHome(options: LiveHomeOptions = {}): LiveHome {
	ensureFreshBuild();
	const profile = options.profile ?? "e2e";
	const rootParent = process.env.MC_DSH_TEST_ROOT ?? join(REPO_ROOT, "tmp");
	mkdirSync(rootParent, { recursive: true });
	const root = options.root ?? mkdtempSync(join(rootParent, "dsh-live-"));
	const home = join(root, "home");
	const profileDir = join(home, "profiles", profile);
	mkdirSync(profileDir, { recursive: true });

	const seeded = spawnSync(
		DSH_BIN,
		[
			"--profile",
			profile,
			"--from-default-profile",
			"headless",
			"--dump-config",
		],
		{
			env: dshEnv(home),
			encoding: "utf8",
			timeout: 120_000,
		},
	);
	if (seeded.status !== 0) {
		throw new Error(
			`dsh profile seed failed (${String(seeded.status)}): ${seeded.stderr || seeded.stdout}`,
		);
	}

	writeFileSync(
		join(profileDir, "package.json"),
		`${JSON.stringify(
			{
				name: `dsh-profile-${profile}`,
				private: true,
				dependencies: { "@cortexkit/dsh-magic-context": `link:${PACKAGE_DIR}` },
				dsh: {
					profile: {
						bundles: [
							"@deepseek-ai/dsh-base",
							"@deepseek-ai/dsh-headless",
							"@cortexkit/dsh-magic-context",
						],
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);
	const moduleDir = join(profileDir, "node_modules", "@cortexkit");
	mkdirSync(moduleDir, { recursive: true });
	symlinkSync(PACKAGE_DIR, join(moduleDir, "dsh-magic-context"), "dir");

	if (options.route || options.patch) {
		const rows: Record<string, unknown>[] = [];
		if (options.route) {
			if (!options.defaultModel)
				throw new Error("defaultModel is required with a route");
			rows.push({
				id: "llm-pi-ai",
				name: "@deepseek-ai/dsh-llm-pi-ai",
				config: {
					providers: {
						[options.route.provider]: {
							displayName: options.route.displayName ?? options.route.provider,
							...(options.route.apiKeyEnv === undefined
								? {}
								: { apiKeyEnv: options.route.apiKeyEnv }),
							api: "openai-completions",
							baseURL: options.route.baseURL,
							models: options.route.models.map((model) => ({
								id: model.id,
								name: model.id,
								...(model.input === undefined
									? {}
									: { input: [...model.input] }),
								...(model.maxTokens === undefined
									? {}
									: { maxTokens: model.maxTokens }),
								...(model.contextWindow === undefined
									? {}
									: { contextWindow: model.contextWindow }),
							})),
						},
					},
				},
			});
			rows.push({
				id: "agent-default-model",
				name: "@deepseek-ai/dsh-agent-default-model",
				config: {
					provider: options.route.provider,
					model: options.defaultModel,
				},
			});
		}
		rows.push(...(options.patch ?? []));
		writeFileSync(
			join(profileDir, "cordis.patch.yml"),
			`${JSON.stringify(rows, null, 2)}\n`,
		);
	}

	return {
		home,
		profile,
		profileDir,
		dumpConfig() {
			const result = spawnSync(
				DSH_BIN,
				["--profile", profile, "--dump-config"],
				{
					env: dshEnv(home),
					encoding: "utf8",
					timeout: 120_000,
				},
			);
			if (result.status !== 0)
				throw new Error(
					`dump-config failed: ${result.stderr || result.stdout}`,
				);
			return result.stdout;
		},
		runHeadless(prompt, runOptions = {}) {
			const result = spawnSync(DSH_BIN, turnArgs(profile, prompt, runOptions), {
				env: dshEnv(home, runOptions.env),
				encoding: "utf8",
				timeout: Number(process.env.MC_DSH_TURN_TIMEOUT_MS ?? 300_000),
			});
			return toTurnResult(result.stdout, result.stderr, result.status, result.signal);
		},
		async runHeadlessAsync(prompt, runOptions = {}) {
			const child = spawn(DSH_BIN, turnArgs(profile, prompt, runOptions), {
				env: dshEnv(home, runOptions.env),
			});
			let stdout = "";
			let stderr = "";
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk;
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk;
			});
			const timeoutMs = Number(process.env.MC_DSH_TURN_TIMEOUT_MS ?? 300_000);
			const outcome = await new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
			}>((resolve) => {
				const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
				child.on("error", () => {
					clearTimeout(timer);
					resolve({ code: null, signal: null });
				});
				child.on("close", (code, signal) => {
					clearTimeout(timer);
					resolve({ code, signal });
				});
			});
			return toTurnResult(stdout, stderr, outcome.code, outcome.signal);
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Every session id that appeared in a headless NDJSON stream. */
export function sessionIdsFrom(result: LiveTurnResult): string[] {
	const ids = new Set<string>();
	for (const event of result.events) {
		const session = event["session"];
		if (typeof session === "string") ids.add(session);
		const sessionId = event["sessionId"];
		if (typeof sessionId === "string") ids.add(sessionId);
	}
	return [...ids];
}

interface TurnOptions {
	readonly sessionId?: string;
	readonly args?: readonly string[];
	readonly env?: Record<string, string>;
}

function turnArgs(profile: string, prompt: string, options: TurnOptions): string[] {
	const args = ["--profile", profile, "--json", ...(options.args ?? [])];
	if (options.sessionId) args.push("--session-id", options.sessionId);
	args.push(prompt);
	return args;
}

function toTurnResult(
	stdout: string | null | undefined,
	stderr: string | null | undefined,
	status: number | null,
	signal: NodeJS.Signals | null,
): LiveTurnResult {
	const events = (stdout ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{"))
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
	return {
		status,
		signal,
		events,
		stdout: stdout ?? "",
		stderr: stderr ?? "",
	};
}
