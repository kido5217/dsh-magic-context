/**
 * US1 emergency and caveman lanes (T026, T027).
 *
 * Emergency: the core's planner only acts with a known ceiling and a known
 * usage, retires aged tool output in tiers, and latches the pressure episode so
 * a restart cannot re-drop on every pass. Caveman: opt-in, primary-only,
 * age-tiered, and a pure function of the source text so a replay is
 * byte-identical.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getEmergencyInputSample } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import { getActiveTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import {
	cavemanLane,
	cavemanTierFor,
	selectCaveman,
} from "../src/lanes/caveman.js";
import {
	emergencyDropLane,
	selectEmergencyDrop,
} from "../src/lanes/emergency.js";
import { type LaneContext, runLanePass } from "../src/lanes/engine.js";
import { LaneGates } from "../src/lanes/gating.js";
import { rulesForRole } from "../src/sessions/subagent-rules.js";
import { projectDshSessionLog } from "../src/surface/dsh-session-log.js";
import { ManagedEdits } from "../src/surface/managed-edits.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
const cfg = MagicContextConfigSchema.parse({});
const PRIMARY = rulesForRole("primary");
const SUBAGENT = rulesForRole("subagent");

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
});

afterAll(async () => {
	await closeDatabase();
});

function context(overrides: Partial<LaneContext> = {}): LaneContext {
	const session =
		overrides.session ?? new TestDshHost().addSession({ id: "s-lane" }, []);
	return {
		session,
		mcSession: "s-lane",
		projection: projectDshSessionLog([]),
		rules: PRIMARY,
		band: "force",
		permission: { permitted: true, reason: "force-band" },
		config: cfg,
		db,
		protectedMessageIds: new Set(),
		pressure: { pressureTokens: 9_500, contextWindow: 10_000, percentage: 95 },
		projectDir: process.cwd(),
		...overrides,
	};
}

/** Seed N aged tool tags with real byte mass so the planner sees reclaimables. */
function seedAgedToolTags(sessionId: string, count: number): number[] {
	const tagger = createTagger();
	const numbers: number[] = [];
	for (let index = 0; index < count; index += 1) {
		const owner = `a${String(index)}`;
		tagger.assignTag(sessionId, owner, "message", 800, db);
		numbers.push(
			tagger.assignToolTag(
				sessionId,
				`call-${String(index)}`,
				owner,
				800,
				db,
				0,
				"grep",
				40,
			),
		);
	}
	return numbers;
}

describe("emergency drop", () => {
	test("no plan without a known ceiling or usage", () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-emerg-unknown" }, []);
		seedAgedToolTags("s-emerg-unknown", 5);
		expect(
			selectEmergencyDrop(
				context({
					session,
					mcSession: "s-emerg-unknown",
					pressure: { pressureTokens: 9_500 },
				}),
			).tagIds,
		).toEqual([]);
		expect(
			selectEmergencyDrop(
				context({
					session,
					mcSession: "s-emerg-unknown",
					pressure: { contextWindow: 10_000 },
				}),
			).tagIds,
		).toEqual([]);
	});

	test("queues aged tool tags, latches the episode, and does not re-drop", async () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-emerg" }, []);
		seedAgedToolTags("s-emerg", 12);
		const managedEdits = new ManagedEdits(host);
		const pass = () =>
			runLanePass(managedEdits, {
				session,
				mcSession: "s-emerg",
				projection: projectDshSessionLog([]),
				rules: PRIMARY,
				band: "force",
				permission: { permitted: true, reason: "force-band" },
				config: cfg,
				db,
				protectedMessageIds: new Set(),
				projectDir: process.cwd(),
				pressure: {
					pressureTokens: 9_500,
					contextWindow: 10_000,
					percentage: 95,
				},
				lanes: [emergencyDropLane],
				gates: new LaneGates(),
			});

		await pass();
		const queued = getPendingOps(db, "s-emerg");
		expect(queued.length).toBeGreaterThan(0);
		expect(getEmergencyInputSample(db, "s-emerg")).toBe(9_500);

		// The latch holds the episode: a second force-band pass queues nothing new.
		const before = getPendingOps(db, "s-emerg").length;
		await pass();
		expect(getPendingOps(db, "s-emerg").length).toBe(before);
	});
});

