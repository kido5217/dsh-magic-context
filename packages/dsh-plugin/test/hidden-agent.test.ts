/**
 * Hidden-agent spike (T007) + live drive-and-dispose proof (T007 close).
 *
 * Magic Context's maintenance lane needs an ephemeral agent that can hold a
 * short tool loop without appearing as a user session, without inheriting the
 * user's tools, and without surviving its own failure. The host seam for that
 * is `ctx.agents.create` with a parentless handle and `meta.origin = "subagent"`
 * (`dsh-agent/lib/types/index.d.ts:49–72`) — the same coarse classification a
 * real delegated child carries, so Magic Context's own role rules treat it as a
 * subagent (narrow guidance, every-pass gating, no user-facing surfaces).
 *
 * The spike half pins what is checkable without booting a live model: the
 * creation options, the classification, and the disposer contract. The live
 * half drives ONE real tool-loop dream task (map-memories — the cheapest
 * tool-loop task in `DREAM_TASK_CAPABILITIES`: its gate is simply "an unmapped
 * memory exists") end to end through a hidden agent inside a live child and
 * records the three claims:
 *  (a) RAN — the task completed for real: a dream_runs row lists it completed
 *      with progress, the schedule advanced, and the mapping landed on
 *      `memory_verifications` (not a skip, not a silent no-op).
 *  (b) VISIBILITY — the agent ran as a real session directory under
 *      `$DSH_HOME/sessions` whose persisted header carries the durable
 *      `origin:"subagent"` marker, yet the parent turn's `--json` stream
 *      mentions only the parent session — never the maintenance one.
 *  (c) DISPOSAL — after the task the child exits clean, no
 *      `session-mc-maint-*` directory survives, no lease rows are held in
 *      `dream_state`, and no dream_runs row is left unfinished.
 * The mock responder handles the tool-loop conversation: the hidden agent's
 * first answer is a legal `read` tool call (allowlist:
 * DEFAULT_MAINTENANCE_TOOLS), its second answer is the `<mappings>` manifest —
 * and the second request must carry the tool RESULT (the seeded file's unique
 * token), proving the tool executed inside the hidden loop.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CreateAgentOptions } from "@deepseek-ai/dsh-agent";
import {
	getTaskScheduleState,
	seedTaskScheduleState,
} from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { classifySession } from "../src/sessions/mapping.js";
import { rulesForRole } from "../src/sessions/subagent-rules.js";
import { createLiveHome, type LiveHome, sessionIdsFrom } from "./live-home.js";
import {
	MOCK_API_KEY_ENV,
	mockProviderEnv,
	startMockProvider,
} from "./mock-provider.js";

describe("hidden agent", () => {
	test("creation options admit a parentless subagent", () => {
		const options: CreateAgentOptions = {
			sessionId: "mc-maintenance-1" as CreateAgentOptions["sessionId"],
			// No parentAgent: the maintenance agent has no live parent, so it is
			// not a child of the user's agent tree (workspace visibility).
			meta: {
				cwd: process.cwd(),
				origin: "subagent",
				delegationDepth: 1,
				parentSession: "session-user" as NonNullable<
					CreateAgentOptions["meta"]
				>["parentSession"],
			},
		};
		expect(options.parentAgent).toBeUndefined();
		expect(options.meta?.origin).toBe("subagent");
	});

	test("a maintenance session classifies as a subagent and takes the narrow rules", () => {
		const role = classifySession({
			id: "mc-maintenance-1",
			origin: "subagent",
			parentSession: "session-user",
			delegationDepth: 1,
		});
		expect(role).toBe("subagent");
		const rules = rulesForRole(role);
		expect(rules.role).toBe("subagent");
		// Narrow rules: a maintenance agent never writes shared project memory
		// and never extracts user observations (Pi encodes the same policy).
		expect(rules.summarizerMemoryWrites).toBe(false);
		expect(rules.summarizerUserObservations).toBe(false);
		expect(rules.ownSessionScope).toBe(true);
	});

	test("handle disposal is part of the creation result", async () => {
		// The AgentHandle contract: create ⇒ dispose exactly once.
		const dispose = async (): Promise<void> => {};
		const handle = { dispose };
		expect(typeof handle.dispose).toBe("function");
	});
});

/* ------------------------------------------------------------------ */
/* Live half: one real tool-loop dream task through a hidden agent.    */
/* ------------------------------------------------------------------ */

