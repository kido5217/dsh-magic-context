/**
 * US1 lane mechanics (T037, first slice): gating, the engine's containment and
 * determinism, and the injection-strip lane on the host double over a real
 * store.
 *
 * The gating matrix is the contract's core claim — routine lanes once per
 * episode on a primary session, every permitted pass on a subagent, emergency
 * only from the force band — so it is tested as a table rather than through
 * side effects. The engine tests then prove the three properties a lane
 * failure must never break: containment, one bracket per lane, and a
 * plan that no longer matches the surface becoming a no-op.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type Lane, runLanePass } from "../src/lanes/engine.js";
import {
	type LaneGateRequest,
	LaneGates,
	rebuildPermission,
} from "../src/lanes/gating.js";
import {
	injectionStripLane,
	selectInjectionStrips,
} from "../src/lanes/heuristics.js";
import { selectTemporalMarkers } from "../src/lanes/temporal.js";
import { rulesForRole } from "../src/sessions/subagent-rules.js";
import { projectDshSessionLog } from "../src/surface/dsh-session-log.js";
import { ManagedEdits } from "../src/surface/managed-edits.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;

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

const cfg = MagicContextConfigSchema.parse({});
const PRIMARY = rulesForRole("primary");
const SUBAGENT = rulesForRole("subagent");
const INJECTED =
	"real question\n<system-reminder>stale harness note</system-reminder>\nmore text";

function gate(overrides: Partial<LaneGateRequest> = {}): LaneGateRequest {
	return {
		sessionId: "s-gate",
		lane: "injection-strip",
		frequency: "routine",
		role: "primary",
		band: "execute",
		permission: { permitted: true, reason: "scheduler" },
		...overrides,
	};
}

describe("rebuild permission", () => {
	test("any of scheduler, force, refuse, or a landed change grants it", () => {
		expect(
			rebuildPermission({ schedulerAllows: true, band: "below-execute" }),
		).toEqual({ permitted: true, reason: "scheduler" });
		expect(
			rebuildPermission({ schedulerAllows: false, band: "force" }),
		).toEqual({ permitted: true, reason: "force-band" });
		expect(
			rebuildPermission({ schedulerAllows: false, band: "refuse" }),
		).toEqual({ permitted: true, reason: "refuse-wall" });
		expect(
			rebuildPermission({
				schedulerAllows: false,
				band: "execute",
				managedChangeLanded: true,
			}),
		).toEqual({ permitted: true, reason: "managed-change" });
	});

	test("below the band with nothing landed, no lane may apply", () => {
		expect(
			rebuildPermission({ schedulerAllows: false, band: "below-execute" })
				.permitted,
		).toBe(false);
		expect(
			rebuildPermission({ schedulerAllows: false, band: "execute" }).permitted,
		).toBe(false);
	});
});

describe("episode gating", () => {
	test("primary: once per episode; subagent: every permitted pass", () => {
		const gates = new LaneGates();
		expect(gates.allows(gate())).toBe(true);
		gates.commit("s-gate", "injection-strip", "primary");
		expect(gates.allows(gate())).toBe(false);

		expect(gates.allows(gate({ sessionId: "s-sub", role: "subagent" }))).toBe(
			true,
		);
		gates.commit("s-sub", "injection-strip", "subagent");
		// A subagent keeps applying: it is short-lived and its caller is waiting.
		expect(gates.allows(gate({ sessionId: "s-sub", role: "subagent" }))).toBe(
			true,
		);
	});

	test("falling below the execute band starts a new episode", () => {
		const gates = new LaneGates();
		gates.commit("s-gate", "injection-strip", "primary");
		expect(gates.allows(gate())).toBe(false);
		gates.resetEpisode("s-gate");
		expect(gates.allows(gate())).toBe(true);
		expect(gates.snapshot("s-gate")).toEqual([]);
	});

	test("emergency runs only from the force band", () => {
		const gates = new LaneGates();
		expect(
			gates.allows(
				gate({ lane: "emergency", frequency: "emergency", band: "execute" }),
			),
		).toBe(false);
		expect(
			gates.allows(
				gate({ lane: "emergency", frequency: "emergency", band: "force" }),
			),
		).toBe(true);
		expect(
			gates.allows(
				gate({ lane: "emergency", frequency: "emergency", band: "refuse" }),
			),
		).toBe(true);
	});

	test("no permission ⇒ no lane, even an unclaimed episode", () => {
		const gates = new LaneGates();
		expect(gates.allows(gate({ permission: { permitted: false } }))).toBe(
			false,
		);
	});
});

/** A session with one injected user message and one injected assistant body. */
function seedInjected(host: TestDshHost, id: string) {
	const session = host.addSession({ id }, [0, 1, 2]);
	session.seedMessage(0, "u-inj", INJECTED, "user");
	session.seedMessage(
		1,
		"a-inj",
		`answer\n<system-reminder>note</system-reminder>`,
		"assistant",
	);
	session.seedMessage(2, "clean", "nothing injected here", "user");
	return session;
}