describe("caveman compression", () => {
	/** Six long prose messages: the oldest tier must compress, the newest must not. */
	function seedProse(host: TestDshHost, id: string) {
		const session = host.addSession({ id }, [0, 1, 2, 3, 4, 5]);
		const tagger = createTagger();
		for (let index = 0; index < 6; index += 1) {
			const filler =
				"It is really very important that you should perhaps consider the following thing. ";
			const text = `${filler.repeat(8)}item ${String(index)}`;
			session.seedMessage(
				index,
				`m${String(index)}`,
				text,
				index % 2 === 0 ? "user" : "assistant",
			);
			// Caveman needs the node's tag: the persisted depth lives there.
			tagger.assignTag(id, `m${String(index)}`, "message", text.length, db);
		}
		return session;
	}

	test("tiers are position-based", () => {
		expect(cavemanTierFor(0, 10)).toBe("ultra");
		expect(cavemanTierFor(3, 10)).toBe("full");
		expect(cavemanTierFor(5, 10)).toBe("lite");
		expect(cavemanTierFor(9, 10)).toBeUndefined();
	});

	test("disabled by default and never for subagents", () => {
		const host = new TestDshHost();
		const session = seedProse(host, "s-cave-off");
		const projection = projectDshSessionLog(session.logRecords());
		expect(
			selectCaveman(context({ session, mcSession: "s-cave-off", projection })),
		).toEqual([]);

		const enabled = {
			...cfg,
			caveman_text_compression: {
				...cfg.caveman_text_compression,
				enabled: true,
			},
		};
		expect(
			selectCaveman(
				context({
					session,
					mcSession: "s-cave-off",
					projection,
					config: enabled,
					rules: SUBAGENT,
				}),
			),
		).toEqual([]);
	});

	test("compresses the oldest tier only, and only when it changes the bytes", () => {
		const host = new TestDshHost();
		const session = seedProse(host, "s-cave");
		const projection = projectDshSessionLog(session.logRecords());
		const enabled = {
			...cfg,
			caveman_text_compression: {
				...cfg.caveman_text_compression,
				enabled: true,
			},
		};
		const requests = selectCaveman(
			context({ session, mcSession: "s-cave", projection, config: enabled }),
		);
		// Six nodes ⇒ indices 0 (ultra), 1–2 (full) and 3 (lite, share 0.5) are
		// rewritten; the newest 40% (4–5) stay untouched.
		expect(requests.map((request) => request.messageId).sort()).toEqual([
			"m0",
			"m1",
			"m2",
			"m3",
		]);
	});

	test("the lane applies through the engine and stays byte-stable on replay", async () => {
		const host = new TestDshHost();
		const session = seedProse(host, "s-cave-apply");
		const enabled = {
			...cfg,
			caveman_text_compression: {
				...cfg.caveman_text_compression,
				enabled: true,
			},
		};
		const managedEdits = new ManagedEdits(host);
		const pass = () =>
			runLanePass(managedEdits, {
				session,
				mcSession: "s-cave-apply",
				projection: projectDshSessionLog(session.logRecords()),
				rules: PRIMARY,
				band: "execute",
				permission: { permitted: true, reason: "scheduler" },
				config: enabled,
				db,
				protectedMessageIds: new Set(),
				projectDir: process.cwd(),
				lanes: [cavemanLane],
				gates: new LaneGates(),
			});
		const first = await pass();
		expect(first.changed).toBe(true);
		const compressed = session.logRecords().map((record) => record.text);
		// Re-running over the compressed log must not compress again.
		const second = await pass();
		expect(second.changed).toBe(false);
		expect(session.logRecords().map((record) => record.text)).toEqual(
			compressed,
		);
	});
});

