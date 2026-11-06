/**
 * US1 crash-window test (T024, quickstart V7a, finding E2).
 *
 * The "process" dies inside a managed change, after the store decision is
 * written (ManagedEdits step 2) but before the surface effect lands (step 3).
 * The kill is simulated at the ManagedEdits seam: the bracket's step 1
 * (`mc/manage-start` + flush) and step 2 (store decision) run exactly as the
 * wrapper performs them, then the change aborts — no effect, no
 * `mc/manage-end`, because a SIGKILL never returns to the catch blocks.
 * Restart = a fresh ManagedEdits + SessionMapping mount over the same host
 * log and store: the durable log is the crash-resume source of truth, the
 * in-memory pending map is gone.
 *
 * Asserts the V7a/data-model invariants:
 *  (a) the restart sees exactly the pre-crash decision as the SOLE unapplied
 *      item (open bracket in the log + the queued decision in the store);
 *  (b) replaying it produces the same surface effect exactly once — one
 *      replacement node on the surface, a second replay applies nothing, and
 *      a naive forced re-apply fails on the already-shadowed seqs;
 *  (c) no half-applied surface at any point: every targeted seq is still
 *      present before replay, and replaced exactly once after.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getPendingOps, queuePendingOp, removePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { SessionMapping } from "../src/sessions/mapping.js";
import { ManagedEdits } from "../src/surface/managed-edits.js";
import type { McManagedChangeKind, McReplacementContent } from "../src/surface/events.js";
import type { PendingOp } from "@magic-context/core/features/magic-context/types";
import { FakeMcSession, McHost, openBrackets } from "./fixtures-dsh.js";

const SESSION = "us1-crash-window-7741";
const CHANGE_ID = "chg-crash-7741";
const INITIAL_SURFACE = [0, 1, 2, 3] as const;
const REPLACEMENT: McReplacementContent = [{ type: "text", text: "[dropped §1-2§]" }];

let db: ContextDatabase;
let host: McHost;
let session: FakeMcSession;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db") }))!;
	expect(db).toBeTruthy();
});

afterAll(async () => {
	await closeDatabase();
});

/** One reconcile pass, the way crash-resume must run it after a restart. */
async function reconcile(edits: ManagedEdits): Promise<"applied" | "nothing-to-apply"> {
	const open = openBrackets(session);
	// Data-model invariant: at most one unapplied decision per session.
	expect(open.length).toBeLessThanOrEqual(1);
	if (open.length === 0) return "nothing-to-apply";
	const start = open[0]!;
	const changeId = String(start.data.changeId);
	await edits.runManagedChange(start.data.kind as McManagedChangeKind, changeId, SESSION, {
		decision: async () => getPendingOps(db, SESSION),
		effect: async (ops: PendingOp[]) => {
			const targets = ops.map((op) => op.tagId).sort((a, b) => a - b);
			const { replacementSeq } = await session.replaceSurface(
				REPLACEMENT,
				targets[0]!,
				targets[targets.length - 1]!,
				targets,
			);
			for (const op of ops) removePendingOp(db, SESSION, op.tagId);
			return { replacementSeq, shadowedSeqs: targets };
		},
	});
	return "applied";
}

