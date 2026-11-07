/**
 * V1 live gate (T039, first half): a DSH session actually shrinks.
 *
 * Drives a real `dsh` headless session against the mock provider with a small
 * advertised window and provider-reported pressure in the execute band, then
 * resumes the session. The observation is the second request's message list:
 * Magic Context must have replaced reclaimable history with its canonical
 * placeholders, and the store must show the tag as dropped.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createLiveHome, type LiveHome } from "./live-home.js";
import {
	MOCK_API_KEY_ENV,
	mockProviderEnv,
	startMockProvider,
} from "./mock-provider.js";

const provider = startMockProvider();
let home: LiveHome | undefined;

afterAll(() => {
	home?.dispose();
	provider.stop();
});

const BIG_FILE = `${import.meta.dir}/fixtures-dsh.ts`;

describe("V1 live", () => {
	test("a resumed session serves placeholders instead of reclaimed history", async () => {
		home = createLiveHome({
			root: `${import.meta.dir}/../tmp/live-v1`,
			route: {
				provider: "mock",
				baseURL: provider.baseURL,
				apiKeyEnv: MOCK_API_KEY_ENV,
				models: [{ id: "mock-model", contextWindow: 10_000 }],
			},
			defaultModel: "mock-model",
		});
		// Turn 1: read a real file (a real tool result with real bytes), then
		// answer — with provider pressure already in the execute band so the
		// next pass has permission to reclaim.
		provider.script([
			{
				toolCalls: [
					{ name: "read", arguments: JSON.stringify({ path: BIG_FILE }) },
				],
				promptTokens: 7_000,
			},
			{ text: "read it", promptTokens: 7_500 },
			{ text: "second answer", promptTokens: 7_500 },
		]);
		const first = await home.runHeadlessAsync("read the fixtures file", {
			env: mockProviderEnv(),
		});
		expect(first.status).toBe(0);
		// A live child must run as production: the test backstop means MC was
		// disabled, and a gate against a disabled plugin proves nothing.
		expect(first.stderr).not.toContain("TEST BACKSTOP");
		expect(first.stderr).not.toContain("storage unavailable");
		const sessionId = first.events.find(
			(event) => event["type"] === "session",
		)?.["sessionId"];
		expect(typeof sessionId).toBe("string");

		const second = await home.runHeadlessAsync("continue", {
			env: mockProviderEnv(),
			args: ["--session-id", String(sessionId)],
		});
		expect(second.status).toBe(0);

		// The request carrying history is the last one.
		const withHistory = [...provider.requests].reverse().find((request) => {
			const messages = request.body["messages"];
			return (
				Array.isArray(messages) &&
				messages.some(
					(message) => (message as { role?: string }).role === "tool",
				)
			);
		});
		expect(withHistory).toBeDefined();
		const serialized = JSON.stringify(withHistory!.body["messages"]);
		// Diagnostics first: the gate must fail loudly if MC did nothing.
		const { Database } = await import("bun:sqlite");
		const dbPath = `${home.home}/data/cortexkit/magic-context/context.db`;
		const db = new Database(dbPath, { readonly: true });
		const rows = db
			.prepare(
				"SELECT session_id, type, status, count(*) AS n FROM tags GROUP BY session_id, type, status",
			)
			.all() as {
			session_id: string;
			type: string;
			status: string;
			n: number;
		}[];
		const compartments = db
			.prepare("SELECT count(*) AS n FROM compartments")
			.get() as { n: number };
		db.close();

		// Either the tool output was replaced by the canonical placeholder or the
		// node was folded away entirely; what must NOT survive is the full body.
		const replaced = serialized.includes("[dropped §");
		const foldedAway = !serialized.includes("export interface FakeLogEntry");
		// MC must have decided something, and the store must show it: this is the
		// difference between "the bytes are gone" and "the bytes are gone because
		// the lanes ran".
		expect(rows.some((row) => row.status === "dropped")).toBe(true);
		expect(replaced || foldedAway).toBe(true);
		// With a reclaimable tool result in the tail, the canonical placeholder is
		// what replaces it (a fold would have published a compartment instead).
		expect(replaced).toBe(true);
		// T005's live half: a TOOL RESULT rewritten in place reaches the next
		// request as a tool message carrying the placeholder — the call identity
		// survived (the message is still `tool`, not a user notice).
		const toolWithPlaceholder = (
			withHistory!.body["messages"] as { role?: string; content?: unknown }[]
		).some(
			(message) =>
				message.role === "tool" &&
				JSON.stringify(message.content ?? "").includes("[dropped §"),
		);
		expect(toolWithPlaceholder).toBe(true);
		expect(compartments.n).toBe(0);
	}, 300_000);
});