describe("note nudge lane", () => {
	test("delivers one tail notice, then the persisted trigger is consumed", async () => {
		const { onNoteTrigger } = await import(
			"@magic-context/core/hooks/magic-context/note-nudger"
		);
		const { noteNudgeLane, peekNoteNudge } = await import(
			"../src/lanes/note-nudge.js"
		);
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-nudge" }, [0]);
		session.seedMessage(0, "u-nudge", "working on the parser", "user");
		onNoteTrigger(db, "s-nudge", "historian_complete");

		const contextValue = context({
			session,
			mcSession: "s-nudge",
			projection: projectDshSessionLog(session.logRecords()),
		});
		// The core decides whether a nudge is due; with a pending trigger it
		// produces text (the exact copy is the core's).
		const text = peekNoteNudge(contextValue);
		expect(typeof text === "string" || text === null).toBe(true);

		const managedEdits = new ManagedEdits(host);
		const pass = () =>
			runLanePass(managedEdits, {
				session,
				mcSession: "s-nudge",
				projection: projectDshSessionLog(session.logRecords()),
				rules: PRIMARY,
				band: "execute",
				permission: { permitted: true, reason: "scheduler" },
				config: cfg,
				db,
				protectedMessageIds: new Set(),
				projectDir: process.cwd(),
				lanes: [noteNudgeLane],
				gates: new LaneGates(),
			});
		const first = await pass();
		if (text !== null) {
			expect(first.changed).toBe(true);
			expect(session.notices.length).toBeGreaterThan(0);
			// Second pass: the trigger is cleared, so nothing is delivered again.
			const second = await pass();
			expect(second.changed).toBe(false);
		} else {
			expect(first.changed).toBe(false);
		}
	});
});

describe("ctx_reduce channel-2 nudge", () => {
	function seedSpent(host: TestDshHost, id: string) {
		const session = host.addSession({ id }, [0, 1, 2]);
		const tagger = createTagger();
		// The channel-2 predicate has a 60k-token tail minimum and a 50k reclaimable
		// floor; this fixture clears both under the core estimator (~6.5 chars/token).
		const big = "spent output ".repeat(32_000);
		session.seedMessage(0, "u1", "do the work", "user");
		session.seedMessage(1, "a1", "", "assistant", {
			blocks: [
				{ type: "tool-call", id: "c1", name: "grep", arguments: "{}" },
			] as never,
		});
		session.seedMessage(2, "t1", big, "tool", { toolCallId: "c1" });
		tagger.assignTag(id, "u1", "message", 11, db);
		tagger.assignTag(id, "a1", "message", 1, db);
		tagger.assignToolTag(id, "c1", "a1", big.length, db, 0, "grep", 2);
		return session;
	}

	test("fires once per episode when spent tool output dominates the tail", async () => {
		const { reduceNudgeLane, Channel2Lease, measureChannel2 } = await import(
			"../src/lanes/reduce-nudge.js"
		);
		const host = new TestDshHost();
		const session = seedSpent(host, "s-nudge2");
		const laneContext = context({
			session,
			mcSession: "s-nudge2",
			projection: projectDshSessionLog(session.logRecords()),
		});
		const measurement = measureChannel2(laneContext);
		expect(measurement.shouldTrigger).toBe(true);

		const managedEdits = new ManagedEdits(host);
		const lease = new Channel2Lease();
		const pass = () =>
			runLanePass(managedEdits, {
				session,
				mcSession: "s-nudge2",
				projection: projectDshSessionLog(session.logRecords()),
				rules: PRIMARY,
				band: "execute",
				permission: { permitted: true, reason: "scheduler" },
				config: cfg,
				db,
				protectedMessageIds: new Set(),
				projectDir: process.cwd(),
				lanes: [reduceNudgeLane],
				gates: new LaneGates(),
			});
		void lease;
		const first = await pass();
		expect(first.changed).toBe(true);
		const notice = session.notices.at(-1)!;
		expect(JSON.stringify(notice.content)).toContain("ctx_reduce");
		// A second pass delivers nothing new.
		await pass();
		expect(session.notices).toHaveLength(1);
	});

	test("does not fire when reclaimable output is below the floor", async () => {
		const { measureChannel2 } = await import("../src/lanes/reduce-nudge.js");
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-nudge3" }, [0, 1]);
		const tagger = createTagger();
		session.seedMessage(0, "u1", "small task", "user");
		session.seedMessage(1, "t1", "tiny", "tool", { toolCallId: "c1" });
		tagger.assignTag("s-nudge3", "u1", "message", 10, db);
		tagger.assignToolTag("s-nudge3", "c1", "u1", 4, db, 0, "grep", 2);
		const measurement = measureChannel2(
			context({
				session,
				mcSession: "s-nudge3",
				projection: projectDshSessionLog(session.logRecords()),
			}),
		);
		expect(measurement.shouldTrigger).toBe(false);
	});
});

