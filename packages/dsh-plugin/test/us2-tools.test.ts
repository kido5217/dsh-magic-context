/**
 * US2 tool-layer tests (T032): the five ctx_* tools over a REAL temp store.
 *
 * Covers the acceptance threads of the tool layer:
 *  - SC-002: ctx_expand returns stored originals byte-identically, including
 *    tool-argument JSON payloads (exact bytes, no reformatting).
 *  - FR-005: subagent sessions (a second sessionId with no raw provider yet)
 *    get the same five tools — no special-casing at registration.
 *  - SC-003: cross-harness continuity — ctx_search finds a memory seeded
 *    under a session whose session_meta.harness is 'opencode', same project.
 *  - Harness attribution: session-scoped writes (notes, pending ops) carry
 *    harness='dsh'; memories are project-scoped (no harness column).
 *  - Step-retry idempotence: ctx_reduce with the same args twice queues once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import type { DshHost } from "../src/host.js";
import { registerMagicContextToolsDsh } from "../src/tools/index.js";
import { callTool, FakeToolHost, fixtureProvider } from "./double-stub.js";

const SESSION = "us2-session-dsh";
/** A session owned by ANOTHER harness on the same project (SC-003 fixture). */
const FOREIGN_SESSION = "us2-session-opencode";

/** Original bytes the expand path must return untouched (SC-002). */
const TEXT_1 =
	"Rebase the branch on origin/master —\n  then push with `--force-with-lease`, ok?\n\ttrailing spaces kept   \n";
/** Key order + nested payload deliberate: proves no re-serialization reformats it. */
const TOOL_INPUT = {
	cwd: "/srv/app",
	command: "bun test --parallel=4",
	env: { LANG: "C.UTF-8", LC_ALL: "" },
} as const;
const TOOL_INPUT_JSON =
	'{"cwd":"/srv/app","command":"bun test --parallel=4","env":{"LANG":"C.UTF-8","LC_ALL":""}}';
const TOOL_OUTPUT = " 21 pass\n  0 fail  \n\n(done)\n";

const RAW_MESSAGES: RawMessage[] = [
	{
		ordinal: 1,
		id: "m1",
		role: "user",
		parts: [{ type: "text", text: TEXT_1 }],
	},
	{
		ordinal: 2,
		id: "m2",
		role: "assistant",
		parts: [
			{ type: "tool_use", name: "bash", id: "call-42", input: TOOL_INPUT },
		],
	},
	{
		ordinal: 3,
		id: "m3",
		role: "user",
		parts: [
			{ type: "tool_result", tool_use_id: "call-42", content: TOOL_OUTPUT },
		],
	},
	{
		ordinal: 4,
		id: "m4",
		role: "assistant",
		parts: [{ type: "text", text: "Rebase done; pushed." }],
	},
];

let db: ContextDatabase;
let projectIdentity: string;
let host: FakeToolHost;
let disposeTools: () => void;
let unregisterProvider: () => void;
const projectDir = mkdtempSync(join(tmpdir(), "dsh-us2-proj-"));

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
	}))!;
	expect(db).toBeTruthy();

	// Session rows get harness='dsh' from core stamping (setHarness above);
	// the foreign session is flipped to 'opencode' to model a memory written
	// from another harness on the shared store.
	getOrCreateSessionMeta(db, SESSION);
	getOrCreateSessionMeta(db, FOREIGN_SESSION);
	db.prepare(
		"UPDATE session_meta SET harness = 'opencode' WHERE session_id = ?",
	).run(FOREIGN_SESSION);

	// Tags via core storage (what the harness's transcript tagger would write):
	// §1 = text part of m1, §2 = the bash tool call (owner m2, result in m3).
	insertTag(
		db,
		SESSION,
		"m1",
		"message",
		new TextEncoder().encode(TEXT_1).length,
		1,
	);
	insertTag(
		db,
		SESSION,
		"call-42",
		"tool",
		128,
		2,
		0,
		"bash",
		TOOL_INPUT_JSON.length,
		"m2",
	);
	insertTag(db, SESSION, "m4", "message", 22, 3);

	unregisterProvider = setRawMessageProvider(
		SESSION,
		fixtureProvider(RAW_MESSAGES),
	);
	projectIdentity = resolveProjectIdentityForSession(projectDir)!;

	host = new FakeToolHost();
	disposeTools = registerMagicContextToolsDsh(host as unknown as DshHost, {
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
});

