/**
 * Node operations (T019).
 *
 * The node-op layer is where a durable decision becomes a durable surface
 * edit, so these tests pin the four properties every lane depends on:
 *
 * 1. **Identity.** A tool-result rewrite keeps the message id, role and tool
 *    pairing; a user replacement keeps the user role.
 * 2. **Byte-identical replay.** Planning the same decision twice produces the
 *    same bytes, so a deferred pass cannot churn the provider prefix.
 * 3. **Exactly-once under failure.** A failed effect replays once on the next
 *    pass and lands a single edit — never two, never none.
 * 4. **Isolation.** Two sessions that happen to hold the same message ids
 *    never observe each other's edits.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import type { DshLogProjection } from "../src/surface/dsh-session-log.js";
import { projectDshSessionLog } from "../src/surface/dsh-session-log.js";
import { ManagedEdits, StoreUnavailableError } from "../src/surface/managed-edits.js";
import {
	applyNodeOps,
	NodeOpError,
	nodeOpKindForRole,
	planNodeOps,
	runNodeOpsInBracket,
	type NodeOpRequest,
} from "../src/surface/node-ops.js";
import type { McReplacementContent } from "../src/surface/events.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db"), nativeTurnDeadlines: true }))!;
});

afterAll(async () => {
	await closeDatabase();
});

function projectionOf(host: TestDshHost, sessionId: string): DshLogProjection {
	return projectDshSessionLog(host.sessions.get(sessionId)?.logRecords() ?? []);
}

/** A session whose surface holds one user, one assistant and one tool node. */
function seedMixedSession(host: TestDshHost, id: string) {
	const session = host.addSession({ id }, [0, 1, 2]);
	session.seedMessage(0, "u1", "user question", "user");
	session.seedMessage(1, "a1", "assistant answer", "assistant");
	session.seedMessage(2, "t1", "tool output", "tool");
	return session;
}

const DROP: McReplacementContent = [{ type: "text", text: "[dropped §1§]" }];

describe("node op planning", () => {
	test("plans exactly one current node per request, by message id", () => {
		const host = new TestDshHost();
		const session = seedMixedSession(host, "s-plan");
		const projection = projectionOf(host, "s-plan");
		const requests: NodeOpRequest[] = [
			{ messageId: "u1", content: DROP },
			{ messageId: "a1", content: [{ type: "text", text: "[folded §2§]" }] },
			{ messageId: "t1", content: [{ type: "text", text: "[dropped §3§]" }] },
		];
		const plan = planNodeOps(session, projection, requests);
		expect(plan.ops.map((op) => [op.messageId, op.seq, op.kind])).toEqual([
			["u1", 0, "user-rewrite"],
			["a1", 1, "assistant-rewrite"],
			["t1", 2, "tool-result-rewrite"],
		]);
		expect(plan.skipped).toHaveLength(0);
	});

	test("a stale or unknown target is skipped, never thrown", () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-stale" }, [0]);
		session.seedMessage(0, "u1", "only user", "user");
		const projection = projectionOf(host, "s-stale");
		const plan = planNodeOps(session, projection, [
			{ messageId: "nope", content: DROP },
			{ messageId: "u1", content: DROP },
			// A second request for the same node is not a second edit.
			{ messageId: "u1", content: DROP },
		]);
		expect(plan.ops).toHaveLength(1);
		expect(plan.skipped.map((entry) => entry.reason)).toEqual(["unknown-target", "not-current"]);
	});

	test("an empty content request is a caller bug", () => {
		const host = new TestDshHost();
		const session = seedMixedSession(host, "s-empty");
		const projection = projectionOf(host, "s-empty");
		expect(() => planNodeOps(session, projection, [{ messageId: "u1", content: [] }])).toThrow(NodeOpError);
	});

	test("only tool and user roles have a sanctioned shape", () => {
		expect(nodeOpKindForRole("tool")).toBe("tool-result-rewrite");
		expect(nodeOpKindForRole("user")).toBe("user-rewrite");
		expect(nodeOpKindForRole("assistant")).toBe("assistant-rewrite");
		expect(nodeOpKindForRole("system")).toBeUndefined();
	});
});