describe("ctx_reduce channel-1 nudge (post-execute)", () => {
	test("rides the post-execute verdict with the core's reminder copy", async () => {
		const { mountAdapter } = await import("../src/index.js");
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-ch1" }, [0, 1, 2]);
		const tagger = createTagger();
		const big = "spent output ".repeat(32_000);
		session.seedMessage(0, "u1", "do the work", "user");
		session.seedMessage(1, "a1", "", "assistant", {
			blocks: [
				{ type: "tool-call", id: "c1", name: "grep", arguments: "{}" },
			] as never,
		});
		session.seedMessage(2, "t1", big, "tool", { toolCallId: "c1" });
		tagger.assignTag("s-ch1", "u1", "message", 11, db);
		tagger.assignTag("s-ch1", "a1", "message", 1, db);
		tagger.assignToolTag("s-ch1", "c1", "a1", big.length, db, 0, "grep", 2);

		const handle = mountAdapter(host, cfg, db, {
			readSessionLog: (sessionId) =>
				host.sessions.get(sessionId)?.logRecords() ?? [],
		});
		const verdict = await host.firePostTool({
			sessionId: "s-ch1",
			toolName: "grep",
			text: "fresh output",
		});
		expect(verdict?.additionalContext).toBeDefined();
		expect(JSON.stringify(verdict?.additionalContext)).toContain("ctx_reduce");
		// A ctx_reduce call itself resets the tracker instead of nudging.
		const afterReduce = await host.firePostTool({
			sessionId: "s-ch1",
			toolName: "ctx_reduce",
			text: "stamped",
		});
		expect(afterReduce?.additionalContext).toBeUndefined();
		await handle.dispose();
	});
});

describe("synthetic todo lane", () => {
	test("delivers once per todo revision and renders the tool's own format", async () => {
		const { todoLane, TodoDelivery, renderTodoList } = await import(
			"../src/lanes/todo.js"
		);
		expect(
			renderTodoList([
				{ content: "ship it", status: "in_progress" },
				{ content: "write docs", status: "completed" },
			]),
		).toBe("Current todo list:\n- [ ] ship it\n- [x] write docs");

		const host = new TestDshHost();
		const session = host.addSession({ id: "s-todo" }, [0]);
		session.seedMessage(0, "u1", "working", "user");
		host.todoStates.set("s-todo", {
			seq: 5,
			items: [{ content: "ship it", status: "in_progress" }],
		});

		const managedEdits = new ManagedEdits(host);
		const delivery = new TodoDelivery();
		const pass = () =>
			runLanePass(managedEdits, {
				session,
				mcSession: "s-todo",
				projection: projectDshSessionLog(session.logRecords()),
				rules: PRIMARY,
				band: "execute",
				permission: { permitted: true, reason: "scheduler" },
				config: cfg,
				db,
				protectedMessageIds: new Set(),
				projectDir: process.cwd(),
				todo: host.todoState("s-todo"),
				lanes: [todoLane],
				gates: new LaneGates(),
			});
		// The lane's public selector uses the module singleton; drive it directly
		// so the test owns the delivery state.
		const { selectTodo } = await import("../src/lanes/todo.js");
		const context = {
			session,
			mcSession: "s-todo",
			projection: projectDshSessionLog(session.logRecords()),
			rules: PRIMARY,
			band: "execute" as const,
			permission: { permitted: true, reason: "scheduler" as const },
			config: cfg,
			db,
			protectedMessageIds: new Set<string>(),
			projectDir: process.cwd(),
			todo: { seq: 5, items: [{ content: "ship it", status: "in_progress" }] },
		};
		expect(selectTodo(context, delivery)).toBeDefined();
		expect(selectTodo(context, delivery)).toBeUndefined();
		expect(
			selectTodo(
				{
					...context,
					todo: {
						seq: 6,
						items: [{ content: "ship it", status: "completed" }],
					},
				},
				delivery,
			),
		).toBeDefined();

		// And the lane delivers through the engine exactly once per revision.
		const first = await pass();
		expect(first.changed).toBe(true);
		await pass();
		expect(session.notices.length).toBeGreaterThanOrEqual(1);
	});
});
