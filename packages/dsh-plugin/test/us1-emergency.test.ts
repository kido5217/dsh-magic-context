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
