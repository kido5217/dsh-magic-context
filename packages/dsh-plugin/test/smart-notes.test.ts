/**
 * T065 — smart notes on DSH (FR-009). The note lane itself is covered by the
 * US2 tool tests; this file covers the smart-note layer the maintenance lane
 * promises to service: `surface_condition` is advertised only while the lane
 * is runnable, conditions compile through the shared (deterministic) compiler
 * with a plain-prose fallback, and ready notes surface in the read glance.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	addNote,
	markNoteReady,
} from "@magic-context/core/features/magic-context/storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { maintenanceRunnable } from "../src/maintenance/index.js";
import { registerMagicContextToolsDsh } from "../src/tools/index.js";
import { callTool, FakeToolHost } from "./double-stub.js";

const SESSION = "session-smart-notes";

let db: ContextDatabase;
let projectDir: string;
let projectIdentity: string;
let host: FakeToolHost;
let disposeTools: () => void;

function register(opts: { dreamerEnabled?: boolean }): FakeToolHost {
	const h = new FakeToolHost();
	const dispose = registerMagicContextToolsDsh(h as never, {
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
		dreamerEnabled: opts.dreamerEnabled,
	});
	return { host: h, dispose } as never;
}

let laneOff: { host: FakeToolHost; dispose: () => void };

beforeAll(async () => {
	setHarness("dsh");
	projectDir = mkdtempSync(join(tmpdir(), "mc-smart-"));
	projectIdentity = resolveProjectIdentityForSession(projectDir)!;
	db = (await openDatabaseAsync({
		dbPath: join(projectDir, "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	host = new FakeToolHost();
	disposeTools = registerMagicContextToolsDsh(host as never, {
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
		// The lane is runnable: the mount computed this from the config.
		dreamerEnabled: true,
	});
	laneOff = register({ dreamerEnabled: false }) as never;
});

afterAll(async () => {
	laneOff.dispose?.();
	disposeTools();
	rmSync(projectDir, { recursive: true, force: true });
	await closeDatabase();
});

describe("maintenance-runnable gate", () => {
	test("mirrors the mount: a dreamer block naming a DSH-side model route", () => {
		expect(maintenanceRunnable({})).toBe(false);
		expect(maintenanceRunnable({ dreamer: undefined })).toBe(false);
		expect(maintenanceRunnable({ dreamer: {} })).toBe(false);
		expect(maintenanceRunnable({ dreamer: { pi: { model: "p/m" } } })).toBe(
			true,
		);
		expect(maintenanceRunnable({ dreamer: { dsh: { model: "p/m" } } })).toBe(
			true,
		);
		expect(
			maintenanceRunnable({
				dreamer: { enabled: false, dsh: { model: "p/m" } },
			}),
		).toBe(false);
	});
});

describe("ctx_note smart layer", () => {
	test("surface_condition is advertised while the lane is runnable", () => {
		expect(JSON.stringify(host.tools.get("ctx_note"))).toContain(
			"surface_condition",
		);
	});

	test("without the lane the parameter disappears and prose never parks", async () => {
		expect(JSON.stringify(laneOff.host.tools.get("ctx_note"))).not.toContain(
			"surface_condition",
		);
		// A stale client still sending the parameter is refused loudly — never
		// silently parked where no evaluator exists.
		await expect(
			callTool(laneOff.host, "ctx_note", {
				action: "write",
				content: "rewrite the shard audit",
				surface_condition: 'when file "audit.log" contains "shard 7"',
			}),
		).rejects.toThrow(/require dreamer to be enabled/);
	});

	test("a machine-checkable condition compiles through the shared compiler", async () => {
		const reply = await callTool(host, "ctx_note", {
			action: "write",
			content: "ship the audit once the flag lands",
			surface_condition: 'when file "flags.json" contains "audit=true"',
		});
		expect(reply).toContain("Created smart note");
		const row = db
			.prepare(
				"SELECT type, project_path, surface_condition, compile_status, compiled_provider FROM notes ORDER BY id DESC LIMIT 1",
			)
			.get() as Record<string, unknown>;
		expect(row.type).toBe("smart");
		expect(row.project_path).toBe(projectIdentity);
		expect(row.compile_status).toBe("compiled");
		expect(row.compiled_provider).not.toBeNull();
	});

	test("plain prose is kept, flagged plain — dreamer still evaluates it", async () => {
		const reply = await callTool(host, "ctx_note", {
			action: "write",
			content: "check the vault audit lands",
			surface_condition: "the vault audit eventually passes",
		});
		expect(reply).toContain("Created smart note");
		const row = db
			.prepare(
				"SELECT compile_status, compiled_provider FROM notes ORDER BY id DESC LIMIT 1",
			)
			.get() as Record<string, unknown>;
		expect(row.compile_status).toBe("plain");
		expect(row.compiled_provider).toBeNull();
	});

	test("ready notes appear in the read glance; parked ones need the filter", async () => {
		const parked = addNote(db, "smart", {
			content: "parked: rotate shard keys when the ledger catches up",
			sessionId: SESSION,
			projectPath: projectIdentity,
			surfaceCondition: 'when file "ledger.txt" contains "caught up"',
		});
		const ready = addNote(db, "smart", {
			content: "ready: the archive flag rollout is verifiable now",
			sessionId: SESSION,
			projectPath: projectIdentity,
			surfaceCondition: 'when file "rollout.txt" contains "done"',
		});
		markNoteReady(db, ready.id, "condition held");
		// The glance carries every smart note with its status (core parity);
		// what matters is that the READY one is visible in the default read.
		const glance = (await callTool(host, "ctx_note", {
			action: "read",
		})) as string;
		expect(glance).toContain("archive flag rollout");
		expect(glance).toContain("rotate shard keys");
		const pending = (await callTool(host, "ctx_note", {
			action: "read",
			filter: "pending",
		})) as string;
		expect(pending).toContain("rotate shard keys");
		expect(pending).not.toContain("archive flag rollout");
		expect(parked.status).toBe("pending");
	});
});