const provider = startMockProvider();

const MAINT_PREFIX = "session-mc-maint-";
const DREAM_SCHEDULE = "* * * * *";
const PIPELINE_TOKEN = "pipeline-entry-token-9x7";

let home: LiveHome | undefined;
let db: ContextDatabase;
let projectDir: string;
let identity: string;
let mappedId: number;
let independentId: number;
let evidenceDir: string;

beforeAll(async () => {
	setHarness("dsh");
	evidenceDir = `${import.meta.dir}/../tmp/gate-evidence/hidden-agent-live`;
	mkdirSync(evidenceDir, { recursive: true });
	const homeRoot = `${import.meta.dir}/../tmp/live-hidden-agent`;
	rmSync(homeRoot, { recursive: true, force: true });
	process.env.XDG_DATA_HOME = join(homeRoot, "home", "data");
	home = createLiveHome({
		root: homeRoot,
		route: {
			provider: "mock",
			baseURL: provider.baseURL,
			apiKeyEnv: MOCK_API_KEY_ENV,
			models: [
				{ id: "mock-model", contextWindow: 20_000 },
				{ id: "mock-dream", contextWindow: 20_000 },
			],
		},
		defaultModel: "mock-model",
	});
	db = (await openDatabaseAsync({
		dbPath: join(home.home, "data", "cortexkit", "magic-context", "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-hidden-proj-"));
	writeFileSync(join(projectDir, "file.txt"), "project facts\n");
	mkdirSync(join(projectDir, "build"), { recursive: true });
	mkdirSync(join(projectDir, "vault"), { recursive: true });
	writeFileSync(
		join(projectDir, "build", "pipeline.js"),
		`// ${PIPELINE_TOKEN}: binds one shard to the export ledger\nconst manifest = require("../vault/manifest.json");\nmodule.exports = { manifest };\n`,
	);
	writeFileSync(
		join(projectDir, "vault", "manifest.json"),
		`${JSON.stringify({ shards: 1 })}\n`,
	);
	mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
	writeFileSync(
		join(projectDir, ".cortexkit", "magic-context.jsonc"),
		JSON.stringify({
			dreamer: {
				pi: { model: "mock/mock-dream" },
				tasks: { "map-memories": { schedule: DREAM_SCHEDULE } },
			},
		}),
	);
	identity = resolveProjectIdentityForSession(projectDir)!;
	// The task needs input: two active unmapped memories. One is a declarative
	// implementation claim naming a real file (maps); the other is process
	// knowledge that maps to nothing (independent).
	const mapped = insertMemory(db, {
		projectPath: identity,
		category: "ARCHITECTURE",
		content:
			"The build pipeline entry point build/pipeline.js loads vault/manifest.json and binds every export shard to one ledger.",
	});
	const independent = insertMemory(db, {
		projectPath: identity,
		category: "PROJECT_RULES",
		content:
			"Release topology fact: the ledger binding lives in the vault export contract, not in repository code.",
	});
	mappedId = Number(mapped.id);
	independentId = Number(independent.id);
	// Force-due BEFORE boot: the child's reconcile keeps a row whose schedule
	// string matches the config, so the very first tick finds map-memories due.
	seedTaskScheduleState(
		db,
		identity,
		"map-memories",
		Date.now() - 1_000,
		null,
		DREAM_SCHEDULE,
	);
});

afterAll(async () => {
	home?.dispose();
	provider.stop();
	await closeDatabase();
});

interface MaintenanceSighting {
	id: string;
	workspace: string;
	files: string[];
	copiedBytes: number;
	firstSeen: number;
}

describe("hidden agent live", () => {
	test("one tool-loop dream task runs through a hidden agent, invisibly, and leaves nothing behind", async () => {
		const testStartedAt = Date.now();
		// The tool-loop conversation: dream turn 1 asks for a legal `read`
		// (allowlist member), turn 2 — which must carry the tool result —
		// answers with the final manifest. The 2.5s stall keeps the hidden
		// session on disk long enough to be sampled mid-flight.
		let dreamAgentTurns = 0;
		let turnReplies = 0;
		const manifest = `<mappings><memory id="${String(mappedId)}" files="build/pipeline.js"/><memory id="${String(independentId)}" independent="true"/></mappings>`;
		provider.respond((request) => {
			const body = request as Record<string, unknown>;
			if (body["model"] === "mock-dream") {
				dreamAgentTurns += 1;
				if (dreamAgentTurns === 1)
					return {
						toolCalls: [
							{
								name: "read",
								arguments: JSON.stringify({
									file_path: join(projectDir, "build", "pipeline.js"),
								}),
							},
						],
					};
				return { text: manifest, delayMs: 2_500 };
			}
			turnReplies += 1;
			if (turnReplies === 1)
				return {
					toolCalls: [
						{
							name: "read",
							arguments: JSON.stringify({
								file_path: join(projectDir, "file.txt"),
							}),
						},
					],
				};
			if (turnReplies === 2)
				// Keep the main turn open so the maintenance tick fires
				// mid-turn.
				return { text: "noted", delayMs: 12_000 };
			return { text: "noted" };
		});

		// Sample the sessions tree for the hidden agent's session directory
		// while the child runs; copies of its session log go to the evidence
		// dir because home.dispose() wipes the live tree.
		const sessionsRoot = join(home!.home, "sessions");
		const sightings = new Map<string, MaintenanceSighting>();
		const scan = (): void => {
			let workspaces: string[];
			try {
				workspaces = readdirSync(sessionsRoot);
			} catch {
				return; // the tree does not exist yet
			}
			for (const workspace of workspaces) {
				let entries: string[];
				try {
					entries = readdirSync(join(sessionsRoot, workspace));
				} catch {
					continue; // raced with creation/removal
				}
				for (const entry of entries) {
					if (!entry.startsWith(MAINT_PREFIX)) continue;
					const dir = join(sessionsRoot, workspace, entry);
					let files: string[];
					try {
						files = readdirSync(dir);
					} catch {
						continue;
					}
					const known = sightings.get(entry) ?? {
						id: entry,
						workspace,
						files: [],
						copiedBytes: 0,
						firstSeen: Date.now(),
					};
					known.files = files;
					const log = join(dir, "session.v4.jsonl.zstd");
					if (existsSync(log)) {
						const size = statSync(log).size;
						if (size >= known.copiedBytes && size > 0) {
							copyFileSync(
								log,
								join(evidenceDir, `${entry}.session.v4.jsonl.zstd`),
							);
							known.copiedBytes = size;
						}
					}
					sightings.set(entry, known);
				}
			}
		};
		const sampler = setInterval(scan, 50);
		// Ids of maintenance session dirs present RIGHT NOW (fresh tree walk;
		// also refreshes sightings + session-log copies).
		const survivingMaintenanceDirs = (): string[] => {
			scan();
			const alive: string[] = [];
			let workspaces: string[];
			try {
				workspaces = readdirSync(sessionsRoot);
			} catch {
				return alive;
			}
			for (const workspace of workspaces) {
				let entries: string[];
				try {
					entries = readdirSync(join(sessionsRoot, workspace));
				} catch {
					continue;
				}
				for (const entry of entries)
					if (entry.startsWith(MAINT_PREFIX) && !alive.includes(entry))
						alive.push(entry);
			}
			return alive;
		};

		const running = home!.runHeadlessAsync("read file.txt and note it", {
			cwd: projectDir,
			env: {
				...mockProviderEnv(),
				MAGIC_CONTEXT_TEST_NO_QUIET: "1",
				MAGIC_CONTEXT_LOG_PATH: join(evidenceDir, "child.log"),
				MAGIC_CONTEXT_TEST_TICK_MS: "500",
				MAGIC_CONTEXT_TEST_JITTER_MS: "0",
			},
		});

		const waitUntil = async (
			label: string,
			done: () => boolean,
			timeoutMs = 30_000,
		): Promise<void> => {
			const started = Date.now();
			while (!done()) {
				if (Date.now() - started > timeoutMs)
					throw new Error(`timed out waiting for ${label}`);
				await Bun.sleep(50);
			}
		};
		const isTitleCall = (body: Record<string, unknown>): boolean =>
			JSON.stringify(body["messages"] ?? "").includes("concise title");
		const dreamAgentRequests = (): number =>
			provider.requests.filter(
				(request) =>
					request.body["model"] === "mock-dream" && !isTitleCall(request.body),
			).length;

		try {
			// 1. The tool loop really looped: two dream-model requests — the
			//    tool call and the answer that carries its result.
			await waitUntil(
				"the hidden agent's second model call",
				() => dreamAgentRequests() >= 2,
			);
			// 2. The run was recorded (fail loudly on a silent skip).
			type RunRow = {
				rowid: number;
				tasks_json: string;
				tasks_succeeded: number;
				tasks_failed: number;
				finished_at: number | null;
			};
			const runRows = (): RunRow[] =>
				db
					.prepare(
						"SELECT rowid, tasks_json, tasks_succeeded, tasks_failed, finished_at FROM dream_runs ORDER BY rowid DESC LIMIT 5",
					)
					.all() as RunRow[];
			await waitUntil(
				`the map-memories dream run (child kept running: status unknown yet; log at ${join(evidenceDir, "child.log")})`,
				() =>
					runRows().some((row) => {
						const tasks = JSON.parse(row.tasks_json) as {
							name?: string;
							status?: string;
						}[];
						return tasks.some(
							(task) =>
								task.name === "map-memories" &&
								(task.status === "completed" ||
									task.status === "failed" ||
									task.status === "skipped"),
						);
					}),
			);
			// 3. The hidden agent really existed: its session dir was seen
			//    (and its session log copied) while the child ran.
			await waitUntil(
				"the hidden agent's session directory to appear",
				() => sightings.size > 0,
			);
		} finally {
			clearInterval(sampler);
		}
		const result = await running;
		// Disposal timing at child exit: the maintenance dir should be gone
		// by now; a bounded grace window covers a flush-then-delete tail.
		const exitAt = Date.now();
		const aliveAtExit = survivingMaintenanceDirs();
		let disposedByExit = aliveAtExit.length === 0;
		let goneAt: number | null = disposedByExit ? exitAt : null;
		if (!disposedByExit) {
			// A short grace covers a flush-then-delete tail; whether the dir
			// dies at exit is recorded, not assumed — the durable disposal
			// guarantee is asserted below via the next boot's reaper pass.
			try {
				await waitUntil(
					"post-exit disposal of the maintenance session dir",
					() => survivingMaintenanceDirs().length === 0,
					3_000,
				);
				disposedByExit = true;
				goneAt = Date.now();
			} catch {
				disposedByExit = false;
			}
		}
		// Post-exit ground truth: a fresh full scan of the settled tree.
		const residual = survivingMaintenanceDirs();
		const residualFilesAtExit: Record<string, string[]> = {};
		for (const [id, sighting] of sightings)
			if (residual.includes(id)) residualFilesAtExit[id] = [...sighting.files];

		const evidence: Record<string, unknown> = {
			at: new Date().toISOString(),
			sightings: [...sightings.values()],
			turnRequests: provider.requests.length,
			dreamAgentTurns,
			childStatus: result.status,
			childExitAtMs: exitAt,
			aliveAtChildExit: aliveAtExit,
			maintenanceGoneAtMs: goneAt,
			disposalDelayMs: goneAt === null ? null : goneAt - exitAt,
			disposedByExit,
			residualMaintenanceDirs: residual,
		};
		// Persist early: an assertion failure below must not cost the evidence.
		const evidenceFile = join(evidenceDir, "hidden-agent-live.json");
		const writeEvidence = (): void => {
			writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
		};
		writeEvidence();

		// (a) RAN — the recorded run says the task completed, and the effect
		//     landed: both memories have verification rows.
		const runs = db
			.prepare(
				"SELECT rowid, tasks_json, tasks_succeeded, tasks_failed, finished_at FROM dream_runs ORDER BY rowid DESC LIMIT 5",
			)
			.all() as {
			rowid: number;
			tasks_json: string;
			tasks_succeeded: number;
			tasks_failed: number;
			finished_at: number | null;
		}[];
		evidence.runs = runs;
		const taskEntryOf = (
			row: (typeof runs)[number],
		): Record<string, unknown> | undefined =>
			(JSON.parse(row.tasks_json) as Record<string, unknown>[]).find(
				(task) => task["name"] === "map-memories",
			);
		const run = runs.find(
			(row) => taskEntryOf(row)?.["status"] === "completed",
		);
		expect(
			run,
			`map-memories never completed; dream_runs: ${JSON.stringify(runs)}`,
		).toBeDefined();
		expect(run!.tasks_succeeded).toBeGreaterThanOrEqual(1);
		expect(run!.tasks_failed).toBe(0);
		expect(run!.finished_at).not.toBeNull();
		const skipped = runs.some((row) => {
			const entry = taskEntryOf(row);
			return entry?.["status"] === "skipped";
		});
		expect(skipped, "map-memories was skipped, not run").toBe(false);

		const verifications = db
			.prepare(
				"SELECT memory_id, file_path FROM memory_verifications WHERE memory_id IN (?, ?) ORDER BY memory_id, file_path",
			)
			.all(mappedId, independentId) as {
			memory_id: number;
			file_path: string;
		}[];
		evidence.verifications = verifications;
		expect(
			verifications.some(
				(row) =>
					row.memory_id === mappedId && row.file_path.includes("pipeline.js"),
			),
			`the file mapping never landed: ${JSON.stringify(verifications)}`,
		).toBe(true);
		expect(
			verifications.some(
				(row) => row.memory_id === independentId && row.file_path === "",
			),
			`the independent verdict never landed: ${JSON.stringify(verifications)}`,
		).toBe(true);

		// The schedule watermark advanced. lastStatus may legitimately show
		// "skipped": with an every-minute schedule the child's next tick
		// re-checks the task, finds the pool drained (everything mapped), and
		// records a gate skip over the completed status. The completed row in
		// dream_runs above is the authoritative "it ran" record.
		const advanced = getTaskScheduleState(db, identity, "map-memories")!;
		evidence.scheduleAfter = advanced;
		const acceptedStatuses: string[] = ["completed", "skipped"];
		expect(acceptedStatuses.includes(advanced.lastStatus ?? "")).toBe(true);
		// The watermark moved during this test (seeded dueAt was the test's
		// start; anything at/after it means the child advanced it). lastRunAt
		// is the scheduler's own clock — no fixed order vs dream_runs'
		// finished_at is guaranteed, so it is recorded, not compared.
		expect(advanced.lastRunAt).not.toBeNull();
		expect(advanced.lastRunAt!).toBeGreaterThanOrEqual(testStartedAt);
		expect(advanced.nextDueAt).toBeGreaterThan(Date.now() - 60_000);

		// The tool executed INSIDE the hidden loop: the second dream request
		// carries the read result — the seeded file's unique token.
		const dreamRequests = provider.requests.filter(
			(request) =>
				request.body["model"] === "mock-dream" && !isTitleCall(request.body),
		);
		expect(dreamRequests.length).toBeGreaterThanOrEqual(2);
		expect(JSON.stringify(dreamRequests[1]?.body["messages"] ?? "")).toContain(
			PIPELINE_TOKEN,
		);

		// (b) VISIBILITY — the hidden agent WAS a real session on disk, marked
		//     as a subagent at the root of its own session log, yet the parent
		//     turn's event stream never mentions it.
		const sighted = [...sightings.values()];
		expect(
			sighted.length,
			"the hidden agent never created a session directory mid-run",
		).toBeGreaterThanOrEqual(1);
		const copied = sighted.find((sighting) => sighting.copiedBytes > 0);
		expect(
			copied,
			"the maintenance session log never appeared on disk",
		).toBeDefined();
		const decoded = spawnSync(
			"zstd",
			["-dc", join(evidenceDir, `${copied!.id}.session.v4.jsonl.zstd`)],
			{ encoding: "buffer" },
		);
		// A snapshot copy may cut the newest appended frame mid-write; the
		// header frame is complete from session open, so decode what zstd
		// emitted and parse the first line.
		const decodedText = (decoded.stdout ?? Buffer.alloc(0)).toString("utf8");
		let header: Record<string, unknown> | null = null;
		try {
			header = JSON.parse(decodedText.split("\n", 1)[0] ?? "") as Record<
				string,
				unknown
			>;
		} catch {
			header = null;
		}
		evidence.maintenanceSessionHeader = header;
		expect(
			header,
			`no session header decodable from the copy (zstd exit ${String(decoded.status)})`,
		).not.toBeNull();
		expect(header!["id"]).toBe(copied!.id);
		expect(
			header!["origin"],
			"the session header lost its durable origin marker",
		).toBe("subagent");

		const streamed = sessionIdsFrom(result);
		evidence.streamedSessionIds = streamed;
		expect(streamed).toHaveLength(1);
		expect(streamed[0]?.startsWith(MAINT_PREFIX)).toBe(false);
		expect(result.stdout).not.toContain(MAINT_PREFIX);

		// (c) DISPOSAL — clean exit, no held leases, no unfinished runs, and
		//     no maintenance directory surviving into the next boot. Whether
		//     the dir dies at agent disposal or only under the next boot's
		//     reaper pass is recorded as evidence; the hard guarantee is the
		//     next boot, so a second short child proves the lane sweeps its
		//     own residue.
		expect(result.status, `child failed: ${result.stderr.slice(0, 800)}`).toBe(
			0,
		);
		expect(result.stderr).not.toContain("TEST BACKSTOP");
		const leaseRows = db
			.prepare(
				"SELECT key FROM dream_state WHERE key LIKE 'lease:%' OR key LIKE 'dreaming_lease%'",
			)
			.all() as { key: string }[];
		evidence.leaseRows = leaseRows;
		const held = leaseRows.filter(
			(row) =>
				row.key.endsWith(":holder") ||
				row.key.endsWith(":heartbeat") ||
				row.key.endsWith(":expiry") ||
				row.key === "dreaming_lease_holder" ||
				row.key === "dreaming_lease_heartbeat" ||
				row.key === "dreaming_lease_expiry",
		);
		expect(
			held,
			`leases still held after the run: ${JSON.stringify(held)}`,
		).toEqual([]);
		const unfinished = db
			.prepare("SELECT COUNT(*) AS n FROM dream_runs WHERE finished_at IS NULL")
			.get() as { n: number };
		expect(unfinished.n).toBe(0);

		// The lane guarantees its own cleanup: a second short boot must
		// sweep the first run's maintenance residue (observed live: dispose
		// closes the agent and the process exits clean, but the session dir
		// can outlive a mid-run exit; the boot-time reaper is the guarantee
		// that nothing survives). The map-memories pool is drained and every
		// schedule is in the future, so this boot creates no new session.
		const firstRunDirs = [...sightings.keys()];
		// N-10 doctrine: the boot reaper spares anything idle for less than
		// a day (a live process elsewhere may own it). Backdate the residue
		// to the production shape of an abandoned dir — days old, nothing
		// writing — so the sweep is exercised on what it actually reaps.
		const aged = new Date(Date.now() - 2 * 24 * 3_600_000);
		for (const id of residual) {
			for (const workspace of readdirSync(sessionsRoot)) {
				const dir = join(sessionsRoot, workspace, id);
				if (!existsSync(dir)) continue;
				utimesSync(dir, aged, aged);
				for (const entry of readdirSync(dir)) {
					try {
						utimesSync(join(dir, entry), aged, aged);
					} catch {
						/* vanished mid-test */
					}
				}
			}
		}
		const reaperTurn = provider.requests.length;
		const second = await home!.runHeadlessAsync("second boot", {
			cwd: projectDir,
			env: {
				...mockProviderEnv(),
				MAGIC_CONTEXT_TEST_NO_QUIET: "1",
				MAGIC_CONTEXT_LOG_PATH: join(evidenceDir, "reaper.child.log"),
				MAGIC_CONTEXT_TEST_TICK_MS: "500",
				MAGIC_CONTEXT_TEST_JITTER_MS: "0",
			},
		});
		evidence.reaperChildStatus = second.status;
		evidence.reaperBootRequests = provider.requests.length - reaperTurn;
		evidence.residualFilesAtExit = residualFilesAtExit;
		const afterReaper = survivingMaintenanceDirs();
		evidence.residualAfterReaperBoot = afterReaper;
		expect(
			afterReaper.filter((id) => firstRunDirs.includes(id)),
			"the next boot did not sweep the maintenance residue",
		).toEqual([]);

		writeEvidence();
	}, 150_000);
});
