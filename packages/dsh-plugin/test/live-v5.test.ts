/**
 * V5 live gate (T066 / quickstart US3): background maintenance runs for real.
 *
 * A headless child with a configured dreamer model mounts the maintenance
 * mount (boot quiet and the tick cadence shortened through the documented
 * test seam). The parent seeds one active memory, waits for the child's
 * scheduler to seed the task schedule, re-arms `classify-memories` into the
 * past, and watches the scheduled run happen end to end: the dream model is
 * honoured, the classification lands on the memory row, the schedule
 * advances, and a run record documents the outcome. Evidence — schedule
 * state, run rows, memory row, the dream request — is written to
 * tmp/gate-evidence/v5-maintenance/ for the sidecar.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getTaskScheduleState,
	writeTaskScheduleState,
} from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { createLiveHome, type LiveHome } from "./live-home.js";
import {
	MOCK_API_KEY_ENV,
	mockProviderEnv,
	startMockProvider,
} from "./mock-provider.js";

const provider = startMockProvider();
let home: LiveHome | undefined;
let db: ContextDatabase;
let projectDir: string;
let identity: string;
let memoryId: number;
let evidenceDir: string;

const DREAM_SCHEDULE = "* * * * *";

beforeAll(async () => {
	setHarness("dsh");
	evidenceDir = `${import.meta.dir}/../tmp/gate-evidence/v5-maintenance`;
	mkdirSync(evidenceDir, { recursive: true });
	const homeRoot = `${import.meta.dir}/../tmp/live-v5`;
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
	projectDir = mkdtempSync(join(tmpdir(), "mc-v5-proj-"));
	writeFileSync(join(projectDir, "file.txt"), "project facts\n");
	mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
	writeFileSync(
		join(projectDir, ".cortexkit", "magic-context.jsonc"),
		JSON.stringify({
			dreamer: {
				pi: { model: "mock/mock-dream" },
				tasks: { "classify-memories": { schedule: DREAM_SCHEDULE } },
			},
		}),
	);
	identity = resolveProjectIdentityForSession(projectDir)!;
	const memory = insertMemory(db, {
		projectPath: identity,
		category: "PROJECT_RULES",
		content:
			"The nightly build script must run with the archive flag, or vault exports are silently truncated.",
	});
	memoryId = Number(memory.id);
	// classify-memories needs a pool of at least ten to score meaningfully.
	for (let i = 0; i < 11; i += 1)
		insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content: `Project fact ${String(i)}: the archive layout numbers shard ${String(i)} and binds it to the nightly export ledger under a rotating retention window.`,
		});
});

afterAll(async () => {
	home?.dispose();
	provider.stop();
	await closeDatabase();
});

describe("V5 live", () => {
	test("a scheduled dreamer task runs in-window and its effect is observable", async () => {
		let turnReplies = 0;
		provider.respond((request) => {
			const body = request as Record<string, unknown>;
			if (body["model"] === "mock-dream") {
				const entries = Array.from(
					{ length: 12 },
					(_, i) =>
						`<memory id="${String(i + 1)}" importance="70" scope="project" shareable="true"/>`,
				).join("");
				return { text: `<classify>${entries}</classify>` };
			}
			turnReplies += 1;
			if (turnReplies === 1)
				return {
					toolCalls: [
						{
							name: "read",
							arguments: JSON.stringify({
								path: join(projectDir, "file.txt"),
							}),
						},
					],
				};
			// Keep the turn open while the background dream runs alongside it.
			return { text: "noted", delayMs: 6_000 };
		});

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

		// 1. The mount seeds the task schedule (schedulable input exists).
		const seededAt = Date.now();
		let state = getTaskScheduleState(db, identity, "classify-memories");
		while (state === null && Date.now() - seededAt < 20_000) {
			await Bun.sleep(100);
			state = getTaskScheduleState(db, identity, "classify-memories");
		}
		expect(state, "the scheduler seeded the task schedule").not.toBeNull();

		// 2. Re-arm the task into the past; the 500ms tick must pick it up.
		const row = state as NonNullable<typeof state>;
		writeTaskScheduleState(db, {
			...row,
			nextDueAt: Date.now() - 1_000,
		});
		const dreamAt = Date.now();
		const dreamRequest = () =>
			provider.requests.find(
				(request) => request.body["model"] === "mock-dream",
			);
		while (dreamRequest() === undefined && Date.now() - dreamAt < 20_000)
			await Bun.sleep(100);
		expect(dreamRequest(), "the dream model was asked").toBeDefined();
		expect(dreamRequest()!.body["model"]).toBe("mock-dream");

		// 3. The effect: the classification landed on the memory row.
		const importanceAt = Date.now();
		let importance = 0;
		while (importance !== 70 && Date.now() - importanceAt < 20_000) {
			await Bun.sleep(100);
			importance = Number(
				(
					db
						.prepare("SELECT importance FROM memories WHERE id = ?")
						.get(memoryId) as { importance: number } | null
				)?.importance ?? 0,
			);
		}
		expect(importance).toBe(70);

		const result = await running;
		expect(result.status, `child failed: ${result.stderr.slice(0, 800)}`).toBe(
			0,
		);
		expect(result.stderr).not.toContain("TEST BACKSTOP");

		// 4. Cadence + record: schedule advanced, a dream run was recorded.
		const advanced = getTaskScheduleState(db, identity, "classify-memories")!;
		expect(advanced.lastRunAt).not.toBeNull();
		expect(advanced.nextDueAt).toBeGreaterThan(Date.now() - 60_000);
		const runs = db
			.prepare(
				"SELECT tasks_json, tasks_succeeded, tasks_failed FROM dream_runs ORDER BY rowid DESC LIMIT 5",
			)
			.all() as {
			tasks_json: string;
			tasks_succeeded: number;
			tasks_failed: number;
		}[];
		expect(
			runs.some(
				(row) =>
					row.tasks_json.includes("classify-memories") &&
					row.tasks_succeeded >= 1,
			),
			`dream_runs: ${JSON.stringify(runs)}`,
		).toBe(true);

		writeFileSync(
			join(evidenceDir, "v5-evidence.json"),
			`${JSON.stringify(
				{
					scheduleState: advanced,
					runs,
					memory: db
						.prepare("SELECT id, importance FROM memories WHERE id = ?")
						.get(memoryId),
					dreamModel: dreamRequest()!.body["model"],
					dreamSystemHead: String(dreamRequest()!.body["system"] ?? "").slice(
						0,
						400,
					),
					turnRequests: provider.requests.length,
				},
				null,
				2,
			)}\n`,
		);
	}, 120_000);
});
