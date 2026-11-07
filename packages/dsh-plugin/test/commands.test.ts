/**
 * [T068–T071] The command surface in-process: definitions registered, handlers
 * wired to the shared services, and results shaped for the durable command UI.
 */

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { setHarness } from "@magic-context/core/shared/harness";
import { type CommandDeps, registerCommands } from "../src/commands/index.js";

let db: ContextDatabase;
const SESSION = "session-command-test";
const definitions = new Map<string, CommandDefinition>();
let dispose: (() => void) | undefined;

const lanesStub = {
	manualFold: async (
		sessionId: string,
		opts: { fullRebuild?: boolean; keepMessages?: number },
	) =>
		`fold ${sessionId} rebuild=${String(opts.fullRebuild === true)} keep=${String(opts.keepMessages ?? "auto")}`,
	requestEmbedBackfill: () => "Backfill requested for this session",
} as unknown as CommandDeps["lanes"];

function mount(deps: Partial<CommandDeps> = {}): void {
	dispose = registerCommands({
		db,
		config: {} as MagicContextConfig,
		lanes: lanesStub,
		version: "0.0.0-test",
		projectDir: "/project",
		maintenance: () => undefined,
		register: (definition) => {
			definitions.set(definition.name, definition);
			return () => definitions.delete(definition.name);
		},
		...deps,
	});
}

function invoke(
	name: string,
	rawInput = "",
): Promise<{ kind: string; text?: string }> {
	const definition = definitions.get(name);
	if (definition === undefined)
		throw new Error(`command ${name} not registered`);
	return Promise.resolve(
		definition.handler({
			commandId: "cmd-1" as never,
			agent: { session: { id: SESSION } } as never,
			rawInput,
			attachments: [],
			signal: new AbortController().signal,
		}),
	);
}

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(mkdtempSync(join(tmpdir(), "mc-cmd-")), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	updateSessionMeta(db, SESSION, {
		lastInputTokens: 30_000,
		lastContextPercentage: 42,
		lastUsageContextLimit: 70_000,
	});
	insertMemory(db, {
		projectPath: "/project",
		category: "PROJECT_RULES",
		content: "Commands share the store.",
	});
	mount();
});

afterEach(() => {
	// keep the registry clean between tests when a case disposes
});

describe("ctx command registration", () => {
	test("all six commands register with branded identities", () => {
		expect([...definitions.keys()].sort()).toEqual(
			[
				"ctx-dream",
				"ctx-embed",
				"ctx-flush",
				"ctx-recomp",
				"ctx-status",
				"ctx-wrapup",
			].sort(),
		);
		for (const definition of definitions.values())
			expect(definition.definitionId).toStartWith(
				"cortexkit.dsh-magic-context.",
			);
	});

	test("disposing unregisters every command", () => {
		dispose?.();
		expect(definitions.size).toBe(0);
		mount();
	});
});

describe("ctx command handlers", () => {
	test("ctx-status renders the shared view from persisted counters", async () => {
		const result = await invoke("ctx-status");
		expect(result.kind).toBe("success");
		expect(result.text).toStartWith("## ");
		expect(result.text).not.toContain("status fields missing");
		// 42% pressure and the persisted reading reach the view.
		expect(result.text).toContain("42");
	});

	test("ctx-flush runs the shared pending-op flush", async () => {
		const result = await invoke("ctx-flush");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("No pending operations");
	});

	test("ctx-embed forwards to the managed backfill", async () => {
		const result = await invoke("ctx-embed", "start");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("Backfill requested");
	});

	test("ctx-recomp and ctx-wrapup run manual folds", async () => {
		const recomp = await invoke("ctx-recomp");
		expect(recomp.text).toContain("rebuild=true");
		const wrapup = await invoke("ctx-wrapup", "5");
		expect(wrapup.text).toContain("rebuild=false keep=5");
		const dflt = await invoke("ctx-wrapup");
		expect(dflt.text).toContain("keep=10");
	});

	test("ctx-dream reports the lane status without a maintenance handle", async () => {
		const result = await invoke("ctx-dream");
		expect(result.kind).toBe("error");
		expect(result.text).toContain("Maintenance is not running");
	});

	test("ctx-dream runs the manual runner and reports the outcome", async () => {
		mount({
			maintenance: () => ({
				runManual: async () => ({
					ran: ["classify-memories"],
					skippedNoWork: ["compress-cues"],
					skipped: ["review-user-memories: below floor"],
					deferredBusy: [],
					failed: [],
				}),
			}),
		});
		const result = await invoke("ctx-dream", "classify-memories");
		expect(result.kind).toBe("success");
		expect(result.text).toContain("Ran: classify-memories");
		expect(result.text).toContain("Skipped (no work): compress-cues");
		expect(result.text).toContain("Skipped: review-user-memories: below floor");
	});
});
