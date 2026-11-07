/**
 * US3 cross-harness continuity (T034, SC-003, quickstart V3).
 *
 * Both directions on ONE machine store (the shared context.db the preload
 * pins):
 *  (a) a memory seeded under an OpenCode-harness session is found by the DSH
 *      session's ctx_search — matched on content, not just an id;
 *  (b) a memory written by the DSH ctx_memory tool is returned by the
 *      OpenCode-side read path: the core query packages/plugin itself runs
 *      on the memory lane (`getMemoriesByProject`, see
 *      packages/plugin/src/features/magic-context/search.ts — searchMemories
 *      → getMemoriesByProject(db, projectPath)); memories are project-scoped
 *      (no harness column), so the project identity is the join.
 *
 * Plus the id-collision probe: a DSH session whose durable id string equals
 * an existing OpenCode session id. The store keys session_meta by session_id,
 * so the adapter's INSERT-OR-IGNORE upsert preserves the pre-existing row
 * (attribution not stolen) and the harness column separates the coexisting
 * rows in the session-scoped write tables (pending_ops / notes /
 * message_history_index carry both harnesses under the same id); reads stay
 * scoped per harness.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { markMessageIndexDirty } from "@magic-context/core/features/magic-context/message-index";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { SessionMapping } from "../src/sessions/mapping.js";
import { registerMagicContextToolsDsh } from "../src/tools/index.js";
import { callTool, McHost } from "./fixtures-dsh.js";

const OC_SESSION = "us3-cont-opencode-7741";
const DSH_SESSION = "us3-cont-dsh-7741";
/** Id shared deliberately by an OpenCode row and the colliding DSH session. */
const COLLIDING_ID = "us3-cont-shared-7741";
const INBOUND = "The marbled-teal-3309 flag gates the continuity rollout.";
const OUTBOUND =
	"DSH-side rule: continuity tests must not touch the user's shared store.";

let db: ContextDatabase;
let projectDir: string;
let projectIdentity: string;
let host: McHost;
let mapping: SessionMapping;
let disposeTools: () => void;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
	}))!;
	expect(db).toBeTruthy();
	projectDir = mkdtempSync(join(tmpdir(), "dsh-us3-cont-proj-"));
	projectIdentity = resolveProjectIdentityForSession(projectDir)!;

	host = new McHost();
	host.addSession({ id: DSH_SESSION });
	mapping = new SessionMapping(db);
	mapping.upsert({ id: DSH_SESSION });
	disposeTools = registerMagicContextToolsDsh(host, {
		db,
		sessionId: () => DSH_SESSION,
		projectDir,
		protectedTags: 20,
		promptSurfaceRuntime: createPromptSurfaceRuntime({
			harness: "dsh",
			directory: projectDir,
			warn: () => {},
		}),
		memoryEnabled: true,
	});
});

afterAll(async () => {
	disposeTools?.();
	rmSync(projectDir, { recursive: true, force: true });
	await closeDatabase();
});

describe("OpenCode → DSH (V3 inbound)", () => {
	test("ctx_search from the DSH session finds a memory seeded by an opencode-harness session", () => {
		// Session row attributed to the OpenCode harness (written there).
		getOrCreateSessionMeta(db, OC_SESSION);
		db.prepare(
			"UPDATE session_meta SET harness = 'opencode' WHERE session_id = ?",
		).run(OC_SESSION);
		insertMemory(db, {
			projectPath: projectIdentity,
			category: "CONFIG_VALUES",
			content: INBOUND,
			sourceSessionId: OC_SESSION,
			sourceType: "agent",
		});
	});

	test("the DSH ctx_search reply carries the memory's content, not just an id", async () => {
		const reply = await callTool(host, "ctx_search", {
			query: "marbled-teal-3309",
			sources: ["memory"],
		});
		expect(reply).toContain("marbled-teal-3309");
		expect(reply).toContain("gates the continuity rollout");
	});
});

describe("DSH → OpenCode (V3 outbound)", () => {
	test("ctx_memory records the DSH-side memory", async () => {
		const reply = await callTool(host, "ctx_memory", {
			action: "write",
			content: OUTBOUND,
			category: "PROJECT_RULES",
			ids: [],
		});
		expect(reply).toMatch(/^Saved memory \[ID: \d+\] in PROJECT_RULES\.$/);
	});

	test("the OpenCode memory-list read path returns the DSH-written memory", () => {
		// Exactly how packages/plugin reads the memory lane (searchMemories →
		// getMemoriesByProject(db, projectPath)); memories carry no harness
		// column, so the other harness sees them through the project identity.
		const memories = getMemoriesByProject(db, projectIdentity);
		const mine = memories.find((memory) => memory.content === OUTBOUND);
		expect(mine).toBeDefined();
		expect(mine!.sourceSessionId).toBe(DSH_SESSION);
		expect(mine!.projectPath).toBe(projectIdentity);
		expect(mine!.status).toBe("active");
	});
});

