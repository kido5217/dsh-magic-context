/**
 * Post-execute durability spike (T008).
 *
 * Question: does a `tools/post-execute` rewrite change the PERSISTED tool
 * result — or only what a listener observes?
 *
 * Source-verified against the installed host (`dsh-tools/lib/pipeline.js`,
 * `postExecute`): the waterfall's `accept` decision replaces `result.content`
 * BEFORE the result is returned to the agent loop, and the loop is what appends
 * the `tool/result` event. So a content replacement is durable: it is the
 * result the model sees on the next request and the result the session log
 * holds. A `value` replacement re-renders the tool's canonical value; `block`
 * turns the call into an error result.
 *
 * What this spike pins in OUR seam (host.ts `onPostToolExecute`):
 * - a verdict replaces content and keeps the rest of the decision intact;
 * - additional context rides along as a user message for the next request;
 * - failing to produce a verdict leaves the result untouched;
 * - the listener is fiber-scoped (no orphan handle after unmount).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { mountAdapter, type AdapterHandle } from "../src/index.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let handle: AdapterHandle | undefined;
let host: TestDshHost;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db"), nativeTurnDeadlines: true }))!;
});

afterAll(async () => {
	await handle?.dispose();
	await closeDatabase();
});

describe("post-execute verdict", () => {
	test("a content verdict is the durable rewrite; no verdict leaves the result alone", async () => {
		host = new TestDshHost();
		handle = mountAdapter(host, MagicContextConfigSchema.parse({}), db);
		const off = host.onPostToolExecute((info) =>
			info.toolName === "read" ? { content: [{ type: "text", text: "[dropped §7§]" }] } : undefined,
		);
		const rewritten = await host.firePostTool({ sessionId: "s-pe", toolName: "read", text: "huge output" });
		expect(rewritten?.content).toEqual([{ type: "text", text: "[dropped §7§]" }]);
		const untouched = await host.firePostTool({ sessionId: "s-pe", toolName: "grep", text: "huge output" });
		expect(untouched).toBeUndefined();
		off();
	});

	test("additional context rides the same decision", async () => {
		const off = host.onPostToolExecute(() => ({ additionalContext: [{ type: "text", text: "nudge" }] }));
		const verdict = await host.firePostTool({ sessionId: "s-pe", toolName: "read", text: "out" });
		expect(verdict?.additionalContext).toEqual([{ type: "text", text: "nudge" }]);
		off();
	});

	test("the listener is fiber-scoped: unmount leaves no orphan", async () => {
		const before = host.liveHandleCount();
		const off = host.onPostToolExecute(() => undefined);
		expect(host.liveHandleCount()).toBe(before + 1);
		off();
		await handle!.dispose();
		handle = undefined;
		expect(host.liveHandleCount()).toBe(0);
	});
});
