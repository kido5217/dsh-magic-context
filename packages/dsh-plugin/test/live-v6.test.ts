/**
 * [T082 V6] Command surface, live. A real `dsh` child boots the plugin with
 * the commands bundle injected: the mount must reach the command registry
 * (hard injection — a missing bundle would fail the mount outright). Dispatch
 * of slash text is an interactive-surface behavior (spike T013: headless
 * forwards slash text to the model), so the handler BEHAVIOR is covered
 * in-process against the real store in test/commands.test.ts; this gate
 * proves the live registration path end to end.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
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

const EVIDENCE = `${import.meta.dir}/../tmp/evidence/v6-commands`;

describe("V6 live", () => {
	test("a real boot registers the six ctx commands on the command runtime", async () => {
		home = createLiveHome({
			root: `${import.meta.dir}/../tmp/live-v6`,
			route: {
				provider: "mock",
				baseURL: provider.baseURL,
				apiKeyEnv: MOCK_API_KEY_ENV,
				models: [{ id: "mock-model", contextWindow: 200_000 }],
			},
			defaultModel: "mock-model",
		});
		provider.script([{ text: "v6 boot" }]);
		const run = await home.runHeadlessAsync("v6 gate", {
			env: mockProviderEnv(),
		});
		expect(run.status).toBe(0);
		expect(run.stderr).toContain(
			"[dsh-magic-context] commands registered: ctx-status",
		);
		for (const name of [
			"ctx-flush",
			"ctx-embed",
			"ctx-recomp",
			"ctx-wrapup",
			"ctx-dream",
		])
			expect(run.stderr).toContain(name);
		mkdirSync(EVIDENCE, { recursive: true });
		writeFileSync(
			`${EVIDENCE}/v6-evidence.json`,
			JSON.stringify(
				{
					verifiedAt: new Date().toISOString(),
					mechanism:
						"live child boot; hard-injected commands bundle; handler behavior covered in-process (test/commands.test.ts) per T013 spike (headless does not dispatch)",
					stderrLine: run.stderr
						.split("\n")
						.find((line) => line.includes("commands registered")),
				},
				null,
				2,
			),
		);
	}, 90_000);
});
