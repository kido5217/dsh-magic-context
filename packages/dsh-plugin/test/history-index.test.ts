/**
 * T045 — pass-fed history indexing: projected durable-log messages reach
 * the core message index (message_history_index), which is what makes the
 * ctx_search history lane answer for DSH sessions (FR-002).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { mountAdapter, type AdapterHandle } from "../src/index.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let handle: AdapterHandle | undefined;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db"), nativeTurnDeadlines: true }))!;
	expect(db).toBeTruthy();
});

afterAll(async () => {
	await handle?.dispose();
	handle = undefined;
	await closeDatabase();
});

function records(turn: number): readonly DshLogMessageRecord[] {
	return [
		{ seq: 1, messageId: "m-1", role: "user", text: "how do giraffes sleep", createdAt: 1 },
		{ seq: 2, messageId: "m-2", role: "assistant", text: "briefly, in standing naps", createdAt: 2 },
		{ seq: 3, messageId: "m-3", role: "user", text: `follow-up turn ${turn}`, createdAt: 3 },
		{ seq: 4, messageId: "m-4", role: "assistant", text: "the kestrel flies at dusk", createdAt: 4 },
	];
}

async function indexedCount(sessionId: string): Promise<number> {
	// The FTS table is the searchable corpus (message_history_index is only
	// the per-session watermark row).
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM message_history_fts WHERE session_id = ?")
		.get(sessionId) as { n: number };
	return row.n;
}

async function waitForIndexed(sessionId: string, atLeast: number): Promise<number> {
	const deadline = Date.now() + 5_000;
	let n = await indexedCount(sessionId);
	while (n < atLeast && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		n = await indexedCount(sessionId);
	}
	return n;
}

describe("pass-fed message-history index (T045)", () => {
	test("pre-step pass indexes projected messages under the mc session key", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({});
		let current = records(1);
		handle = mountAdapter(host, config, db, { readSessionLog: () => current });
		host.addSession({ id: "s-hist" });
		host.pressureReadings.set("s-hist", { pressureTokens: 1_000, contextWindow: 100_000 });

		const decision = await host.firePreStep({ sessionId: "s-hist", turn: 1, step: 1 });
		expect(decision).toBe("enter");
		expect(await waitForIndexed("s-hist", 4)).toBe(4);

		const rows = db
			.prepare(
				"SELECT message_ordinal AS ordinal, role, content FROM message_history_fts WHERE session_id = ? ORDER BY message_ordinal",
			)
			.all("s-hist") as Array<{ ordinal: number; role: string; content: string }>;
		expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(rows[3]!.content).toContain("kestrel");
		// Projection-position ordinals: 1..n positions of this snapshot. Not
		// comparable to compartment boundaries (durable seqs) — the search
		// lane gates DSH sessions by live visibility instead (see T046).
		expect(rows.map((row) => row.ordinal)).toEqual([1, 2, 3, 4]);

		// A later pass with new messages indexes only the new ones.
		current = [
			...records(1),
			{ seq: 5, messageId: "m-5", role: "user", text: "what about owls at dawn", createdAt: 5 },
		];
		await host.firePreStep({ sessionId: "s-hist", turn: 2, step: 1 });
		expect(await waitForIndexed("s-hist", 5)).toBe(5);
		const fifth = db
			.prepare(
				"SELECT message_ordinal AS ordinal, content FROM message_history_fts WHERE session_id = ? AND message_ordinal = 5",
			)
			.get("s-hist") as { ordinal: number; content: string } | undefined;
		expect(fifth?.content).toContain("owls");

		await handle.dispose();
		handle = undefined;
	});
});
