/**
 * T042 — the DSH head renders the injection-pipeline content: the
 * `<project-memory>` block (with the session_meta cache + rendered-id capture
 * that `ctx_search` hard-filters on) and temporal compartment date ranges
 * resolved from durable-log timestamps.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { mountAdapter, type AdapterHandle } from "../src/index.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let handle: AdapterHandle | undefined;
let projectDir: string;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db"), nativeTurnDeadlines: true }))!;
	expect(db).toBeTruthy();
	projectDir = mkdtempSync(join(tmpdir(), "mc-head-proj-"));
});

afterAll(async () => {
	await handle?.dispose();
	handle = undefined;
	await closeDatabase();
});

describe("head renders the injection pipeline (T042)", () => {
	test("project-memory block + temporal ranges land in the head; rendered ids persist", async () => {
		const identity = resolveProjectIdentityForSession(projectDir);
		expect(identity).toBeTruthy();
		const memory = insertMemory(db, {
			projectPath: identity!,
			category: "PROJECT_RULES",
			content: "Always fly the kestrel at dusk.",
		});
		appendCompartments(db, "s-head", [
			{
				sequence: 1,
				startMessage: 1,
				endMessage: 2,
				startMessageId: "m-1",
				endMessageId: "m-2",
				title: "First epoch",
				content: "We discussed flight patterns.",
			},
		]);
		const records: readonly DshLogMessageRecord[] = [
			{ seq: 1, messageId: "m-1", role: "user", text: "tell me about flight", createdAt: Date.UTC(2026, 0, 10) },
			{ seq: 2, messageId: "m-2", role: "assistant", text: "flight is managed glide", createdAt: Date.UTC(2026, 0, 12) },
			{ seq: 3, messageId: "m-3", role: "user", text: "fascinating", createdAt: Date.UTC(2026, 0, 12) },
		];

		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({});
		handle = mountAdapter(host, config, db, { readSessionLog: () => records, projectDir });
		host.addSession({ id: "s-head" });
		host.pressureReadings.set("s-head", { pressureTokens: 1_000, contextWindow: 100_000 });
		expect(await host.firePreStep({ sessionId: "s-head", turn: 1, step: 1 })).toBe("enter");

		const head = handle.head.peek("s-head");
		expect(head).toBeDefined();
		expect(head!.text).toContain("<project-memory>");
		expect(head!.text).toContain("kestrel at dusk");
		// Temporal awareness: dates come from the durable log's own timestamps.
		expect(head!.text).toContain('start-date="2026-01-10" end-date="2026-01-12"');
		expect(head!.text).toContain("First epoch");

		// The rendered-id capture drives ctx_search hard-filtering (visible ids).
		const row = db
			.prepare("SELECT memory_block_ids, memory_block_count FROM session_meta WHERE session_id = ?")
			.get("s-head") as { memory_block_ids: string; memory_block_count: number };
		expect(JSON.parse(row.memory_block_ids)).toContain(memory.id);
		expect(row.memory_block_count).toBe(1);

		await handle.dispose();
		handle = undefined;
	});
});
