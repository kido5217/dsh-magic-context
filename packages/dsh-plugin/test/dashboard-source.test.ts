/**
 * Dashboard source spike (T012) — live.
 *
 * Question: where does the dashboard read a DSH session's title and messages
 * from — the MC store, or the host's own persisted log?
 *
 * A real headless turn is driven against the mock provider, then the host's
 * persisted session is located under the isolated `DSH_HOME`. The answer this
 * pins (implementation choice recorded in `gate-evidence/spike-dashboard-source.md`):
 *
 *   `$DSH_HOME/sessions/<cwd-slug>/<sessionId>/session.v4.jsonl.zstd`
 *
 * — a zstd-compressed JSONL event log, one event per line, with the same
 * `type`/`seq`/`data` vocabulary the session store replays. The dashboard must
 * read THAT for messages (it is the host's own transcript, including assistant
 * text that MC never stores), and the MC store only for attribution
 * (`harness`, session mapping, tags/compartments).
 *
 * The test asserts the path shape, the zstd frame, and the decoded event
 * vocabulary, so a host upgrade that moves the store fails loudly here rather
 * than silently emptying the dashboard.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

/** Locate the one persisted session file under a home. */
function findSessionFile(root: string): string | undefined {
	const sessions = join(root, "sessions");
	if (!existsSync(sessions)) return undefined;
	for (const project of readdirSync(sessions)) {
		const projectDir = join(sessions, project);
		if (!statSync(projectDir).isDirectory()) continue;
		for (const session of readdirSync(projectDir)) {
			const sessionDir = join(projectDir, session);
			if (!statSync(sessionDir).isDirectory()) continue;
			for (const file of readdirSync(sessionDir)) {
				if (file.startsWith("session.") && file.includes("jsonl"))
					return join(sessionDir, file);
			}
		}
	}
	return undefined;
}

describe("dashboard source", () => {
	test("a live session persists as a zstd JSONL event log", async () => {
		home = createLiveHome({
			root: `${import.meta.dir}/../tmp/dashboard-source`,
			route: {
				provider: "mock",
				baseURL: provider.baseURL,
				apiKeyEnv: MOCK_API_KEY_ENV,
				models: [{ id: "mock-model", contextWindow: 200_000 }],
			},
			defaultModel: "mock-model",
		});
		provider.script([{ text: "a real assistant reply" }]);
		const result = await home.runHeadlessAsync("dashboard probe", {
			env: mockProviderEnv(),
		});
		expect(result.status).toBe(0);

		const file = findSessionFile(home.home);
		expect(file).toBeDefined();
		// `<home>/sessions/<project>/<sessionId>/session.v4.jsonl.zstd`
		expect(file!).toMatch(
			/sessions\/.+\/session-[^/]+\/session\..+jsonl\.zstd$/,
		);

		// A zstd frame, and it decodes to one JSON event per line.
		const raw = readFileSync(file!);
		expect(raw.subarray(0, 4)).toEqual(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]));
		const decoded = execFileSync("zstd", ["-dc", file!], { encoding: "utf8" });
		const events = decoded
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map(
				(line) =>
					JSON.parse(line) as { type?: string; seq?: number; data?: unknown },
			);
		expect(events.length).toBeGreaterThan(0);
		expect(events.every((event) => typeof event.type === "string")).toBe(true);
		// The assistant reply is present in the host's own log — the dashboard
		// reads it from here, not from Magic Context's store.
		expect(decoded).toContain("a real assistant reply");
	}, 180_000);
});
