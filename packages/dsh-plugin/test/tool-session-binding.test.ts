/**
 * Per-agent tool binding (T018): every ctx_* call acts on the session of the
 * agent that invoked it, never on a process-wide "last attached" guess.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage-ops";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import type { DshHost } from "../src/host.js";
import { registerMagicContextToolsDsh } from "../src/tools/index.js";
import { FakeToolHost } from "./double-stub.js";

const AGENT_A = "agent-session-a";
const AGENT_B = "agent-session-b";
const FALLBACK = "fallback-session";

let db: ContextDatabase;
let host: FakeToolHost;
let disposeTools: () => void;
const projectDir = mkdtempSync(join(tmpdir(), "dsh-tool-binding-"));

function execFor(agentId: string | undefined): ToolRunContext {
	return {
		callId: `call-${agentId ?? "none"}`,
		name: "ctx_reduce",
		arguments: { drop: "1" },
		signal: new AbortController().signal,
		...(agentId === undefined ? {} : { agent: { id: agentId } }),
		deferContext: () => {},
		concludeTurn: () => {},
	} as unknown as ToolRunContext;
}

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
	}))!;
	expect(db).toBeTruthy();
	for (const session of [AGENT_A, AGENT_B, FALLBACK]) {
		getOrCreateSessionMeta(db, session);
		insertTag(db, session, `m-${session}`, "message", 8, 1);
	}
	host = new FakeToolHost();
	disposeTools = registerMagicContextToolsDsh(host as unknown as DshHost, {
		db,
		sessionId: () => FALLBACK,
		projectDir,
		protectedTags: 20,
		promptSurfaceRuntime: createPromptSurfaceRuntime({
			harness: "dsh",
			directory: projectDir,
			warn: () => {},
		}),
	});
});

afterAll(async () => {
	disposeTools();
	await closeDatabase();
	rmSync(projectDir, { recursive: true, force: true });
});

async function reduceWith(agentId: string | undefined): Promise<void> {
	const tool = host.tools.get("ctx_reduce");
	if (!tool) throw new Error("ctx_reduce not registered");
	await tool.execute({ drop: "1" }, execFor(agentId));
}

describe("per-agent session binding", () => {
	test("an agent call lands on that agent's session only", async () => {
		await reduceWith(AGENT_A);
		expect(getPendingOps(db, AGENT_A).length).toBeGreaterThan(0);
		expect(getPendingOps(db, AGENT_B)).toHaveLength(0);
	});

	test("two agents in one process never cross sessions", async () => {
		await reduceWith(AGENT_B);
		expect(getPendingOps(db, AGENT_B).length).toBeGreaterThan(0);
		expect(getPendingOps(db, FALLBACK)).toHaveLength(0);
	});

	test("a call without an agent falls back only through the configured resolver", async () => {
		await reduceWith(undefined);
		expect(getPendingOps(db, FALLBACK).length).toBeGreaterThan(0);
	});
});
