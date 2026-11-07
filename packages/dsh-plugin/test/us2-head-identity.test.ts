/**
 * T048 — render identity: a baseline re-renders ONCE when the render
 * contract changes (routed model, config, epoch) and never on routine
 * passes. The identity digest rides the persisted pair fingerprint, so the
 * policy also holds across restarts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import type { HistorianRoute } from "../src/sessions/historian.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let projectDir: string;
const handles: AdapterHandle[] = [];

const records: readonly DshLogMessageRecord[] = [
	{
		seq: 1,
		messageId: "m-1",
		role: "user",
		text: "identity probe",
		createdAt: Date.UTC(2026, 0, 10),
	},
	{
		seq: 2,
		messageId: "m-2",
		role: "assistant",
		text: "probed",
		createdAt: Date.UTC(2026, 0, 10),
	},
];

let routed = { provider: "mock", model: "model-a" };
const route: HistorianRoute = {
	get provider() {
		return routed.provider;
	},
	get model() {
		return routed.model;
	},
	get imageInput() {
		return false;
	},
};

function pairHash(): string[] {
	const state = getOrCreateSessionMeta(db, "s-headident");
	return (state.systemPromptHash ?? "").split("|");
}

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-ident-proj-"));
	const memory = insertMemory(db, {
		projectPath: resolveProjectIdentityForSession(projectDir)!,
		category: "PROJECT_RULES",
		content: "Identity folds happen once.",
	});
	expect(memory.id).toBeGreaterThan(0);
});

afterAll(async () => {
	for (const handle of handles) await handle.dispose();
	handles.length = 0;
	await closeDatabase();
});

describe("render identity (T048)", () => {
	test("route change folds the baseline once; routine passes do not churn it", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({});
		const handle = mountAdapter(host, config, db, {
			readSessionLog: () => records,
			projectDir,
			historianRoute: route,
		});
		handles.push(handle);
		host.addSession({ id: "s-headident" });
		host.pressureReadings.set("s-headident", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});

		expect(
			await host.firePreStep({ sessionId: "s-headident", turn: 1, step: 1 }),
		).toBe("enter");
		const first = handle.head.peek("s-headident");
		expect(first).toBeDefined();
		expect(first!.identity).toBeDefined();
		const firstHash = pairHash();
		expect(firstHash.length).toBe(3); // baseline | delta | identity

		// A routine pass: nothing changed, the baseline node stays put.
		expect(
			await host.firePreStep({ sessionId: "s-headident", turn: 2, step: 2 }),
		).toBe("enter");
		expect(handle.head.peek("s-headident")!.seq).toBe(first!.seq);

		// Routed model changes: the render contract changed ⇒ exactly one
		// re-baseline — the pair's own nodes collapse into a new baseline.
		routed = { provider: "mock", model: "model-b" };
		expect(
			await host.firePreStep({ sessionId: "s-headident", turn: 3, step: 3 }),
		).toBe("enter");
		const folded = handle.head.peek("s-headident");
		expect(folded!.seq).not.toBe(first!.seq);
		expect(folded!.identity).not.toBe(first!.identity);
		const foldedHash = pairHash();
		expect(foldedHash[2] ?? "").toBe(folded!.identity ?? "");

		// And then it settles: the next routine pass leaves the baseline alone.
		expect(
			await host.firePreStep({ sessionId: "s-headident", turn: 4, step: 4 }),
		).toBe("enter");
		expect(handle.head.peek("s-headident")!.seq).toBe(folded!.seq);

		await handle.dispose();
		handles.pop();
	});
});