describe("crash window: decision written, effect never landed (V7a)", () => {
	test("restart ⇒ one unapplied decision, replay lands it exactly once, surface never half-applied", async () => {
		host = new McHost();
		session = host.addSession({ id: SESSION }, [...INITIAL_SURFACE]);

		// Mount 1 (pre-crash process): real SessionMapping + ManagedEdits.
		const mappingBefore = new SessionMapping(db);
		const editsBefore = new ManagedEdits(host);
		mappingBefore.upsert({ id: SESSION });
		// The transcript tagger stamped two items; the pass selected both for drop.
		const text = new TextEncoder().encode("dropped item one");
		insertTag(db, SESSION, "msg-a", "message", text.length, 1);
		insertTag(db, SESSION, "msg-b", "message", text.length, 2);

		// --- crash simulation, exactly ManagedEdits.runLocked steps 1–2 -------
		// Step 1: open the durable bracket.
		await session.appendLogEvent("mc/manage-start", {
			changeId: CHANGE_ID,
			kind: "drop",
			mcSession: SESSION,
			dshSessionId: SESSION,
			ignorable: true,
		});
		await session.flush();
		// Step 2: store decision lands (queue-only drop of tags 1–2).
		queuePendingOp(db, SESSION, 1, "drop");
		queuePendingOp(db, SESSION, 2, "drop");
		// SIGKILL: no effect, no mc/manage-end, the whole process (and its
		// in-memory ManagedEdits.pending map) is gone. editsBefore/mappingBefore
		// are simply abandoned — a restart constructs fresh mounts.

		// (c) no half-applied surface at the kill point: untouched initial nodes.
		expect(session.surfaceNodes()).toEqual([...INITIAL_SURFACE]);

		// --- restart: fresh ManagedEdits + SessionMapping mounts ---------------
		const mapping = new SessionMapping(db);
		const edits = new ManagedEdits(host);
		const resumed = mapping.upsert({ id: SESSION });
		expect(resumed.mcSession).toBe(SESSION);

		// (a) the restart sees exactly the pre-crash decision as the sole
		//     unapplied item: one open bracket in the log, and the store holds
		//     precisely that decision (two queued drops, nothing else).
		const open = openBrackets(session);
		expect(open.length).toBe(1);
		expect(open[0]!.data).toMatchObject({
			changeId: CHANGE_ID,
			kind: "drop",
			mcSession: SESSION,
			dshSessionId: SESSION,
			ignorable: true,
		});
		expect(session.eventsOf("mc/manage-end").length).toBe(0);
		const queued = getPendingOps(db, SESSION);
		expect(queued.map((op) => [op.tagId, op.operation]).sort()).toEqual([
			[1, "drop"],
			[2, "drop"],
		]);
		// In-memory bookkeeping was lost with the crash; the log is the source
		// of truth, so the fresh mount starts with nothing pending of its own.
		expect(edits.pendingUnapplied()).toEqual([]);

		// (b) replay applies the SAME surface effect once.
		expect(await reconcile(edits)).toBe("applied");
		const ends = session.eventsOf("mc/manage-end");
		expect(ends.length).toBe(1);
		expect(ends[0]!.data).toMatchObject({ changeId: CHANGE_ID, kind: "drop", shadowedSeqs: [1, 2] });
		const after = session.surfaceNodes();
		const replacementSeq = Number(ends[0]!.data.replacementSeq);
		expect(after).toEqual([0, 3, replacementSeq]);
		// Exactly one replacement node — everything not on the initial surface.
		expect(after.filter((seq) => !INITIAL_SURFACE.includes(seq as (typeof INITIAL_SURFACE)[number]))).toEqual([replacementSeq]);
		// (c) both shadowed seqs are gone exactly once; bracket closed; queue drained.
		expect(openBrackets(session).length).toBe(0);
		expect(getPendingOps(db, SESSION)).toEqual([]);
		expect(edits.pendingUnapplied()).toEqual([]);

		// A second reconcile sees the closed bracket + drained decision and
		// must apply nothing — no double-apply on replay.
		expect(await reconcile(edits)).toBe("nothing-to-apply");
		expect(session.surfaceNodes()).toEqual(after);
		expect(session.eventsOf("mc/manage-end").length).toBe(1);

		// Even a naive forced re-apply (ignoring the durable evidence) cannot
		// double-apply: the shadowed seqs are no longer surface nodes.
		await expect(
			session.replaceSurface(REPLACEMENT, 1, 2, [1, 2]),
		).rejects.toThrow(/not a current surface node/);
		expect(session.surfaceNodes()).toEqual(after);
	});
});