afterAll(async () => {
	disposeTools();
	unregisterProvider();
	rmSync(projectDir, { recursive: true, force: true });
	await closeDatabase();
});

describe("ctx_* registration", () => {
	test("registers the five ctx_* tools, all string-output", () => {
		expect([...host.tools.keys()].sort()).toEqual([
			"ctx_expand",
			"ctx_memory",
			"ctx_note",
			"ctx_reduce",
			"ctx_search",
		]);
		expect(host.registrationOrder).toEqual([
			"ctx_search",
			"ctx_memory",
			"ctx_note",
			"ctx_expand",
			"ctx_reduce",
		]);
		for (const tool of host.tools.values()) {
			expect(tool.output.schema).toEqual({ type: "string" });
			expect(tool.description.length).toBeGreaterThan(80);
		}
	});

	test("FR-005: a second (subagent-style) session registers the same five tools", async () => {
		const subHost = new FakeToolHost();
		const dispose = registerMagicContextToolsDsh(
			subHost as unknown as DshHost,
			{
				db,
				sessionId: () => FOREIGN_SESSION,
				projectDir,
				protectedTags: 20,
				promptSurfaceRuntime: createPromptSurfaceRuntime({
					harness: "dsh",
					directory: projectDir,
					warn: () => {},
				}),
			},
		);
		expect(subHost.registrationOrder).toEqual(host.registrationOrder);
		// The sessions layer registers a raw provider per session; until it has,
		// expand fails with a clear retry hint rather than misbehaving.
		await expect(callTool(subHost, "ctx_expand", { tag: 1 })).rejects.toThrow(
			/raw-history source/,
		);
		dispose();
		expect(subHost.disposedCount).toBe(5);
	});
});

describe("ctx_reduce", () => {
	test("queues drop ops for tagged items and is step-retry idempotent", async () => {
		const first = await callTool(host, "ctx_reduce", { drop: "1-3" });
		expect(first).toBe("3 tags stamped.");

		const rows = db
			.prepare(
				"SELECT tag_id, operation, harness FROM pending_ops WHERE session_id = ? ORDER BY tag_id",
			)
			.all(SESSION) as Array<{
			tag_id: number;
			operation: string;
			harness: string;
		}>;
		expect(rows.map((row) => [row.tag_id, row.operation])).toEqual([
			[1, "drop"],
			[2, "drop"],
			[3, "drop"],
		]);
		// Session-scoped write: core stamps the adapter harness on the queue.
		expect(rows.every((row) => row.harness === "dsh")).toBe(true);

		// Step-retry: identical call re-queues nothing and answers identically.
		const second = await callTool(host, "ctx_reduce", { drop: "1-3" });
		expect(second).toBe("3 tags stamped.");
		const count = db
			.prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
			.get(SESSION) as { n: number };
		expect(count.n).toBe(3);
	});

	test("unknown tags fail with a model-readable error", async () => {
		await expect(callTool(host, "ctx_reduce", { drop: "42" })).rejects.toThrow(
			/Unknown tag/,
		);
	});
});