describe("injection-strip lane", () => {
	test("selects only the nodes that actually carry injected regions", () => {
		const host = new TestDshHost();
		const session = seedInjected(host, "s-inj");
		const projection = projectDshSessionLog(session.logRecords());
		const requests = selectInjectionStrips({
			session,
			mcSession: "s-inj",
			projection,
			rules: PRIMARY,
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
		});
		expect(requests.map((request) => request.messageId).sort()).toEqual([
			"a-inj",
			"u-inj",
		]);
		// The stripped bytes are the core stripper's, not a local approximation.
		expect((requests[0]!.content[0] as { text: string }).text).not.toContain(
			"<system-reminder>",
		);
	});

	test("applies as one bracket, rewrites user and assistant nodes, replays identically", async () => {
		const host = new TestDshHost();
		const session = seedInjected(host, "s-apply");
		const managedEdits = new ManagedEdits(host);
		// Every real pass re-projects the log it just wrote; the lane is a
		// function of the CURRENT surface, never of a snapshot.
		const pass = () =>
			runLanePass(managedEdits, {
				session,
				mcSession: "s-apply",
				projection: projectDshSessionLog(session.logRecords()),
				rules: PRIMARY,
				band: "execute",
				permission: { permitted: true, reason: "scheduler" },
				config: cfg,
				db,
				protectedMessageIds: new Set(),
				lanes: [injectionStripLane],
				gates: new LaneGates(),
			});

		const first = await pass();
		expect(first.changed).toBe(true);
		expect(first.outcomes[0]!.applied.map((op) => op.kind).sort()).toEqual([
			"assistant-rewrite",
			"user-rewrite",
		]);
		expect(session.eventsOf("mc/manage-start")).toHaveLength(1);
		expect(session.eventsOf("mc/manage-end")).toHaveLength(1);
		// The assistant node is edited in place (projection), the user node replaced.
		expect(session.rewrittenAssistantBodies).toHaveLength(1);
		expect(session.replacements).toHaveLength(1);
		const replaced = session.rewrittenUserMessages[0]!;
		expect(
			session
				.logRecords()
				.find((record) => record.seq === replaced.replacementSeq)!.text,
		).toBe("real question\n\nmore text");

		// The same projection re-plans the same bytes (determinism), and the
		// already-stripped nodes no longer match, so nothing applies twice.
		const second = await pass();
		expect(second.changed).toBe(false);
		expect(session.eventsOf("mc/manage-start")).toHaveLength(1);
	});
});

