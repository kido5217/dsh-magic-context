/**
 * US3 attribution audit (T033, FR-003, data-model: session-scoped tables
 * carry `harness`; project-scoped tables carry none).
 *
 * Runs every session-scoped write path the adapter owns against a real store
 * and audits attribution:
 *  1. mapping upsert            → session_meta
 *  2. managed change (drop)     → pending_ops (core queuePendingOp decision)
 *  3. ctx_note                  → notes (session scope)
 *  4. ctx_memory                → memories (project scope: NO harness column)
 *  5. history-index write       → message_history_index
 *     (core `markMessageIndexDirty` — the message-index progress insert, the
 *     harness-stamped write reachable without the hook/story layer; the FTS
 *     row writer `indexSingleMessage` additionally needs the session's raw
 *     provider, which is the sessions layer, not the adapter under audit)
 *
 * Cross-harness rows seeded with harness='pi' must be untouched: each seeded
 * row is dumped (all columns, JSON) before the adapter writes and byte-
 * compared after.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { getPendingOps, queuePendingOp, removePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { markMessageIndexDirty } from "@magic-context/core/features/magic-context/message-index";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { SessionMapping } from "../src/sessions/mapping.js";
import { ManagedEdits } from "../src/surface/managed-edits.js";
import { registerMagicContextToolsDsh } from "../src/tools/index.js";
import type { McReplacementContent } from "../src/surface/events.js";
import { McHost, callTool } from "./fixtures-dsh.js";

const DSH_SESSION = "us3-attr-dsh-7741";
/** A session owned by another harness on the same shared store. */
const PI_SESSION = "us3-attr-pi-7741";
const PI_STAMP = 1_700_000_000_000;

let db: ContextDatabase;
let host: McHost;
let projectDir: string;
let disposeTools: () => void;

/** All columns of one row, as bytes-stable JSON for before/after compares. */
function dumpRow(sql: string, ...params: Array<string | number>): string {
	const row = db.prepare(sql).get(...params) as unknown;
	return JSON.stringify(row ?? null);
}

const seedDumps: Array<{ table: string; dump: string }> = [];

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db") }))!;
	expect(db).toBeTruthy();
	projectDir = mkdtempSync(join(tmpdir(), "dsh-us3-attr-proj-"));
});

afterAll(async () => {
	disposeTools?.();
	rmSync(projectDir, { recursive: true, force: true });
	await closeDatabase();
});