describe("ctx_expand (SC-002 byte-identical recovery)", () => {
	test("text tag returns the stored original untouched", async () => {
		const out = await callTool(host, "ctx_expand", { tag: 1 });
		expect(out).toBe(`  [text]\n${TEXT_1}`);
	});

	test("tool tag returns input JSON and output as exact stored bytes", async () => {
		const out = await callTool(host, "ctx_expand", { tag: 2 });
		expect(out).toBe(
			[
				"  [tool: bash #call-42]",
				`  input: ${TOOL_INPUT_JSON}`,
				"  [tool: tool_result #call-42]",
				`  output:\n${TOOL_OUTPUT}`,
			].join("\n"),
		);
	});
});

describe("ctx_note", () => {
	test("write stores a session-scoped note with dsh harness attribution", async () => {
		const reply = await callTool(host, "ctx_note", {
			action: "write",
			content: "US2 checkpoint note\nSecond line with details.",
			note_ids: [],
		});
		expect(reply).toMatch(/^Saved session note #\d+\./);

		const row = db
			.prepare(
				"SELECT session_id, harness, type, status FROM notes WHERE content LIKE 'US2 checkpoint note%'",
			)
			.get() as {
			session_id: string;
			harness: string;
			type: string;
			status: string;
		};
		expect(row.session_id).toBe(SESSION);
		expect(row.harness).toBe("dsh");
		expect(row.type).toBe("session");
		expect(row.status).toBe("active");

		const glance = await callTool(host, "ctx_note", {
			action: "read",
			note_ids: [],
		});
		expect(glance).toContain("US2 checkpoint note");
	});
});

describe("ctx_memory", () => {
	const MEMORY_CONTENT =
		"The release lane pins bun 1.3.x; do not bump minors mid-RC.";
	let memoryId = 0;

	test("write stores a project-scoped memory attributed to the source session", async () => {
		const reply = await callTool(host, "ctx_memory", {
			action: "write",
			content: MEMORY_CONTENT,
			category: "PROJECT_RULES",
			ids: [],
		});
		const match = /^Saved memory \[ID: (\d+)\] in PROJECT_RULES\.$/.exec(reply);
		expect(match).not.toBeNull();
		memoryId = Number(match![1]);

		// Memories carry NO harness column by design: scope is the project
		// identity, and the source session provides session attribution.
		const row = db
			.prepare(
				"SELECT project_path, source_session_id, source_type, status FROM memories WHERE id = ?",
			)
			.get(memoryId) as {
			project_path: string;
			source_session_id: string;
			source_type: string;
			status: string;
		};
		expect(row.project_path).toBe(projectIdentity);
		expect(row.source_session_id).toBe(SESSION);
		expect(row.source_type).toBe("agent");
		expect(row.status).toBe("active");
	});

	test("identical rewrite dedups and bumps the seen count", async () => {
		const reply = await callTool(host, "ctx_memory", {
			action: "write",
			content: MEMORY_CONTENT,
			category: "PROJECT_RULES",
			ids: [],
		});
		expect(reply).toBe(
			`Memory already exists [ID: ${memoryId}] in PROJECT_RULES (seen count incremented).`,
		);
		const row = db
			.prepare("SELECT seen_count AS n FROM memories WHERE id = ?")
			.get(memoryId) as {
			n: number;
		};
		expect(row.n).toBe(2);
	});
});

describe("ctx_search (SC-003 cross-harness continuity)", () => {
	test("finds a memory seeded under an opencode-harness session on this project", async () => {
		insertMemory(db, {
			projectPath: projectIdentity,
			category: "CONFIG_VALUES",
			content:
				"The quetzal-cohort-7741 flag gates the shadow backfill rollout.",
			sourceSessionId: FOREIGN_SESSION,
			sourceType: "agent",
		});

		const reply = await callTool(host, "ctx_search", {
			query: "quetzal-cohort-7741",
			sources: ["memory"],
		});
		expect(reply).toContain("quetzal-cohort-7741");
	});

	test("missing query fails with a model-readable error", async () => {
		await expect(
			callTool(host, "ctx_search", { sources: ["memory"] }),
		).rejects.toThrow(/query' is required/);
	});
});