describe("lane engine containment", () => {
	test("a throwing selector fails only its own lane", async () => {
		const host = new TestDshHost();
		const session = seedInjected(host, "s-throw");
		const managedEdits = new ManagedEdits(host);
		const exploding: Lane = {
			name: "dedup",
			frequency: "routine",
			changeKind: "drop",
			select: () => {
				throw new Error("selector exploded");
			},
		};
		const result = await runLanePass(managedEdits, {
			session,
			mcSession: "s-throw",
			projection: projectDshSessionLog(session.logRecords()),
			rules: PRIMARY,
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
			lanes: [exploding, injectionStripLane],
			gates: new LaneGates(),
		});
		expect(result.outcomes[0]!.error).toContain("selector exploded");
		expect(result.outcomes[0]!.changed).toBe(false);
		// The next lane still ran and still applied.
		expect(result.outcomes[1]!.changed).toBe(true);
		expect(result.changed).toBe(true);
		// Only the successful lane opened a bracket.
		expect(session.eventsOf("mc/manage-start")).toHaveLength(1);
	});

	test("a failed surface write closes the bracket and never half-applies", async () => {
		const host = new TestDshHost();
		const session = seedInjected(host, "s-fail");
		const managedEdits = new ManagedEdits(host);
		const original = session.rewriteUserMessage.bind(session);
		let calls = 0;
		session.rewriteUserMessage = async (seq, content) => {
			calls += 1;
			throw new Error(`surface refused (attempt ${String(calls)})`);
		};
		const result = await runLanePass(managedEdits, {
			session,
			mcSession: "s-fail",
			projection: projectDshSessionLog(session.logRecords()),
			rules: PRIMARY,
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
			lanes: [injectionStripLane],
			gates: new LaneGates(),
		});
		expect(result.outcomes[0]!.error).toContain("surface refused");
		expect(result.changed).toBe(false);
		const ends = session.eventsOf("mc/manage-end");
		expect(ends).toHaveLength(1);
		expect(ends[0]!.data.error).toBeDefined();
		void original;
	});

	test("a stale plan becomes a no-op instead of a second edit", async () => {
		const host = new TestDshHost();
		const session = seedInjected(host, "s-stale");
		const managedEdits = new ManagedEdits(host);
		const projection = projectDshSessionLog(session.logRecords());
		// The node is rewritten before the lane's plan is applied.
		await session.rewriteUserMessage(0, [
			{ type: "text", text: "already reduced" },
		]);
		const result = await runLanePass(managedEdits, {
			session,
			mcSession: "s-stale",
			projection,
			rules: PRIMARY,
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
			lanes: [injectionStripLane],
			gates: new LaneGates(),
		});
		// The assistant target still applies; the user target is reported stale.
		const skipped = result.outcomes[0]!.skipped.map((entry) => entry.reason);
		expect(skipped).toContain("not-current");
	});
});

describe("temporal lane", () => {
	/** Two user turns four hours apart, plus an assistant answer in between. */
	function seedGappy(host: TestDshHost, id: string) {
		const session = host.addSession({ id }, [0, 1, 2]);
		const base = 1_700_000_000_000;
		session.seedMessage(0, "u1", "first question", "user", { createdAt: base });
		session.seedMessage(1, "a1", "first answer", "assistant", {
			createdAt: base + 1_000,
		});
		session.seedMessage(2, "u2", "second question", "user", {
			createdAt: base + 4 * 60 * 60 * 1000,
		});
		return session;
	}

	test("marks the entering user message with the elapsed gap", () => {
		const host = new TestDshHost();
		const session = seedGappy(host, "s-time");
		const requests = selectTemporalMarkers({
			session,
			mcSession: "s-time",
			projection: projectDshSessionLog(session.logRecords()),
			rules: PRIMARY,
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
		});
		expect(requests.map((request) => request.messageId)).toEqual(["u2"]);
		// The gap is measured from the PREVIOUS message's creation (the assistant
		// answer one second after the first question), so 4h minus 1s.
		expect((requests[0]!.content[0] as { text: string }).text).toBe(
			"<!-- +3h 59m -->\nsecond question",
		);
	});

	test("disabled config injects nothing; an existing marker is never doubled", () => {
		const host = new TestDshHost();
		const session = seedGappy(host, "s-time2");
		const projection = projectDshSessionLog(session.logRecords());
		const context = {
			session,
			mcSession: "s-time2",
			projection,
			rules: PRIMARY,
			band: "execute" as const,
			permission: { permitted: true, reason: "scheduler" as const },
			config: { ...cfg, temporal_awareness: false },
			db,
			protectedMessageIds: new Set<string>(),
		};
		expect(selectTemporalMarkers(context)).toEqual([]);

		const applied = selectTemporalMarkers({ ...context, config: cfg });
		expect(applied).toHaveLength(1);
		const replay = selectTemporalMarkers({
			...context,
			config: cfg,
			projection: projectDshSessionLog([
				{ ...session.logRecords()[0]! },
				{ ...session.logRecords()[1]! },
				{ ...session.logRecords()[2]!, text: "<!-- +4h -->\nsecond question" },
			]),
		});
		expect(replay).toEqual([]);
	});
});