describe("session-id collision probe", () => {
	test("a DSH session id equal to an existing opencode session id separates by harness and stays scoped", async () => {
		// Pre-existing OpenCode ownership of the id: session_meta row + its own
		// session-scoped rows.
		db.prepare(
			"INSERT INTO session_meta (session_id, harness) VALUES (?, 'opencode')",
		).run(COLLIDING_ID);
		db.prepare(
			"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', ?, 'opencode')",
		).run(COLLIDING_ID, 1_700_000_000_000);
		db.prepare(
			"INSERT INTO notes (type, status, content, session_id, created_at, updated_at, harness) VALUES ('session', 'active', 'opencode-side note under colliding id', ?, ?, ?, 'opencode')",
		).run(COLLIDING_ID, 1_700_000_000_000, 1_700_000_000_000);

		// The DSH adapter maps the same id string: the upsert is idempotent and
		// does not throw; INSERT-OR-IGNORE preserves the existing session_meta
		// row (the adapter does not steal another harness's attribution).
		const collided = mapping.upsert({ id: COLLIDING_ID });
		expect(collided.dshSessionId).toBe(COLLIDING_ID);
		const metaRows = db
			.prepare(
				"SELECT harness, COUNT(*) AS n FROM session_meta WHERE session_id = ? GROUP BY harness",
			)
			.all(COLLIDING_ID) as Array<{ harness: string; n: number }>;
		expect(metaRows).toEqual([{ harness: "opencode", n: 1 }]);

		// DSH-side writes under the colliding id.
		const collideHost = new McHost();
		collideHost.addSession({ id: COLLIDING_ID });
		const disposeCollide = registerMagicContextToolsDsh(collideHost, {
			db,
			sessionId: () => COLLIDING_ID,
			projectDir,
			protectedTags: 20,
			promptSurfaceRuntime: createPromptSurfaceRuntime({
				harness: "dsh",
				directory: projectDir,
				warn: () => {},
			}),
		});
		await callTool(collideHost, "ctx_note", {
			action: "write",
			content: "dsh-side note under colliding id",
			note_ids: [],
		});
		queuePendingOp(db, COLLIDING_ID, 2, "drop");
		markMessageIndexDirty(db, COLLIDING_ID, 1);

		// Both harnesses' rows coexist under the same session id; the harness
		// column is what separates them in the session-scoped write tables.
		const ops = db
			.prepare(
				"SELECT tag_id, harness FROM pending_ops WHERE session_id = ? ORDER BY harness",
			)
			.all(COLLIDING_ID) as Array<{ tag_id: number; harness: string }>;
		expect(ops).toEqual([
			{ tag_id: 2, harness: "dsh" },
			{ tag_id: 1, harness: "opencode" },
		]);
		const noteHarnesses = db
			.prepare(
				"SELECT DISTINCT harness FROM notes WHERE session_id = ? ORDER BY harness",
			)
			.all(COLLIDING_ID) as Array<{ harness: string }>;
		expect(noteHarnesses.map((row) => row.harness)).toEqual([
			"dsh",
			"opencode",
		]);
		const indexRow = db
			.prepare("SELECT harness FROM message_history_index WHERE session_id = ?")
			.get(COLLIDING_ID) as { harness: string };
		expect(indexRow.harness).toBe("dsh");

		// Scoped reads: each harness's session-scoped view sees only its rows…
		const dshOnly = db
			.prepare(
				"SELECT tag_id FROM pending_ops WHERE session_id = ? AND harness = 'dsh'",
			)
			.all(COLLIDING_ID) as Array<{ tag_id: number }>;
		expect(dshOnly).toEqual([{ tag_id: 2 }]);
		// …and the project-scoped search lane still works for the colliding
		// session (continuity is unaffected by the id overlap).
		const reply = await callTool(collideHost, "ctx_search", {
			query: "marbled-teal-3309",
			sources: ["memory"],
		});
		expect(reply).toContain("marbled-teal-3309");
		disposeCollide();
	});
});