describe("attribution: every session-scoped adapter write carries harness='dsh' (FR-003)", () => {
	test("cross-harness 'pi' rows are seeded on all audited session-scoped tables", () => {
		db.prepare("INSERT INTO session_meta (session_id, harness) VALUES (?, 'pi')").run(PI_SESSION);
		db.prepare(
			"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 9, 'drop', ?, 'pi')",
		).run(PI_SESSION, PI_STAMP);
		db.prepare(
			"INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness) VALUES ('session', 'active', 'pi-side note', ?, ?, ?, 'pi')",
		).run(PI_SESSION, PI_STAMP, PI_STAMP);
		db.prepare(
			"INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness) VALUES (?, 7, 0, ?, 'pi')",
		).run(PI_SESSION, PI_STAMP);

		// Capture full-row dumps BEFORE any adapter write happens.
		const seeds = [
			["session_meta", dumpRow("SELECT * FROM session_meta WHERE session_id = ?", PI_SESSION)],
			["pending_ops", dumpRow("SELECT * FROM pending_ops WHERE session_id = ? AND tag_id = 9", PI_SESSION)],
			["notes", dumpRow("SELECT * FROM notes WHERE session_id = ? AND content = 'pi-side note'", PI_SESSION)],
			["message_history_index", dumpRow("SELECT * FROM message_history_index WHERE session_id = ?", PI_SESSION)],
		] as const;
		for (const [, dump] of seeds) expect(dump).not.toBe("null");
		seedDumps.push(...seeds.map(([table, dump]) => ({ table, dump })));
	});

	test("mapping upsert, managed change, ctx_note, ctx_memory and the history-index write all stamp harness='dsh'", async () => {
		// 1. Session mapping upsert (adapter's own write path).
		const mapping = new SessionMapping(db);
		expect(mapping.upsert({ id: DSH_SESSION }).role).toBe("primary");

		// 2. Managed change: drop decision via core queuePendingOp, effect via
		//    the session seam; the queue row is the audited store write.
		host = new McHost();
		const session = host.addSession({ id: DSH_SESSION }, [0, 1, 2, 3]);
		insertTag(db, DSH_SESSION, "msg-a", "message", 64, 1);
		const edits = new ManagedEdits(host);
		const shadow = await edits.runManagedChange("drop", "chg-attr-1", DSH_SESSION, {
			decision: async () => {
				queuePendingOp(db, DSH_SESSION, 1, "drop");
				return [1];
			},
			effect: async (targets: number[]) => {
				const { replacementSeq } = await session.replaceSurface(
					[{ type: "text", text: "[dropped §1§]" }] satisfies McReplacementContent,
					targets[0]!,
					targets[0]!,
					targets,
				);
				removePendingOp(db, DSH_SESSION, targets[0]!);
				return { replacementSeq, shadowedSeqs: targets };
			},
		});
		expect(shadow.replacementSeq).toBeTypeOf("number");
		// The decision row existed with our harness while it was queued — read
		// attribution before consumption via the audit query below (the row is
		// re-queued on tag 3 so a live row remains for the DISTINCT audit).
		queuePendingOp(db, DSH_SESSION, 3, "drop");

		// 3+4. ctx_note / ctx_memory through the registered tool surface.
		disposeTools = registerMagicContextToolsDsh(host, {
			db,
			sessionId: () => DSH_SESSION,
			projectDir,
			protectedTags: 20,
			promptSurfaceRuntime: createPromptSurfaceRuntime({ harness: "dsh", directory: projectDir, warn: () => {} }),
			memoryEnabled: true,
		});
		const noteReply = await callTool(host, "ctx_note", {
			action: "write",
			content: "US3 attribution checkpoint note.",
			note_ids: [],
		});
		expect(noteReply).toMatch(/^Saved session note #\d+\./);
		const memoryReply = await callTool(host, "ctx_memory", {
			action: "write",
			content: "Attribution audit rule: session-scoped writes must carry harness.",
			category: "PROJECT_RULES",
			ids: [],
		});
		expect(memoryReply).toMatch(/^Saved memory \[ID: \d+\] in PROJECT_RULES\.$/);

		// 5. History-index write: core message-index progress insert carries the
		//    harness column (see file header for why this is the reachable path).
		markMessageIndexDirty(db, DSH_SESSION, 4);
	});

	test("SELECT DISTINCT harness: 'dsh' on every session-scoped table this adapter writes", () => {
		const tables = ["session_meta", "pending_ops", "notes", "message_history_index"] as const;
		for (const table of tables) {
			const rows = db
				.prepare(`SELECT DISTINCT harness FROM ${table} WHERE session_id = ?`)
				.all(DSH_SESSION) as Array<{ harness: string }>;
			expect(rows.map((row) => row.harness), table).toEqual(["dsh"]);
		}
		// The store as a whole keeps the two harnesses distinct.
		const distinct = db
			.prepare("SELECT DISTINCT harness FROM session_meta ORDER BY harness")
			.all() as Array<{ harness: string }>;
		expect(distinct.map((row) => row.harness)).toContain("pi");
		expect(distinct.map((row) => row.harness)).toContain("dsh");
	});

	test("project-scoped writes carry no harness attribution (memories)", () => {
		const columns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
		expect(columns.some((column) => column.name === "harness")).toBe(false);
		const row = db
			.prepare("SELECT project_path, source_session_id FROM memories WHERE source_session_id = ?")
			.get(DSH_SESSION) as { project_path: string; source_session_id: string } | undefined;
		expect(row?.source_session_id).toBe(DSH_SESSION);
		expect(row?.project_path).toBe(resolveProjectIdentityForSession(projectDir));
	});

	test("cross-harness 'pi' rows are byte-identical after all adapter writes", () => {
		for (const { table, dump } of seedDumps) {
			const now =
				table === "pending_ops"
					? dumpRow("SELECT * FROM pending_ops WHERE session_id = ? AND tag_id = 9", PI_SESSION)
					: table === "notes"
						? dumpRow("SELECT * FROM notes WHERE session_id = ? AND content = 'pi-side note'", PI_SESSION)
						: dumpRow(`SELECT * FROM ${table} WHERE session_id = ?`, PI_SESSION);
			// Byte compare of the whole row, before vs. after the adapter ran.
			expect(now, table).toBe(dump);
		}
	});
});
