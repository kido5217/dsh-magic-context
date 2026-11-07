/**
 * Command surface spike (T013) — live.
 *
 * Question: does a non-web DSH profile give a plugin a way to have a slash
 * command EXECUTED, or only registered?
 *
 * The headless profile composes the `commands` bundle (verified from its
 * composed tree: `- id: commands` / `@deepseek-ai/dsh-commands`), so
 * `ctx.commands` is injectable. But the headless APP does not dispatch slash
 * text: it passes the prompt to the model like any other text. This test proves
 * that by driving a real `dsh` process against a mock provider and checking
 * that `/something` arrived as a user message instead of a command invocation.
 *
 * Consequence for US4: command e2e must invoke the registered handler
 * in-process (quickstart V7's documented fallback), while registration and
 * descriptor shape are asserted against the live `CommandRuntime`.
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

describe("command surface", () => {
	test("headless treats slash text as a prompt, not a command", async () => {
		home = createLiveHome({
			root: `${import.meta.dir}/../tmp/command-surface`,
			route: {
				provider: "mock",
				baseURL: provider.baseURL,
				apiKeyEnv: MOCK_API_KEY_ENV,
				models: [{ id: "mock-model", contextWindow: 200_000 }],
			},
			defaultModel: "mock-model",
		});
		provider.script([{ text: "ok" }]);
		const result = await home.runHeadlessAsync("/ctx-status", {
			env: mockProviderEnv(),
		});
		expect(result.status).toBe(0);
		const messages = provider.messagesOf(0);
		const userText = messages
			.filter((message) => message["role"] === "user")
			.map((message) =>
				typeof message["content"] === "string"
					? message["content"]
					: JSON.stringify(message["content"]),
			)
			.join("\n");
		// The text reached the model: the app did not intercept it.
		expect(userText).toContain("/ctx-status");
		// No command/run event was written: nothing executed it.
		expect(result.stdout).not.toContain("command/run");
	}, 180_000);
});
