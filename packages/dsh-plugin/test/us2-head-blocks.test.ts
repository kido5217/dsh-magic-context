/**
 * T049 — the baseline carries every shared injection block, sourced exactly
 * as every other harness sources it (the core materializer does the work;
 * the adapter contributes only enrichment):
 *
 *  - `<project-docs>` from the workspace's ARCHITECTURE.md / STRUCTURE.md,
 *    gated by `dreamer.inject_docs`;
 *  - `<user-profile>` from active user memories;
 *  - `<session-history>` with decay-rendered compartments — tier texts
 *    stored, dates from the durable log;
 *  - `<project-memory>` (covered in depth by head-injection/T042; presence
 *    asserted here);
 *  - retired sources stay out: the v2 renderer never emits `<session_facts>`
 *    (facts promote to project memory instead).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { insertUserMemory } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let projectDir: string;
const handles: AdapterHandle[] = [];
const DAY = 86_400_000;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-blocks-proj-"));
	writeFileSync(
		join(projectDir, "ARCHITECTURE.md"),
		"The system has a vault module and a kestrel scheduler.\n",
	);
	const identity = resolveProjectIdentityForSession(projectDir)!;
	insertMemory(db, {
		projectPath: identity,
		category: "PROJECT_RULES",
		content: "Vault rotations happen at dusk.",
	});
	insertUserMemory(db, "User prefers terse answers.", []);
	appendCompartments(db, "s-blocks", [
		{
			sequence: 1,
			startMessage: 1,
			endMessage: 2,
			startMessageId: "m-1",
			endMessageId: "m-2",
			title: "First epoch",
			content: "Full first-tier detail about wiring.",
			p1: "Full first-tier detail about wiring.",
			p2: "Shorter second-tier detail about wiring.",
			p3: "Third tier.",
			p4: "Fourth tier.",
			importance: 40,
			episodeType: "coding",
		},
		{
			sequence: 2,
			startMessage: 3,
			endMessage: 4,
			startMessageId: "m-3",
			endMessageId: "m-4",
			title: "Recent epoch",
			content: "Fresh newest-tier detail about vault keys.",
			p1: "Fresh newest-tier detail about vault keys.",
			p2: "Shorter second-tier about vault keys.",
			p3: "Third tier keys.",
			p4: "Fourth tier keys.",
			importance: 70,
			episodeType: "debugging",
		},
	]);
});

afterAll(async () => {
	for (const handle of handles) await handle.dispose();
	handles.length = 0;
	await closeDatabase();
});

const records: readonly DshLogMessageRecord[] = [
	{
		seq: 1,
		messageId: "m-1",
		role: "user",
		text: "start",
		createdAt: Date.UTC(2026, 0, 10),
	},
	{
		seq: 2,
		messageId: "m-2",
		role: "assistant",
		text: "wired",
		createdAt: Date.UTC(2026, 0, 10),
	},
	{
		seq: 3,
		messageId: "m-3",
		role: "user",
		text: "vault keys?",
		createdAt: Date.now() - DAY,
	},
	{
		seq: 4,
		messageId: "m-4",
		role: "assistant",
		text: "rotated",
		createdAt: Date.now() - DAY,
	},
];

describe("head block coverage (T049)", () => {
	test("docs, profile, decayed history with tiers, memory; retired sources absent", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({});
		const handle = mountAdapter(host, config, db, {
			readSessionLog: () => records,
			projectDir,
		});
		handles.push(handle);
		host.addSession({ id: "s-blocks" });
		host.pressureReadings.set("s-blocks", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host.firePreStep({ sessionId: "s-blocks", turn: 1, step: 1 }),
		).toBe("enter");

		const head = handle.head.peek("s-blocks");
		expect(head).toBeDefined();
		const text = head!.text;

		// Project docs: the workspace's own architecture file, core-rendered.
		expect(text).toContain("<project-docs>");
		expect(text).toContain("vault module");
		// User profile: active user memories, core-rendered.
		expect(text).toContain("<user-profile>");
		expect(text).toContain("terse answers");
		// Session history: decay-rendered compartments with durable-log dates.
		expect(text).toContain("<session-history>");
		expect(text).toContain("First epoch");
		expect(text).toContain("Recent epoch");
		expect(text).toContain("2026-01-10");
		// The freshest compartment renders its P1 text; the older one renders
		// a tier the validated decay curve chose (P1–P4 — all are paraphrases
		// of the same event, so any tier text proves the tier columns fed the
		// shared renderer).
		expect(text).toContain("Fresh newest-tier detail about vault keys.");
		expect(
			text.includes("Full first-tier detail about wiring.") ||
				text.includes("Shorter second-tier detail about wiring.") ||
				text.includes("Third tier.") ||
				text.includes("Fourth tier."),
		).toBe(true);
		// Project memory (depth lives in head-injection/T042).
		expect(text).toContain("<project-memory>");
		expect(text).toContain("Vault rotations happen at dusk.");
		// Retired v1 source: facts never render into the v2 baseline.
		expect(text).not.toContain("<session_facts>");

		await handle.dispose();
		handles.pop();
	});

	test("inject_docs=false omits the docs block", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({
			dreamer: { inject_docs: false },
		});
		const handle = mountAdapter(host, config, db, {
			readSessionLog: () => records,
			projectDir,
		});
		handles.push(handle);
		host.addSession({ id: "s-blocks-nodocs" });
		host.pressureReadings.set("s-blocks-nodocs", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host.firePreStep({
				sessionId: "s-blocks-nodocs",
				turn: 1,
				step: 1,
			}),
		).toBe("enter");

		const head = handle.head.peek("s-blocks-nodocs");
		expect(head).toBeDefined();
		expect(head!.text).not.toContain("<project-docs>");
		expect(head!.text).toContain("<project-memory>");

		await handle.dispose();
		handles.pop();
	});
});
