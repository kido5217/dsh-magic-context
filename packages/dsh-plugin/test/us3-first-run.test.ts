/**
 * US3 first-run, zero-setup (T035, FR-010, SC-006).
 *
 * A brand-new shared store with ZERO pre-existing rows and a fresh project:
 * the adapter's only setup steps are openDatabase and the session mapping
 * upsert — no bootstrap, no config write, no user step beyond installation.
 * All five ctx_* tools then succeed on their FIRST call: ctx_search answers
 * an empty-but-successful result, note/memory writes land, expand recovers,
 * reduce queues, and one managed change consumes the queue cleanly.
 *
 * Uses its own brand-new database file (the isolation preload still pins
 * XDG paths, so the user's real store is unreachable) to model the state at
 * the exact moment of a first DSH session on a fresh install.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import {
	getPendingOps,
	removePendingOp,
} from "@magic-context/core/features/magic-context/storage-ops";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import type { PendingOp } from "@magic-context/core/features/magic-context/types";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { setHarness } from "@magic-context/core/shared/harness";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { SessionMapping } from "../src/sessions/mapping.js";
import { ManagedEdits } from "../src/surface/managed-edits.js";
import { registerMagicContextToolsDsh } from "../src/tools/index.js";
import { fixtureProvider } from "./double-stub.js";
import { callTool, McHost } from "./fixtures-dsh.js";

const SESSION = "us3-first-run-7741";
const ORIGINAL = "The very first user turn in this brand-new project.\n";

let db: ContextDatabase;
let storeDir: string;
let dbPath: string;
let projectDir: string;
let host: McHost;
let unregisterProvider: (() => void) | undefined;
let disposeTools: (() => void) | undefined;

function count(table: string): number {
	const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
		n: number;
	};
	return row.n;
}

beforeAll(async () => {
	setHarness("dsh");
	storeDir = mkdtempSync(join(tmpdir(), "dsh-us3-firstrun-store-"));
	dbPath = join(storeDir, "context.db");
	projectDir = mkdtempSync(join(tmpdir(), "dsh-us3-firstrun-proj-"));
});

afterAll(async () => {
	disposeTools?.();
	unregisterProvider?.();
	rmSync(storeDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
	await closeDatabase();
});

describe("FR-010: first session on a brand-new store needs no setup step", () => {
	test("the store opens with zero pre-existing rows", async () => {
		db = (await openDatabaseAsync({ dbPath }))!;
		expect(db).toBeTruthy();
		for (const table of [
			"session_meta",
			"tags",
			"notes",
			"pending_ops",
			"memories",
			"message_history_index",
		]) {
			expect(count(table), table).toBe(0);
		}
	});

	test("openDatabase + mapping upsert is the entire setup; all five tools succeed on first call", async () => {
		// The ONLY setup the adapter performs: map the session (idempotent
		// upsert). No bootstrap/setup API, no config file, no CLI step.
		const mapping = new SessionMapping(db);
		expect(mapping.upsert({ id: SESSION }).mcSession).toBe(SESSION);
		const meta = db
			.prepare("SELECT harness FROM session_meta WHERE session_id = ?")
			.get(SESSION) as { harness: string };
		expect(meta.harness).toBe("dsh");
		expect(count("tags")).toBe(0);
		expect(count("notes")).toBe(0);
		expect(count("memories")).toBe(0);

		host = new McHost();
		const session = host.addSession({ id: SESSION }, [0, 1, 2, 3]);
		disposeTools = registerMagicContextToolsDsh(host, {
			db,
			sessionId: () => SESSION,
			projectDir,
			protectedTags: 20,
			promptSurfaceRuntime: createPromptSurfaceRuntime({
				harness: "dsh",
				directory: projectDir,
				warn: () => {},
			}),
			memoryEnabled: true,
		});
		expect(host.registrationOrder).toEqual([
			"ctx_search",
			"ctx_memory",
			"ctx_note",
			"ctx_expand",
			"ctx_reduce",
		]);

		// 1. ctx_search: first call on a store with no history answers an
		//    empty-but-successful result (core formatSearchResults text).
		const emptySearch = await callTool(host, "ctx_search", {
			query: "first-run zebra probe",
			sources: ["memory"],
		});
		expect(emptySearch).toContain(
			'No results found for "first-run zebra probe"',
		);

		// 2. ctx_note: session-scoped write on a store that never saw a note.
		const noteReply = await callTool(host, "ctx_note", {
			action: "write",
			content: "First-run checkpoint note.",
			note_ids: [],
		});
		expect(noteReply).toMatch(/^Saved session note #\d+\./);

		// 3. ctx_memory: the project's very first memory.
		const memoryReply = await callTool(host, "ctx_memory", {
			action: "write",
			content: "First-run project rule: nothing to configure.",
			category: "PROJECT_RULES",
			ids: [],
		});
		expect(memoryReply).toMatch(
			/^Saved memory \[ID: \d+\] in PROJECT_RULES\.$/,
		);
		// The project identity resolves from the workspace dir alone.
		expect(resolveProjectIdentityForSession(projectDir)).toBeTruthy();

		// 4. ctx_expand: after the session's tagger stamped one item (runtime
		//    activity, not setup), the first expand returns the stored original.
		const bytes = new TextEncoder().encode(ORIGINAL).length;
		insertTag(db, SESSION, "m1", "message", bytes, 1);
		const raw: RawMessage[] = [
			{
				ordinal: 1,
				id: "m1",
				role: "user",
				parts: [{ type: "text", text: ORIGINAL }],
			},
		];
		unregisterProvider = setRawMessageProvider(SESSION, fixtureProvider(raw));
		const expanded = await callTool(host, "ctx_expand", { tag: 1 });
		expect(expanded).toContain(ORIGINAL.trimEnd());

		// 5. ctx_reduce: queues a drop; the first managed change consumes it.
		const reduceReply = await callTool(host, "ctx_reduce", { drop: "1" });
		expect(reduceReply).toBe("1 tag stamped.");
		const edits = new ManagedEdits(host);
		const shadow = await edits.runManagedChange(
			"drop",
			"chg-first-run",
			SESSION,
			{
				decision: async () => getPendingOps(db, SESSION),
				effect: async (ops: PendingOp[]) => {
					const targets = ops.map((op) => op.tagId);
					const { replacementSeq } = await session.replaceSurface(
						[{ type: "text", text: "[dropped §1§]" }],
						1,
						1,
						[1],
					);
					for (const tagId of targets) removePendingOp(db, SESSION, tagId);
					return { replacementSeq, shadowedSeqs: targets };
				},
			},
		);
		expect(shadow.replacementSeq).toBeTypeOf("number");
		expect(session.surfaceNodes()).toEqual([0, 2, 3, shadow.replacementSeq!]);
		expect(
			session.eventsOf("mc/manage-end").map((entry) => entry.data.shadowedSeqs),
		).toEqual([[1]]);
		expect(getPendingOps(db, SESSION)).toEqual([]);

		// No config write was required: nothing landed under the (isolated)
		// XDG config home; the only artifact is the database file itself.
		const configRoot = join(
			process.env.XDG_CONFIG_HOME ?? "nonexistent",
			"cortexkit",
		);
		expect(existsSync(configRoot)).toBe(false);
		expect(existsSync(dbPath)).toBe(true);
	});
});
