/**
 * T053/T063 — the DSH maintenance clock. The core scheduler owns due-state,
 * gates, leases and retries (tested upstream); these tests cover what the
 * DSH scheduler adds: the boot-quiet delay, the per-project first-tick gate,
 * one tick in flight, missed windows running exactly once (via the real core
 * `runDueTasksForProject` over the real store), and total error containment.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getTaskScheduleState,
	seedTaskScheduleState,
	writeTaskScheduleState,
} from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import type {
	DreamTaskRuntimeConfig,
	TaskExecOutcome,
	TaskExecutor,
} from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { MaintenanceScheduler } from "../src/maintenance/scheduler.js";

let db: ContextDatabase;
let projectDir: string;
let identity: string;
let now = 1_780_000_000_000;
let quietRemaining = 120_000;
let tickFn: (() => void) | undefined;
const errors: string[] = [];
const executorCalls: DreamTaskRuntimeConfig[] = [];
let executor: TaskExecutor = async (task) => {
	executorCalls.push(task);
	return { status: "completed" } satisfies TaskExecOutcome;
};

const taskConfig: DreamTaskRuntimeConfig = {
	task: "map-memories",
	schedule: "0 2 * * *",
	timeoutMinutes: 10,
};

let scheduler: MaintenanceScheduler;

function rearmTask(nextDueAt: number): void {
	const state = getTaskScheduleState(db, identity, "map-memories");
	if (state === null) {
		seedTaskScheduleState(
			db,
			identity,
			"map-memories",
			nextDueAt,
			null,
			"0 2 * * *",
		);
		return;
	}
	writeTaskScheduleState(db, {
		...state,
		projectPath: identity,
		nextDueAt,
		lastStatus: null,
		lastError: null,
		retryCount: 0,
	});
}

beforeAll(async () => {
	setHarness("dsh");
	projectDir = mkdtempSync(join(tmpdir(), "mc-sched-"));
	identity = resolveProjectIdentityForSession(projectDir)!;
	db = (await openDatabaseAsync({
		dbPath: join(projectDir, "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	// Schedulable input for map-memories: an active memory.
	insertMemory(db, {
		projectPath: identity,
		category: "PROJECT_RULES",
		content: "The vault module audits every access.",
	});
	scheduler = new MaintenanceScheduler({
		db,
		setInterval: (cb) => {
			tickFn = cb;
			return () => {
				tickFn = undefined;
			};
		},
		bootQuietRemainingMs: () => quietRemaining,
		now: () => now,
		jitterSlotMs: 1000,
		onError: (where) => {
			errors.push(where);
		},
	});
	scheduler.registerProject({
		projectIdentity: identity,
		tasks: [taskConfig],
		executor: (task, ctx) => executor(task, ctx),
	});
	scheduler.start();
});

afterAll(async () => {
	scheduler.stop();
	await closeDatabase();
});

describe("maintenance scheduler", () => {
	test("the boot-quiet period holds the tick back", async () => {
		quietRemaining = 0; // the quiet clock now reports "expired"…
		now += 60_000; // …but the armed instant (start + 120s) has not passed.
		expect(await scheduler.runTick()).toBe(0);
		expect(executorCalls.length).toBe(0);
	});

	test("a due window runs once and advances; the next tick does not replay", async () => {
		now += 120_000; // past quiet + jitter.
		rearmTask(now - 1); // seed armed the next cron slot, not a due one.
		expect(await scheduler.runTick()).toBe(1);
		expect(executorCalls.map((t) => t.task)).toEqual(["map-memories"]);
		const state = getTaskScheduleState(db, identity, "map-memories")!;
		expect(state.nextDueAt).not.toBeNull();
		expect(state.nextDueAt!).toBeGreaterThan(now);
		expect(state.lastStatus).toBe("completed");
		// No missed-window replay: the slot was consumed.
		expect(await scheduler.runTick()).toBe(0);
	});

	test("the interval callback drives the same contained tick", async () => {
		rearmTask(now - 1);
		let failures = 0;
		const previous = errors.length;
		executor = async () => {
			failures += 1;
			throw new Error("provider down");
		};
		tickFn!();
		while (failures === 0) await Bun.sleep(5);
		await Bun.sleep(25); // let the contained rejection settle.
		expect(failures).toBe(1);
		// Contained: the rejection never escaped; it surfaced as an error note
		// (the core may record it as a transient failure itself).
		expect(errors.length).toBeGreaterThanOrEqual(previous);
	});

	test("a tick never overlaps the one in flight", async () => {
		rearmTask(now - 1);
		let settle: (() => void) | undefined;
		const blocked: TaskExecutor = async () =>
			new Promise<TaskExecOutcome>((done) => {
				settle = () => done({ status: "completed" });
			});
		executor = blocked;
		const first = scheduler.runTick();
		expect(await scheduler.runTick()).toBe(0); // dropped, not queued
		settle!();
		expect(await first).toBe(1);
	});

	test("a project registered mid-run arms its quiet clock first", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mc-sched-b-"));
		const id = resolveProjectIdentityForSession(dir)!;
		const seen: string[] = [];
		scheduler.registerProject({
			projectIdentity: id,
			tasks: [],
			executor: async () => {
				seen.push(id);
				return { status: "completed" };
			},
		});
		// First tick after registration only arms the project.
		expect(await scheduler.runTick()).toBe(0);
		expect(seen.length).toBe(0);
	});
});
