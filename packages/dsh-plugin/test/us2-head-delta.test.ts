/**
 * T050 — the delta half of the head contract:
 *
 *  - new content (messages → compartments, memories) surfaces ONLY as the
 *    volatile delta; the baseline bytes do not move;
 *  - background writes (memory inserts, new compartments) never re-render
 *    the baseline — they ride `<session-history-since>`/`<memory-updates>`
 *    in the delta;
 *  - a restart rediscovers the durable pair from the fingerprint and replays
 *    it: no fresh baseline, no duplicated head.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let projectDir: string;
let identity: string;
const handles: AdapterHandle[] = [];
const DAY = 86_400_000;

// Mutable durable log: the double reads through this closure, so appending
// here is exactly "more conversation happened".
const records: DshLogMessageRecord[] = [
	{
		seq: 1,
		messageId: "m-1",
		role: "user",
		text: "open the vault",
		createdAt: Date.UTC(2026, 0, 10),
	},
	{
		seq: 2,
		messageId: "m-2",
		role: "assistant",
		text: "vault open",
		createdAt: Date.UTC(2026, 0, 10),
	},
];

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-delta-proj-"));
	identity = resolveProjectIdentityForSession(projectDir)!;
	insertMemory(db, {
		projectPath: identity,
		category: "PROJECT_RULES",
		content: "Baseline rule one.",
	});
});

afterAll(async () => {
	for (const handle of handles) await handle.dispose();
	handles.length = 0;
	await closeDatabase();
});

describe("delta stability and restart replay (T050)", () => {
	test("background writes move only the delta; a restart replays the pair", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({});
		const handle = mountAdapter(host, config, db, {
			readSessionLog: () => records,
			projectDir,
		});
		handles.push(handle);
		host.addSession({ id: "s-delta" });
		host.pressureReadings.set("s-delta", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host.firePreStep({ sessionId: "s-delta", turn: 1, step: 1 }),
		).toBe("enter");

		const first = handle.head.peek("s-delta");
		expect(first).toBeDefined();
		expect(first!.deltaText).toContain("no new content"); // the core placeholder
		const baselineBytes = first!.text;
		const baselineSeq = first!.seq;
		const deltaSeq = first!.deltaSeq;
		expect(deltaSeq).toBeDefined();
		const hashAfterFirst =
			getOrCreateSessionMeta(db, "s-delta").systemPromptHash ?? "";
		expect(hashAfterFirst.split("|")[0]).toBeDefined();

		// Background writes: a new compartment over new messages, a new
		// project memory. All of it is DELTA material — the baseline must not
		// move by a byte (FR-017: no rebuild outside fold points).
		records.push(
			{
				seq: 7,
				messageId: "m-5",
				role: "user",
				text: "rotate the keys too",
				createdAt: Date.now() - DAY,
			},
			{
				seq: 8,
				messageId: "m-6",
				role: "assistant",
				text: "keys rotated",
				createdAt: Date.now() - DAY,
			},
		);
		appendCompartments(db, "s-delta", [
			{
				sequence: 1,
				startMessage: 5,
				endMessage: 6,
				startMessageId: "m-5",
				endMessageId: "m-6",
				title: "Key rotation epoch",
				content: "Rotated the vault keys.",
			},
		]);
		insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content: "Rotated rule: keys turn counter-clockwise.",
		});

		expect(
			await host.firePreStep({ sessionId: "s-delta", turn: 2, step: 2 }),
		).toBe("enter");
		const second = handle.head.peek("s-delta");
		expect(second!.text).toBe(baselineBytes); // byte-for-byte unchanged
		expect(second!.seq).toBe(baselineSeq);
		expect(second!.deltaSeq).not.toBe(deltaSeq); // replaced in place
		expect(second!.deltaText).not.toBe(first!.deltaText);
		// The new content rides the delta, not a re-rendered baseline.
		expect(second!.deltaText).toContain("Key rotation epoch");
		expect(second!.deltaText).toContain("keys turn counter-clockwise");
		// The baseline fingerprint segment is untouched; only the delta moved.
		const hashAfterSecond =
			getOrCreateSessionMeta(db, "s-delta").systemPromptHash ?? "";
		expect(hashAfterSecond.split("|")[0]).toBe(hashAfterFirst.split("|")[0]);
		expect(hashAfterSecond.split("|")[2]).toBe(hashAfterFirst.split("|")[2]);

		// ── Restart ──: a fresh adapter (empty in-memory pairs) over the same
		// durable log. The head nodes exist as adapter surface records; the
		// fingerprint must rediscover the pair without emitting a new baseline.
		records.push(
			{
				seq: baselineSeq,
				messageId: "mc-head-restart-base",
				role: "user",
				text: baselineBytes,
				createdAt: 0,
			},
			{
				seq: second!.deltaSeq!,
				messageId: "mc-head-restart-delta",
				role: "user",
				text: second!.deltaText,
				createdAt: 0,
			},
		);
		await handle.dispose();
		handles.pop();

		const host2 = new TestDshHost();
		const handle2 = mountAdapter(host2, config, db, {
			readSessionLog: () => records,
			projectDir,
		});
		handles.push(handle2);
		host2.addSession({ id: "s-delta" }, [
			0,
			1,
			2,
			3,
			baselineSeq,
			second!.deltaSeq!,
		]);
		host2.pressureReadings.set("s-delta", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host2.firePreStep({ sessionId: "s-delta", turn: 3, step: 3 }),
		).toBe("enter");

		const replayed = handle2.head.peek("s-delta");
		expect(replayed).toBeDefined();
		expect(replayed!.seq).toBe(baselineSeq); // the SAME durable baseline
		expect(replayed!.text).toBe(baselineBytes);
		// Nothing is appended on replay — at most the volatile delta collapses
		// in place (the shared delta renderer persists its cursors, so the
		// already-surfaced increment is not shown again).
		const session2 = host2.sessions.get("s-delta")!;
		expect(session2.notices.length).toBe(0);
		expect(session2.replacements.length).toBeLessThanOrEqual(1);
		if (session2.replacements.length === 1) {
			expect(session2.replacements[0]!.shadowedSeqs).toEqual([
				second!.deltaSeq as number,
			]);
			expect(replayed!.deltaSeq).not.toBe(second!.deltaSeq);
		}
		// Baseline and identity segments survive; only the delta moved.
		const hashAfterRestart =
			getOrCreateSessionMeta(db, "s-delta").systemPromptHash ?? "";
		expect(hashAfterRestart.split("|")[0]).toBe(hashAfterFirst.split("|")[0]);
		expect(hashAfterRestart.split("|")[2]).toBe(hashAfterFirst.split("|")[2]);
		// Identity survives the restart via the persisted fingerprint segment.
		expect(replayed!.identity).toBeDefined();

		await handle2.dispose();
		handles.pop();
	});
});
