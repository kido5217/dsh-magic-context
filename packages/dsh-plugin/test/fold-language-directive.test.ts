/**
 * F-07: the interactive historian's fold threads the user-level `language`.
 *
 * The core expresses the language on the historian call through the SYSTEM
 * prompt (`withContentLanguageDirective(COMPARTMENT_AGENT_SYSTEM_PROMPT, …)`
 * in compartment-runner-historian's runHistorianPrompt and the incremental
 * runner), never in the transcript body. These tests pin the DSH seam to the
 * same shape: with `language: "de"` the captured aux call carries the core
 * output-language directive naming German (Deutsch); with no language the
 * system prompt stays byte-identical to the core prompt (no directive).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ManualCompactAgentContext } from "@deepseek-ai/dsh-compaction";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { COMPARTMENT_AGENT_SYSTEM_PROMPT } from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import type { McCompactionClaim } from "../src/compaction-claim.js";
import { mountAdapter } from "../src/index.js";
import { TestDshHost } from "./double.js";
import { seedSession, stepFor } from "./us1-support.js";

let db: ContextDatabase;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
});

afterAll(async () => {
	await closeDatabase();
});

/** One macrotask turn: Cordis services publish on their async init. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function agentFor(sessionId: string): ManualCompactAgentContext {
	return {
		session: { id: sessionId },
		options: {},
		runMaintenance: async (
			task: (signal: AbortSignal) => Promise<unknown>,
		): Promise<unknown> => task(new AbortController().signal),
	} as unknown as ManualCompactAgentContext;
}

/** Mount, fold once through the manual lane, return the aux call's system. */
async function foldSystemPrompt(
	sessionId: string,
	language?: string,
): Promise<string> {
	const host = new TestDshHost();
	seedSession(host, sessionId, 10);
	const handle = mountAdapter(
		host,
		MagicContextConfigSchema.parse(language === undefined ? {} : { language }),
		db,
		{
			readSessionLog: (id) => host.sessions.get(id)?.logRecords() ?? [],
			historianRoute: { provider: "aux", model: "hist-1" },
		},
	);
	await settle();
	const engine = host.ctx.reflect.get("compaction") as McCompactionClaim;
	await host.firePreStep(stepFor(sessionId));
	host.pressureReadings.set(sessionId, {
		pressureTokens: 5_000,
		contextWindow: 10_000,
	});
	host.llmResponder = () => ({ text: "folded history summary body" });
	await engine.compactNow(agentFor(sessionId), new AbortController().signal);
	const call = host.llmOptions.find(
		(options) => options.purpose === "magic-context",
	);
	await handle.dispose();
	if (call === undefined)
		throw new Error("the fold made no magic-context aux call");
	return typeof call.system === "string"
		? call.system
		: JSON.stringify(call.system);
}

describe("fold language threading (F-07)", () => {
	test("config.language adds the core output-language directive to the fold call", async () => {
		const system = await foldSystemPrompt("s-fold-lang-de", "de");
		expect(system).toContain("## Output language");
		expect(system).toContain(
			"Write human-readable prose you author in: German (Deutsch)",
		);
	});

	test("without language the system prompt is the untouched core prompt", async () => {
		const system = await foldSystemPrompt("s-fold-lang-none");
		expect(system).toBe(COMPARTMENT_AGENT_SYSTEM_PROMPT);
	});
});
