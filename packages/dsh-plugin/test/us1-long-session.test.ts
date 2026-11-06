/**
 * US1 pass mechanics (T021): queued drops as managed changes with canonical
 * byte-stable placeholders, protected-tail enforcement, head creation and
 * no-op refresh, and the historian fold publishing through core compartment
 * storage — all on the host double over a real temp store.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { appendCompartments, getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getActiveTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { buildReplacementContent, renderDroppedText } from "@magic-context/core/hooks/magic-context/apply-operations";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle } from "../src/index.js";
import { TestDshHost } from "./double.js";
import { bigMessage, clearPressure, seedSession, setPressure, stepFor, us1Mount } from "./us1-support.js";

let db: ContextDatabase;
let host: TestDshHost;
let handle: AdapterHandle | undefined;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db"), nativeTurnDeadlines: true }))!;
});

afterAll(async () => {
	await handle?.dispose();
	handle = undefined;
	await closeDatabase();
});

function tagNumberFor(mcSession: string, messageId: string): number {
	const tag = getActiveTagsBySession(db, mcSession).find((candidate) => candidate.messageId === messageId);
	if (tag === undefined) throw new Error(`no active tag for ${messageId}`);
	return tag.tagNumber;
}

describe("US1 pass: drops, protected tail, head, fold", () => {
	test("queued drops apply as one managed change with canonical placeholders", async () => {
		host = new TestDshHost();
		handle = us1Mount(host, db);
		const session = seedSession(host, "s-drop", 6);
		clearPressure(host, "s-drop");
		expect(await host.firePreStep(stepFor("s-drop"))).toBe("enter");

		// Agent-stamped drop (the ctx_reduce path): queue m1's tag directly.
		const tag = tagNumberFor("s-drop", "m1");
		queuePendingOp(db, "s-drop", tag, "drop");

		expect(await host.firePreStep(stepFor("s-drop"))).toBe("enter");
		expect(session.replacements).toHaveLength(1);
		const edit = session.replacements[0]!;
		expect(edit.shadowedSeqs).toEqual([1]);
		expect(session.surfaceNodes()).not.toContain(1);
		expect(session.surfaceNodes()).toContain(5);
		const text = session.logRecords().find((record) => record.seq === edit.replacementSeq)!.text;
		expect(text.startsWith(renderDroppedText(tag, buildReplacementContent(tag)))).toBe(true);

		// Bracket discipline: every start has its end, with the shadow info.
		expect(session.eventsOf("mc/manage-start").length).toBe(session.eventsOf("mc/manage-end").length);
		const end = session.eventsOf("mc/manage-end").find((entry) => entry.data.kind === "drop")!;
		expect(end.data.kind).toBe("drop");
		expect(end.data.shadowedSeqs).toEqual([1]);
		expect(end.data.replacementSeq).toBe(edit.replacementSeq);
	});

	test("execute band auto-queues unprotected history and creates the head", async () => {
		const session = seedSession(host, "s-auto", 8);
		setPressure(host, "s-auto", 7_000); // 70%: execute band
		expect(await host.firePreStep(stepFor("s-auto"))).toBe("enter");

		// Protected tail (window 10_000 × 15% budget = 1500 tokens; each
		// message ≈ 1000 ⇒ only the newest fits verbatim): the drop cluster
		// covers seqs 0..6 only.
		expect(session.replacements).toHaveLength(1);
		expect(session.replacements[0]!.shadowedSeqs).toEqual([0, 1, 2, 3, 4, 5, 6]);
		for (const seq of [7]) expect(session.surfaceNodes()).toContain(seq);

		// The head node exists after a managed change landed: guidance text,
		// appended as its own surface node.
		const head = handle!.head.peek("s-auto");
		expect(head).toBeDefined();
		expect(session.surfaceNodes()).toContain(head!.seq);
		const headText = session.logRecords().find((record) => record.seq === head!.seq)!.text;
		expect(headText).toContain("ctx_reduce");
	});

	test("a second pass over identical state opens zero new brackets (byte-stable cache)", async () => {
		const session = host.sessions.get("s-auto")!;
		const startsBefore = session.eventsOf("mc/manage-start").length;
		expect(await host.firePreStep(stepFor("s-auto"))).toBe("enter");
		expect(session.eventsOf("mc/manage-start").length).toBe(startsBefore);
	});

	test("a later queued drop renders the byte-identical canonical placeholder", async () => {
		const session = host.sessions.get("s-auto")!;
		const startsBefore = session.eventsOf("mc/manage-start").length;
		const tag = tagNumberFor("s-auto", "m7");
		queuePendingOp(db, "s-auto", tag, "drop");
		clearPressure(host, "s-auto");
		expect(await host.firePreStep(stepFor("s-auto"))).toBe("enter");

		const kinds = session.eventsOf("mc/manage-start").slice(startsBefore).map((entry) => entry.data.kind);
		expect(kinds).toContain("drop"); // (+ a head node if none existed yet)
		const edit = session.replacements.at(-1)!;
		expect(edit.shadowedSeqs).toEqual([7]);
		const text = session.logRecords().find((record) => record.seq === edit.replacementSeq)!.text;
		// Byte-stability: the placeholder is the pure core renderer's output,
		// not a re-derivation that can drift between passes.
		expect(text.startsWith(buildReplacementContent(tag))).toBe(true);
	});

	test("head refresh replaces the single head node when rendered bytes change", async () => {
		const session = host.sessions.get("s-auto")!;
		const oldHead = handle!.head.peek("s-auto")!.seq;
		appendCompartments(db, "s-auto", [
			{ sequence: 1, startMessage: 0, endMessage: 4, startMessageId: "m0", endMessageId: "m4", title: "Seeded history", content: "Early project work." },
		]);
		expect(await host.firePreStep(stepFor("s-auto"))).toBe("enter");

		const head = handle!.head.peek("s-auto")!;
		expect(head.seq).not.toBe(oldHead);
		expect(session.surfaceNodes()).not.toContain(oldHead);
		expect(session.surfaceNodes()).toContain(head.seq);
		const headText = session.logRecords().find((record) => record.seq === head.seq)!.text;
		expect(headText).toContain("Early project work.");
		const kinds = session.eventsOf("mc/manage-start").map((entry) => entry.data.kind);
		expect(kinds).toContain("head-refresh");
	});

	test("fold at the force band publishes through core compartment storage", async () => {
		const session = seedSession(host, "s-fold", 8);
		host.llmResponder = () => ({ text: "Folded early work." });
		setPressure(host, "s-fold", 8_700); // 87%: force band ⇒ fold first
		expect(await host.firePreStep(stepFor("s-fold"))).toBe("enter");

		expect(host.llmCalls).toBe(1);
		const options = host.llmOptions[0]!;
		expect(options.purpose).toBe("magic-context");
		expect(options.provider).toBe("aux");
		expect(options.model).toBe("hist-1");
		// Request-only: exactly one request-side user message, no durable identity.
		expect(options.messages).toHaveLength(1);
		expect(options.sessionId).toBeUndefined();

		const compartments = getCompartments(db, "s-fold");
		expect(compartments).toHaveLength(1);
		expect(compartments[0]!.startMessage).toBe(0); // durable seq coordinates
		expect(compartments[0]!.endMessage).toBe(6); // emergency budget halves the tail
		expect(compartments[0]!.content).toBe("Folded early work.");

		// Effect: the fold collapsed seqs 0..6 into the fresh head node.
		expect(session.surfaceNodes()).toEqual([7, handle!.head.peek("s-fold")!.seq]);
		const kinds = session.eventsOf("mc/manage-start").map((entry) => entry.data.kind);
		expect(kinds).toEqual(["fold"]);
	});

	test("refuse band: one user-visible notice per refusal episode", async () => {
		const session = host.sessions.get("s-fold")!;
		const refusalNotices = () => session.notices.filter((notice) => notice.content.some((block) => typeof (block as { text?: string }).text === "string" && (block as { text: string }).text.includes("Magic Context refused")));
		host.llmResponder = () => ({ fail: true }); // model fails ⇒ nothing can fold
		setPressure(host, "s-fold", 9_600); // 96%: refuse band
		expect(await host.firePreStep(stepFor("s-fold"))).toBe("reject");
		expect(refusalNotices()).toHaveLength(1);
		expect(session.surfaceNodes()).toContain(7); // the user's content is untouched

		expect(await host.firePreStep(stepFor("s-fold"))).toBe("reject");
		expect(refusalNotices()).toHaveLength(1); // same episode ⇒ no second notice

		await session.appendMessage("m8", bigMessage(8)); // history grows ⇒ m7 becomes foldable again
	host.llmResponder = () => ({ text: "Folded the last message." });
		expect(await host.firePreStep(stepFor("s-fold"))).toBe("enter"); // fold succeeds ⇒ enter
		expect(getCompartments(db, "s-fold")).toHaveLength(2);
		expect(refusalNotices()).toHaveLength(1); // entering an episode resets, appends nothing

		clearPressure(host, "s-fold"); // a low-pressure pass closes the episode
		expect(await host.firePreStep(stepFor("s-fold"))).toBe("enter");
		setPressure(host, "s-fold", 9_600);
		host.llmResponder = () => ({ fail: true });
		expect(await host.firePreStep(stepFor("s-fold"))).toBe("reject");
		expect(refusalNotices()).toHaveLength(2); // new episode ⇒ exactly one new notice
	});

	test("pressure is re-read EVERY pass: band switches take effect next step", async () => {
		const session = host.sessions.get("s-fold")!;
		const startsBefore = session.eventsOf("mc/manage-start").length;
		setPressure(host, "s-fold", 9_600, 20_000); // same tokens, switched-to bigger model ⇒ 48%
		expect(await host.firePreStep(stepFor("s-fold"))).toBe("enter");
		expect(session.eventsOf("mc/manage-start").length).toBe(startsBefore); // no refusal at 48%
		setPressure(host, "s-fold", 9_600, 9_600); // route with no slack ⇒ 100%
		expect(await host.firePreStep(stepFor("s-fold"))).toBe("reject"); // same session, next step
	});

	test("projection: every seeded message carries its durable id and text", async () => {
		const records = host.sessions.get("s-drop")!.logRecords();
		const texts = records.map((record) => record.text);
		expect(texts.some((text) => text.startsWith("message-5-payload"))).toBe(true);
		expect(bigMessage(0).length).toBeGreaterThan(1_000);
	});
});
