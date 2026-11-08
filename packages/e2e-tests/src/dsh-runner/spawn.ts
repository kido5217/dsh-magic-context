/**
 * DSH headless e2e runner (T080).
 *
 * Builds an isolated DSH home per scenario — a throwaway `DSH_HOME` under the
 * e2e temp tree, a profile seeded from the shipped `headless` template with
 * `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-headless` and the Magic Context
 * bundle (linked from `packages/dsh-plugin`, never the published package) —
 * and runs one-shot headless turns against it. This mirrors
 * `packages/dsh-plugin/test/live-home.ts`; the copy is deliberate: the e2e
 * lane owns its environment shaping (mock route, XDG pinning, temp-tree
 * cleanup) and must not depend on another package's test directory.
 *
 * Session model (DSH contract, `packages/bundle/headless/README.md`): every
 * boot without `--session-id` opens a fresh `session-<uuid>`, reported in the
 * opening `session` event; `--session-id <id>` adopts the EXISTING persisted
 * session (an unknown id fails before the task runs), and adoption is bound
 * to the working directory the session recorded — so every turn of one
 * scenario runs with the same `cwd`.
 *
 * Env:
 * - `MC_DSH_BIN` overrides the `dsh` binary (default: `dsh` on PATH).
 * - `MC_DSH_TURN_TIMEOUT_MS` bounds one headless turn (default 180s).
 * - `MC_E2E_DSH_SKIP_BUILD=1` skips the freshness rebuild of dsh-plugin dist.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { assertMockEndpoint } from "../mock-routing";
import { cleanupE2ETempDir, createE2ETempDir } from "../temp-dir";

export const REPO_ROOT = resolve(import.meta.dir, "../../../..");
export const DSH_PLUGIN_ROOT = join(REPO_ROOT, "packages", "dsh-plugin");
export const DSH_BIN = process.env.MC_DSH_BIN ?? "dsh";

/** Env var the seeded profile points the mock route's key at. */
export const DSH_MOCK_API_KEY_ENV = "MC_MOCK_API_KEY";
const DSH_MOCK_API_KEY = "mock-key";

const LOG_FILE_NAMES = [
	"session.v4.jsonl.zstd",
	"session.v3.jsonl.zstd",
	"session.jsonl.zstd",
] as const;

export interface DshMockModel {
	readonly id: string;
	readonly contextWindow?: number;
	readonly maxTokens?: number;
}

export interface DshProfileOptions {
	/** Provider id written into the profile route (default: "mock"). */
	providerId?: string;
	/** Loopback mock provider base URL, e.g. `http://127.0.0.1:54321/v1`. */
	mockBaseURL: string;
	/** Models advertised on the mock route. */
	models: readonly DshMockModel[];
	/** Default model id; must be one of `models`. */
	defaultModel: string;
	/** Extra cordis.patch.yml rows appended after the route rows. */
	patch?: readonly Record<string, unknown>[];
	/** Shared Magic Context settings merged into the seeded user config. */
	magicContextConfig?: Record<string, unknown>;
}

export interface DshIsolatedEnv {
	baseDir: string;
	home: string;
	profile: string;
	profileDir: string;
	configDir: string;
	dataDir: string;
	cacheDir: string;
	workdir: string;
}

export interface DshTurnOptions {
	sessionId?: string;
	args?: readonly string[];
	env?: Record<string, string>;
	timeoutMs?: number;
}

export interface DshTurnResult {
	sessionId: string | null;
	events: Array<Record<string, unknown>>;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
}

/** Rebuild `packages/dsh-plugin/dist` when sources are newer (live-home rule). */
function newestMtime(directory: string): number {
	let newest = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (
			entry.name === "node_modules" ||
			entry.name === "dist" ||
			entry.name === "tmp"
		)
			continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
		else if (
			entry.name.endsWith(".ts") ||
			entry.name.endsWith(".json") ||
			entry.name.endsWith(".yml")
		) {
			newest = Math.max(newest, statSync(path).mtimeMs);
		}
	}
	return newest;
}

/**
 * The profile symlinks the package and DSH loads its `main` (`dist/index.js`),
 * so a lane that skipped this freshness check would validate stale code — the
 * worst possible evidence. Build into a sibling directory and swap, so a
 * parallel boot never sees a half-written bundle.
 */
