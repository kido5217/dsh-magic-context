/**
 * T065 — the maintenance lane end to end over fakes (no live host): the mount
 * wires the core scheduler/executors onto the DSH carriers, dispatches each
 * task by its declared transport (single-shot vs tool-loop), and a manual
 * `/ctx-dream` run leaves durable effects — classified memories, a run
 * record, an advanced schedule slot.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { getTaskScheduleState } from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { startMaintenance } from "../src/maintenance/index.js";

let db: ContextDatabase;
let projectDir: string;
let identity: string;
let handle: ReturnType<typeof startMaintenance>;
const streamModels: unknown[] = [];
const agentLaunches: { sessionId: string; meta: unknown }[] = [];

async function* fakeStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of chunks) yield chunk;
}

function fakeLlmStream(options: unknown): AsyncIterable<StreamChunk> {
	streamModels.push(options);
	const manifest = `<classify>${Array.from(
		{ length: 12 },
		(_, i) =>
			`<memory id="${String(i + 1)}" importance="70" scope="project" shareable="true"/>`,
	).join("")}</classify>`;
	return fakeStream([
		{ type: "text-delta", index: 0, text: manifest },
		{ type: "usage", usage: { inputTokens: 40, outputTokens: 12 } },
		{ type: "finish", reason: { kind: "stop" } as never },
	]);
}

const fakeCtx = {
	agents: {
		create: async (spec: { sessionId: string; meta: unknown }) => {
			agentLaunches.push({ sessionId: spec.sessionId, meta: spec.meta });
			return {
				agent: {
					id: spec.sessionId,
					session: { id: spec.sessionId },
					model: { select: () => {} },
					followup: () => {},
					whenIdle: async () => {},
					cancel: () => {},
				},
				dispose: () => {},
			};
		},
	},
	sessions: { flush: async () => {} },
	sessionQuery: { readSurface: async () => ({ events: [] }) },
} as never;

beforeAll(async () => {
	setHarness("dsh");
	projectDir = mkdtempSync(join(tmpdir(), "mc-tasks-"));
	identity = resolveProjectIdentityForSession(projectDir)!;
	db = (await openDatabaseAsync({
		dbPath: join(projectDir, "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	for (let i = 0; i < 12; i += 1)
		insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content: `Project fact ${String(i)}: the audit ledger binds shard ${String(i)} to the nightly export under a rotating retention window.`,
		});
	handle = startMaintenance({
		ctx: fakeCtx,
		llmStream: fakeLlmStream,
		db,
		config: {
			dreamer: {
				pi: { model: "mock/mock-dream" },
			},
		} as MagicContextConfig,
		projectDir,
		projectIdentity: identity,
	});
});

afterAll(async () => {
	handle.stop();
	rmSync(projectDir, { recursive: true, force: true });
	await closeDatabase();
});

describe("maintenance lane", () => {
	test("a manual classify run routes single-shot and lands durable effects", async () => {
		const result = await handle.runManual("classify-memories");
		expect(result.ran).toContain("classify-memories");
		expect(result.failed).toEqual([]);
		// The prompt rode the dreamer model, not the session model.
		expect(JSON.stringify(streamModels)).toContain("mock-dream");
		// Effect: every memory classified with the manifest importance.
		const rows = db.prepare("SELECT importance FROM memories").all() as {
			importance: number;
		}[];
		expect(rows.every((row) => row.importance === 70)).toBe(true);
		// Record + schedule advance.
		const runs = db
			.prepare(
				"SELECT tasks_json, tasks_succeeded FROM dream_runs ORDER BY rowid DESC LIMIT 1",
			)
			.get() as { tasks_json: string; tasks_succeeded: number };
		expect(runs.tasks_json).toContain("classify-memories");
		expect(runs.tasks_succeeded).toBeGreaterThanOrEqual(1);
		const state = getTaskScheduleState(db, identity, "classify-memories");
		expect(state?.lastStatus).toBe("completed");
	});

	test("a tool-loop task dispatches to the hidden-agent carrier", async () => {
		const result = await handle.runManual("map-memories");
		// The fake agent never produces an assistant turn, so the run may
		// fail — what the test pins is the routing decision itself.
		expect(
			result.ran.includes("map-memories") ||
				result.failed.includes("map-memories"),
			JSON.stringify(result),
		).toBe(true);
		expect(agentLaunches.length).toBeGreaterThanOrEqual(1);
		expect(agentLaunches[0].sessionId).toStartWith("session-mc-maint-");
		expect(agentLaunches[0].meta).toMatchObject({ origin: "subagent" });
	});

	test("compress-cues stays off while the mural lane is off", async () => {
		const result = await handle.runManual("compress-cues");
		// Core reports unavailable tasks with their reason attached.
		expect(
			(result.skipped ?? []).some(
				(entry) => entry.startsWith("compress-cues") && entry.includes("mural"),
			),
			JSON.stringify(result),
		).toBe(true);
		expect(result.ran).not.toContain("compress-cues");
	});
});
