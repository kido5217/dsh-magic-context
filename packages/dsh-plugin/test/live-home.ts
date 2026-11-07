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
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
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
	dispose(): void;
}

function dshEnv(
	home: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	return { ...process.env, DSH_HOME: home, ...extra } as Record<string, string>;
}

/** Seed a throwaway `headless` profile that loads this package as a bundle. */
export function createLiveHome(options: LiveHomeOptions = {}): LiveHome {
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
			const args = ["--profile", profile, "--json", ...(runOptions.args ?? [])];
			if (runOptions.sessionId) args.push("--session-id", runOptions.sessionId);
			args.push(prompt);
			const result = spawnSync(DSH_BIN, args, {
				env: dshEnv(home, runOptions.env),
				encoding: "utf8",
				timeout: Number(process.env.MC_DSH_TURN_TIMEOUT_MS ?? 300_000),
			});
			const events = (result.stdout ?? "")
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
				status: result.status,
				signal: result.signal,
				events,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? "",
			};
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