export function ensureDshPluginBuilt(): void {
	if (process.env.MC_E2E_DSH_SKIP_BUILD === "1") return;
	const distEntry = join(DSH_PLUGIN_ROOT, "dist", "index.js");
	const source = newestMtime(join(DSH_PLUGIN_ROOT, "src"));
	if (existsSync(distEntry) && statSync(distEntry).mtimeMs >= source) return;
	// The package's build script hard-codes `--outdir dist`, so staging into a
	// sibling directory is not an option here. Retire the previous bundle first
	// and rebuild `dist` from scratch; a failed build restores the old bundle,
	// so a boot racing a rebuild sees either the complete old bundle or the
	// complete new one.
	const live = join(DSH_PLUGIN_ROOT, "dist");
	const retiring = join(DSH_PLUGIN_ROOT, "dist.prev");
	rmSync(retiring, { recursive: true, force: true });
	if (existsSync(live)) renameSync(live, retiring);
	const build = spawnSync("bun", ["run", "build"], {
		cwd: DSH_PLUGIN_ROOT,
		encoding: "utf8",
		timeout: 180_000,
		// Bun's bundler inlines `process.env.NODE_ENV`; `bun test` sets it to
		// "test", and freezing that into the bundle would send every live
		// child down the plugin's test backstop.
		env: { ...process.env, NODE_ENV: "production" },
	});
	if (build.status !== 0 || !existsSync(distEntry)) {
		if (!existsSync(live) && existsSync(retiring)) renameSync(retiring, live);
		throw new Error(
			`dsh-magic-context build failed: ${build.stderr || build.stdout}`,
		);
	}
	rmSync(retiring, { recursive: true, force: true });
}

