/**
 * Live harness smoke (Phase 2 prerequisite for T004–T013 live halves).
 *
 * Proves the isolated home + mock provider pair actually drives a real `dsh`
 * headless turn and that the request the host assembled is observable. Every
 * later live gate depends on this plumbing; if it breaks, the gates must fail
 * loudly rather than silently skip.
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

describe("live harness", () => {
	test("a headless turn reaches the mock provider", async () => {
		home = createLiveHome({
			root: `${import.meta.dir}/../tmp/live-harness`,
			route: {
				provider: "mock",
				baseURL: provider.baseURL,
				apiKeyEnv: MOCK_API_KEY_ENV,
				models: [{ id: "mock-model", contextWindow: 200_000 }],
			},
			defaultModel: "mock-model",
		});
		provider.script([{ text: "hello from the mock" }]);
		const result = await home.runHeadlessAsync("say hello", { env: mockProviderEnv() });
		expect(result.status).toBe(0);
		expect(provider.requests.length).toBeGreaterThan(0);
		const messages = provider.messagesOf(0);
		// The host sends the system prompt plus the user turn.
		expect(messages.some((message) => message["role"] === "user")).toBe(true);
		expect(result.stdout.length).toBeGreaterThan(0);
	}, 180_000);
});