describe("node op application", () => {
	test("a tool-result rewrite preserves identity and tool pairing", async () => {
		const host = new TestDshHost();
		const session = seedMixedSession(host, "s-ident");
		const projection = projectionOf(host, "s-ident");
		const plan = planNodeOps(session, projection, [{ messageId: "t1", content: DROP }]);
		const applied = await applyNodeOps(session, plan);
		expect(applied).toHaveLength(1);
		expect(applied[0]!.kind).toBe("tool-result-rewrite");
		const record = session.logRecords().find((candidate) => candidate.messageId === "t1")!;
		expect(record.role).toBe("tool");
		expect(record.text).toBe("[dropped §1§]");
		// No span replacement was needed: the rewrite is a one-node patch.
		expect(session.replacements).toHaveLength(1);
		expect(session.replacements[0]!.shadowedSeqs).toEqual([2]);
	});

	test("an assistant rewrite edits content without touching node membership", async () => {
		const host = new TestDshHost();
		const session = seedMixedSession(host, "s-assist");
		const projection = projectionOf(host, "s-assist");
		const plan = planNodeOps(session, projection, [{ messageId: "a1", content: DROP }]);
		await applyNodeOps(session, plan);
		expect(session.surfaceNodes()).toEqual([0, 1, 2]);
		expect(session.logRecords().find((record) => record.messageId === "a1")!.text).toBe("[dropped §1§]");
	});
});

describe("replay and failure behaviour", () => {
	test("planning the same decision twice renders identical bytes", async () => {
		const host = new TestDshHost();
		const session = seedMixedSession(host, "s-bytes");
		const projection = projectionOf(host, "s-bytes");
		const first = planNodeOps(session, projection, [{ messageId: "a1", content: DROP }]);
		const second = planNodeOps(session, projection, [{ messageId: "a1", content: DROP }]);
		expect(JSON.stringify(first.ops.map((op) => op.content))).toBe(JSON.stringify(second.ops.map((op) => op.content)));
	});

	test("a failed surface effect closes the bracket and replays exactly once", async () => {
		const host = new TestDshHost();
		const session = seedMixedSession(host, "s-retry");
		const managedEdits = new ManagedEdits(host);
		const projection = projectionOf(host, "s-retry");
		let failNext = true;
		const original = session.rewriteAssistantBody.bind(session);
		session.rewriteAssistantBody = async (seq: number, content: McReplacementContent) => {
			if (failNext) {
				failNext = false;
				throw new StoreUnavailableError("surface write failed");
			}
			return original(seq, content);
		};
		const run = () =>
			runNodeOpsInBracket(managedEdits, session, projection, {
				kind: "drop",
				changeId: "mc-drop-retry",
				mcSession: "s-retry",
				decision: () => Promise.resolve({ tagNumbers: [1] }),
				requests: () => [{ messageId: "a1", content: DROP }],
			});

		await expect(run()).rejects.toThrow("surface write failed");
		// The bracket opened and closed with an error: the decision replays.
		expect(session.eventsOf("mc/manage-start")).toHaveLength(1);
		expect(session.eventsOf("mc/manage-end")[0]!.data.error).toBeDefined();
		expect(session.rewrittenAssistantBodies).toHaveLength(0);

		const outcome = await run();
		expect(outcome.applied).toHaveLength(1);
		expect(session.rewrittenAssistantBodies).toHaveLength(1);
		expect(session.eventsOf("mc/manage-start")).toHaveLength(2);
		expect(session.eventsOf("mc/manage-end")).toHaveLength(2);
	});

	test("two sessions holding the same message ids never cross-apply", async () => {
		const host = new TestDshHost();
		const left = seedMixedSession(host, "s-left");
		const right = seedMixedSession(host, "s-right");
		const managedEdits = new ManagedEdits(host);
		const outcome = await runNodeOpsInBracket(managedEdits, left, projectionOf(host, "s-left"), {
			kind: "drop",
			changeId: "mc-drop-isolation",
			mcSession: "s-left",
			decision: () => Promise.resolve(null),
			requests: () => [{ messageId: "a1", content: DROP }],
		});
		expect(outcome.applied).toHaveLength(1);
		expect(left.logRecords().find((record) => record.messageId === "a1")!.text).toBe("[dropped §1§]");
		expect(right.logRecords().find((record) => record.messageId === "a1")!.text).toBe("assistant answer");
	});
});
