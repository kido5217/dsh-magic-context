/**
 * First-step surface gate. Host fact (0.2.2-rc.1, observed live): the pre-step
 * of a fresh session's first step fires before the host logs its first
 * system/message, so any plugin surface write there lands above the protected
 * first surface head and the reopen validator rejects the log
 * ("system/message requires a protected first surface head"). The pass keeps
 * its non-surface bookkeeping (tags, history index) and defers every managed
 * write to the next step.
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
import { mountAdapter, type AdapterHandle } from "../src/index.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
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

describe("first-step surface gate", () => {
	test("no surface writes on a fresh session's first step; management resumes next step", async () => {
		appendCompartments(db, "s-gate", [
			{ sequence: 1, startMessage: 0, endMessage: 1, startMessageId: "m-1", endMessageId: "m-2", title: "Sealed", content: "Already folded history." },
		]);
		const records: readonly DshLogMessageRecord[] = [
			{ seq: 0, messageId: "m-1", role: "user", text: "first", createdAt: 1 },
			{ seq: 1, messageId: "m-2", role: "assistant", text: "second", createdAt: 2 },
		];
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({});
		handle = mountAdapter(host, config, db, { readSessionLog: () => records });
		const session = host.addSession({ id: "s-gate" }, []); // empty surface: host head not logged yet
		host.pressureReadings.set("s-gate", { pressureTokens: 1_000, contextWindow: 100_000 });

		expect(await host.firePreStep({ sessionId: "s-gate", turn: 1, step: 1 })).toBe("enter");
		expect(handle.head.peek("s-gate")).toBeUndefined();
		expect(session.notices).toHaveLength(0);
		expect(session.replacements).toHaveLength(0);

		expect(await host.firePreStep({ sessionId: "s-gate", turn: 2, step: 1 })).toBe("enter");
		expect(handle.head.peek("s-gate")).toBeDefined();
	});
});