/** Seed a throwaway home whose profile loads this checkout's MC bundle. */
export function createDshIsolatedEnv(
	options: DshProfileOptions & { profile?: string; sharedDataDir?: string } = {
		mockBaseURL: "http://127.0.0.1:0/v1",
		models: [],
		defaultModel: "mock-model",
	},
): DshIsolatedEnv {
	const baseDir = createE2ETempDir("dsh-e2e-");
	const home = join(baseDir, "home");
	const profile = options.profile ?? "e2e";
	const profileDir = join(home, "profiles", profile);
	const configDir = join(baseDir, "config");
	const dataDir = options.sharedDataDir ?? join(baseDir, "data");
	const cacheDir = join(baseDir, "cache");
	const workdir = join(baseDir, "work");
	for (const dir of [home, profileDir, configDir, dataDir, cacheDir, workdir]) {
		mkdirSync(dir, { recursive: true });
	}

	ensureDshPluginBuilt();
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
			env: dshChildEnv(
				{
					baseDir,
					home,
					profile,
					profileDir,
					configDir,
					dataDir,
					cacheDir,
					workdir,
				},
				{ DSH_NO_TELEMETRY: "1" },
			),
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
				dependencies: {
					"@cortexkit/dsh-magic-context": `link:${DSH_PLUGIN_ROOT}`,
				},
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
	symlinkSync(DSH_PLUGIN_ROOT, join(moduleDir, "dsh-magic-context"), "dir");

	const providerId = options.providerId ?? "mock";
	assertMockEndpoint(options.mockBaseURL, options.mockBaseURL);
	const rows: Record<string, unknown>[] = [
		{
			id: "llm-pi-ai",
			name: "@deepseek-ai/dsh-llm-pi-ai",
			config: {
				providers: {
					[providerId]: {
						displayName: providerId,
						apiKeyEnv: DSH_MOCK_API_KEY_ENV,
						api: "openai-completions",
						baseURL: options.mockBaseURL,
						models: options.models.map((model) => ({
							id: model.id,
							name: model.id,
							input: ["text"],
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
		},
		{
			id: "agent-default-model",
			name: "@deepseek-ai/dsh-agent-default-model",
			config: { provider: providerId, model: options.defaultModel },
		},
		// The MC bundle's own patch already disables `compaction-basic`; the
		// profile states it too so the single-engine fact survives any change
		// to the bundle's patch.
		{ id: "compaction-basic", disabled: true },
		...(options.patch ?? []),
	];
	writeFileSync(
		join(profileDir, "cordis.patch.yml"),
		`${JSON.stringify(rows, null, 2)}\n`,
	);

	writeDshMagicContextConfig(configDir, options.magicContextConfig ?? {});
	return {
		baseDir,
		home,
		profile,
		profileDir,
		configDir,
		dataDir,
		cacheDir,
		workdir,
	};
}

/** The shared user-level Magic Context settings the DSH plugin loads. */
export function writeDshMagicContextConfig(
	configDir: string,
	overrides: Record<string, unknown>,
): void {
	const magicContext = {
		$schema:
			"https://raw.githubusercontent.com/cortexkit/opencode-magic-context/master/assets/magic-context.schema.json",
		enabled: true,
		execute_threshold_percentage: 40,
		history_budget_percentage: 0.15,
		memory: {
			enabled: true,
			auto_promote: false,
			auto_search: { enabled: false },
			git_commit_indexing: { enabled: false },
		},
		embedding: { provider: "off" },
		dreamer: { disable: true },
		...overrides,
	};
	const userConfigDir = join(configDir, "cortexkit");
	mkdirSync(userConfigDir, { recursive: true });
	writeFileSync(
		join(userConfigDir, "magic-context.jsonc"),
		JSON.stringify(magicContext, null, 2),
	);
}

/** Child environment: isolated home, production mode, no inherited store pin. */
export function dshChildEnv(
	env: DshIsolatedEnv,
	extra: Record<string, string> = {},
): Record<string, string> {
	const result: Record<string, string | undefined> = { ...process.env };
	// A live lane is production: `bun test` sets NODE_ENV=test for the parent
	// and the child would inherit it and redirect the store to the backstop.
	delete result.NODE_ENV;
	// The e2e preload pins the store for the PARENT; an inherited pin would
	// silently override this home's XDG_DATA_HOME.
	delete result.MAGIC_CONTEXT_STORAGE_DIR;
	delete result.MAGIC_CONTEXT_TEST_DATA_DIR;
	result.DSH_HOME = env.home;
	result.XDG_CONFIG_HOME = env.configDir;
	result.XDG_DATA_HOME = env.dataDir;
	result.XDG_CACHE_HOME = env.cacheDir;
	result.XDG_STATE_HOME = join(env.dataDir, "state");
	result.XDG_RUNTIME_DIR = join(env.baseDir, "runtime");
	result[DSH_MOCK_API_KEY_ENV] = DSH_MOCK_API_KEY;
	for (const dir of [result.XDG_STATE_HOME, result.XDG_RUNTIME_DIR])
		mkdirSync(dir, { recursive: true });
	return { ...(result as Record<string, string>), ...extra };
}

function turnArgs(
	profile: string,
	prompt: string,
	options: DshTurnOptions,
): string[] {
	const args = ["--profile", profile, "--json", ...(options.args ?? [])];
	if (options.sessionId) args.push("--session-id", options.sessionId);
	args.push(prompt);
	return args;
}

/** Parse the NDJSON projection headless `--json` writes to stdout. */
export function parseDshEvents(stdout: string): Array<Record<string, unknown>> {
	return stdout
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
}

/** Session id a completed turn used: the closing `final` event, else the opening `session`. */
export function dshTurnSessionId(
	events: ReadonlyArray<Record<string, unknown>>,
): string | null {
	for (const event of [...events].reverse()) {
		if (event["type"] === "final" && typeof event["sessionId"] === "string") {
			return event["sessionId"];
		}
	}
	for (const event of events) {
		if (event["type"] === "session" && typeof event["sessionId"] === "string") {
			return event["sessionId"];
		}
	}
	return null;
}

/** One headless turn: boot DSH, run the task, exit. Awaited (in-process mock). */
export async function runDshTurn(
	env: DshIsolatedEnv,
	prompt: string,
	options: DshTurnOptions = {},
): Promise<DshTurnResult> {
	const child = spawn(DSH_BIN, turnArgs(env.profile, prompt, options), {
		env: dshChildEnv(env, options.env),
		cwd: env.workdir,
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const timeoutMs =
		options.timeoutMs ?? Number(process.env.MC_DSH_TURN_TIMEOUT_MS ?? 180_000);
	const outcome = await new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((done) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", () => {
			clearTimeout(timer);
			done({ code: null, signal: null });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			done({ code, signal });
		});
	});
	const events = parseDshEvents(stdout);
	return {
		sessionId: dshTurnSessionId(events),
		events,
		stdout,
		stderr,
		exitCode: outcome.code,
		signalCode: outcome.signal,
	};
}

/** Locate one session's durable log by walking `<home>/sessions/…/<sessionId>/. */
export function findDshSessionLog(
	env: DshIsolatedEnv,
	sessionId: string,
): string | null {
	const root = join(env.home, "sessions");
	let slugs: string[];
	try {
		slugs = readdirSync(root);
	} catch {
		return null;
	}
	for (const slug of slugs) {
		const sessionDir = join(root, slug, sessionId);
		for (const name of LOG_FILE_NAMES) {
			const path = join(sessionDir, name);
			if (existsSync(path)) return path;
		}
	}
	return null;
}

/** Decode a session's zstd JSONL event log (v4 layout). */
export function readDshSessionLog(
	env: DshIsolatedEnv,
	sessionId: string,
): Array<Record<string, unknown>> {
	const path = findDshSessionLog(env, sessionId);
	if (!path)
		throw new Error(
			`no DSH session log for ${sessionId} under ${join(env.home, "sessions")}`,
		);
	const decoded = Bun.zstdDecompressSync(readFileSync(path)).toString("utf8");
	return decoded
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
}

export function cleanupDshIsolatedEnv(env: DshIsolatedEnv): void {
	cleanupE2ETempDir(env.baseDir);
}
