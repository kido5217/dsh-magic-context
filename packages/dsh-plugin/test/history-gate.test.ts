/**
 * T046 — domain-correct ctx_search history gating for DSH sessions.
 *
 * Stored history ordinals are projection positions, renumbered by folds, so
 * the durable compartment boundary cannot gate the lane (F1/Phase 8). The
 * gate is live visibility instead: a message still on the session surface is
 * suppressed as "already in your context"; once a fold shadows it out, the
 * same message must come back as a searchable hit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import type { DshHost } from "../src/host.js";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import { registerMagicContextToolsDsh } from "../src/tools/index.js";
import { TestDshHost } from "./double.js";
import { callTool, FakeToolHost } from "./double-stub.js";

const SESSION = "s-gate-live";

let db: ContextDatabase;
let handle: AdapterHandle | undefined;
let disposeTools: (() => void) | undefined;
const projectDir = mkdtempSync(join(tmpdir(), "dsh-gate-proj-"));
let current: readonly DshLogMessageRecord[] = [];

function seeded(): DshLogMessageRecord[] {
	return Array.from({ length: 12 }, (_, i) => ({
		seq: i + 1,
		messageId: `gm-${i + 1}`,
		role: i % 2 === 0 ? "user" : "assistant",
		text: `message zephyr${i + 1} body line`,
		createdAt: i + 1,
	}));
}

async function indexedCount(): Promise<number> {
	const row = db
		.prepare(
			"SELECT COUNT(*) AS n FROM message_history_fts WHERE session_id = ?",
		)
		.get(SESSION) as { n: number };
	return row.n;
}

async function waitForIndexed(atLeast: number): Promise<void> {
	// The indexer is async and shared; under full-suite load a pass can take
	// seconds, so the poll budget is generous — the test timeout below is
	// what actually bounds this.
	const deadline = Date.now() + 30_000;
	while ((await indexedCount()) < atLeast && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	expect(await indexedCount()).toBeGreaterThanOrEqual(atLeast);
}

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	expect(db).toBeTruthy();
});

afterAll(async () => {
	disposeTools?.();
	await handle?.dispose();
	handle = undefined;
	rmSync(projectDir, { recursive: true, force: true });
	await closeDatabase();
});

describe("ctx_search live-visibility gate (T046)", () => {
	test("visible messages are suppressed; folded messages return as hits", async () => {
		const host = new TestDshHost();
		current = seeded();
		handle = mountAdapter(host, MagicContextConfigSchema.parse({}), db, {
			readSessionLog: () => current,
		});
		host.addSession({ id: SESSION });
		host.pressureReadings.set(SESSION, {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host.firePreStep({ sessionId: SESSION, turn: 1, step: 1 }),
		).toBe("enter");
		await waitForIndexed(12);

		const toolHost = new FakeToolHost();
		disposeTools = registerMagicContextToolsDsh(
			toolHost as unknown as DshHost,
			{
				db,
				sessionId: () => SESSION,
				projectDir,
				protectedTags: 20,
				promptSurfaceRuntime: createPromptSurfaceRuntime({
					harness: "dsh",
					directory: projectDir,
					warn: () => {},
				}),
			},
		);

		// Everything is visible: the lane must not return raw hits, and the
		// suppression note names the live-tail reason (issue #131 intent).
		const visible = await callTool(toolHost, "ctx_search", {
			query: "zephyr7",
		});
		expect(visible).not.toContain("[message]");
		expect(visible).toContain("already in your context");

		// A fold shadows messages 1–8 out of the surface. The projection now
		// covers only gm-9..gm-12; their stored ordinals no longer line up
		// with anything a boundary could name — the gate must decide by id.
		current = seeded().slice(8);
		await host.firePreStep({ sessionId: SESSION, turn: 2, step: 1 });

		const folded = await callTool(toolHost, "ctx_search", { query: "zephyr7" });
		expect(folded).toContain("[message]");
		expect(folded).toContain("zephyr7");

		// Still-visible messages stay suppressed even after the fold.
		const stillLive = await callTool(toolHost, "ctx_search", {
			query: "zephyr11",
		});
		expect(stillLive).not.toContain("[message]");
		expect(stillLive).toContain("already in your context");
	}, 60_000);
});
