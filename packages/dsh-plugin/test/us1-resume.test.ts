/**
 * US1 crash-resume (T023): coverage bookkeeping doubles as the resume guard.
 * A fresh mount (fresh host double + fresh ctx) over the SAME durable session
 * log + same store reads the compartment boundary from the store, never
 * re-summarizes covered history, never replays a dangling bracket into a
 * double apply, and keeps managing new history.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle } from "../src/index.js";
import { TestDshHost } from "./double.js";
import { bigMessage, seedSession, setPressure, stepFor, us1Mount } from "./us1-support.js";

let db: ContextDatabase;
let host = new TestDshHost();
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

/** Cross-test seq coordinates (bracket log events consume seqs too). */
const later = { m8Seq: -1, m9Seq: -1 };

function transcript(call: number): string {
	const message = host.llmOptions[call]!.messages[0]!;
	return (message as { content: readonly { text?: string }[] }).content.map((block) => block.text ?? "").join("");
}

/** Simulate a restart: a fresh host/ctx over the same durable session log. */
function remount(): void {
	host = new TestDshHost();
}

describe("US1 resume: covered history is never re-summarized", () => {
	test("mount A folds, then dies with a dangling bracket", async () => {
		handle = us1Mount(host, db);
		const session = seedSession(host, "r-main", 8);
		host.llmResponder = () => ({ text: "First fold." });
		setPressure(host, "r-main", 8_700);
		expect(await host.firePreStep(stepFor("r-main"))).toBe("enter");
		expect(getCompartments(db, "r-main")).toHaveLength(1);
		expect(getCompartments(db, "r-main")[0]!.endMessage).toBe(6);
		expect(session.eventsOf("mc/manage-end")).toHaveLength(1);

		// Crash simulation: a bracket opened, the process died before the end.
		await session.appendLogEvent("mc/manage-start", { changeId: "orphan-1", kind: "fold", mcSession: "r-main", dshSessionId: "r-main", ignorable: true });
		await handle.dispose();
		handle = undefined;
	});

	test("mount B skips the covered window — no re-summarization, no double apply", async () => {
		const session = host.sessions.get("r-main")!;
		remount();
		host.sessions.set("r-main", session); // same durable log, fresh ctx
		handle = us1Mount(host, db);
		const m8Seq = await session.appendMessage("m8", bigMessage(8));
		const m9Seq = await session.appendMessage("m9", bigMessage(9));
		later.m8Seq = m8Seq;
		later.m9Seq = m9Seq;
		host.llmResponder = () => ({ text: "Second fold." });
		setPressure(host, "r-main", 8_700);
		expect(await host.firePreStep(stepFor("r-main"))).toBe("enter");

		expect(host.llmCalls).toBe(1); // one call, for the NEW window only
		const text = transcript(0);
		expect(text).toContain("[7]"); // uncovered history summarizes
		expect(text).toContain(`[${String(m8Seq)}]`);
		expect(text).not.toContain("[0]"); // covered history does not
		expect(text).not.toContain("[6]");

		const compartments = getCompartments(db, "r-main");
		expect(compartments).toHaveLength(2);
		expect(compartments[1]!.startMessage).toBe(7); // continues exactly past the boundary
		expect(compartments[1]!.endMessage).toBe(m8Seq);
		// The dangling orphan was NOT replayed into a second apply: only the
		// real fold closed a bracket.
		expect(session.eventsOf("mc/manage-end")).toHaveLength(2);
	});

	test("a no-op pass over unchanged state opens zero brackets", async () => {
		const session = host.sessions.get("r-main")!;
		const startsBefore = session.eventsOf("mc/manage-start").length;
		setPressure(host, "r-main", 8_700);
		expect(await host.firePreStep(stepFor("r-main"))).toBe("enter");
		expect(session.eventsOf("mc/manage-start").length).toBe(startsBefore);
		expect(host.llmCalls).toBe(1);
	});

	test("management continues after resume: new history folds normally", async () => {
		const session = host.sessions.get("r-main")!;
		const m9SeqForFold3 = later.m9Seq;
		const m10Seq = await session.appendMessage("m10", bigMessage(10));
		const m11Seq = await session.appendMessage("m11", bigMessage(11));
		host.llmResponder = () => ({ text: "Third fold." });
		setPressure(host, "r-main", 8_700);
		expect(await host.firePreStep(stepFor("r-main"))).toBe("enter");

		const compartments = getCompartments(db, "r-main");
		expect(compartments).toHaveLength(3);
		expect(compartments[2]!.startMessage).toBe(m9SeqForFold3); // the previously protected newest message
		expect(compartments[2]!.endMessage).toBe(m10Seq);
		expect(transcript(1)).toContain(`[${String(m10Seq)}]`);
		// Surface after three folds: newest message + one fresh baseline node
		// + its placeholder delta (T043 pair semantics).
		const head = handle!.head.peek("r-main")!;
		expect(session.surfaceNodes()).toEqual([m11Seq, head.seq, head.deltaSeq!]);
		await handle!.dispose();
		handle = undefined;
	});

	test("mount C on settled state: zero model calls, zero brackets (head bytes stable)", async () => {
		const session = host.sessions.get("r-main")!;
		remount();
		host.sessions.set("r-main", session);
		handle = us1Mount(host, db);
		const startsBefore = session.eventsOf("mc/manage-start").length;
		setPressure(host, "r-main", 8_700);
		expect(await host.firePreStep(stepFor("r-main"))).toBe("enter");
		expect(host.llmCalls).toBe(0); // nothing new to summarize
		expect(session.eventsOf("mc/manage-start").length).toBe(startsBefore); // byte-identical head ⇒ no refresh
	});
});
