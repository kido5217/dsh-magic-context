/**
 * Historical reasoning replay (T011) — live.
 *
 * Question: does a second request in the same session carry the first turn's
 * provider reasoning? It decides two things:
 *
 * 1. whether a reasoning-heavy session is reclaimable at all (the content the
 *    lane rewrites is the assistant BODY; the reasoning rides the host's
 *    replay state), and
 * 2. whether a body rewrite could ever leave a "reasoning without its answer"
 *    hole, which is why the core's drop path distinguishes a drop from a
 *    meaning-preserving rewrite.
 *
 * Method: two turns of one headless session (`--session-id` resumes; the flag
 * only errors on an UNKNOWN id), first reply carrying `reasoning_content`.
 * The mock provider records exact request bodies, so the second request's
 * assistant message is the observation.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createLiveHome, type LiveHome } from "./live-home.js";
import { MOCK_API_KEY_ENV, mockProviderEnv, startMockProvider } from "./mock-provider.js";

const provider = startMockProvider();
let home: LiveHome | undefined;

afterAll(() => {
	home?.dispose();
	provider.stop();
});

describe("reasoning replay", () => {
	test("a resumed turn re-sends the previous reasoning", async () => {
		home = createLiveHome({
			root: `${import.meta.dir}/../tmp/reasoning-replay`,
			route: {
				provider: "mock",
				baseURL: provider.baseURL,
				apiKeyEnv: MOCK_API_KEY_ENV,
				models: [{ id: "mock-model", contextWindow: 200_000 }],
			},
			defaultModel: "mock-model",
		});
		provider.script([
			{ thinking: "private chain of thought", text: "first answer" },
			{ text: "second answer" },
		]);
		const first = await home.runHeadlessAsync("first question", { env: mockProviderEnv() });
		expect(first.status).toBe(0);
		const sessionId = first.events.find((event) => event["type"] === "session")?.["sessionId"];
		expect(typeof sessionId).toBe("string");

		const second = await home.runHeadlessAsync("second question", {
			env: mockProviderEnv(),
			args: ["--session-id", String(sessionId)],
		});
		expect(second.status).toBe(0);

		// The request that carries conversation history (the first turn's own
		// request has no assistant message yet).
		const withHistory = provider.requests.findIndex((request) => {
			const messages = request.body["messages"];
			return Array.isArray(messages) && messages.some((message) => (message as { role?: string }).role === "assistant");
		});
		expect(withHistory).toBeGreaterThanOrEqual(0);
		const messages = provider.requests[withHistory]!.body["messages"] as { role: string; content?: unknown }[];
		const assistant = messages.find((message) => message.role === "assistant");
		expect(assistant).toBeDefined();
		// The body is replayed verbatim, and so is the provider's reasoning:
		// reasoning replay is host-owned and route-real, not something the
		// adapter can drop by rewriting content.
		expect(assistant!.content).toBe("first answer");
		expect(JSON.stringify(assistant)).toContain("private chain of thought");
	}, 240_000);
});
