/**
 * V2 live gate (T039, second half): the subagent emergency fold.
 *
 * A delegated child is driven to the refuse band with only reclaimable-by-fold
 * history: its tool output is real but small enough that the emergency lane has
 * nothing to drop above the floor, so the DSH divergence fires — ONE historian
 * fold for that child, which summarizes rather than deletes.
 *
 * The assertion is on the shared store: a compartment must exist for the CHILD
 * session (a different session id than the parent, classified as a subagent),
 * and both agents must complete.
 *
 * SKIPPED: the child's tool-call path does not execute in the isolated headless
 * profile yet — the child makes exactly one request and ends, so it never
 * reaches a second step (and therefore never a fold). The unit-level behaviour
 * is covered by `test/us1-emergency.test.ts`; the live driver needs the child's
 * tool set understood. See `gate-evidence/v2-subagent-fold/README.md`.
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

const READ_TARGET = `${import.meta.dir}/us1-support.ts`;

describe.skip("V2 live", () => {
	test("a child at the refuse band takes one fold instead of a refusal", async () => {
		home = createLiveHome({
			root: `${import.meta.dir}/../tmp/live-v2`,
			route: {
				provider: "mock",
				baseURL: provider.baseURL,
				apiKeyEnv: MOCK_API_KEY_ENV,
				models: [{ id: "mock-model", contextWindow: 6_000 }],
			},
			defaultModel: "mock-model",
		});
		// The parent and the child interleave, so replies are matched on what
		// the request carries — never on position.
		provider.respond((body) => {
			const messages =
				(body["messages"] as { role?: string; content?: unknown }[]) ?? [];
			const roles = messages.map((message) => message.role);
			// The child's own prompt is the only place the delegated text appears;
			// the parent carries it only inside a tool ARGUMENT, not a message.
			const isChild = messages.some(
				(message) =>
					message.role === "user" &&
					JSON.stringify(message.content ?? "").includes("support file"),
			);
			if (isChild) {
				const hasTool = roles.includes("tool");
				return hasTool
					? { text: "child report", promptTokens: 1_000 }
					: {
							toolCalls: [
								{
									name: "read",
									arguments: JSON.stringify({ path: READ_TARGET }),
								},
							],
							promptTokens: 5_900,
						};
			}
			const hasTool = roles.includes("tool");
			return hasTool
				? { text: "parent done", promptTokens: 1_000 }
				: {
						toolCalls: [
							{
								name: "subagent",
								arguments: JSON.stringify({
									description: "read a file",
									prompt: "Read the support file and report one thing.",
								}),
							},
						],
						promptTokens: 1_000,
					};
		});
		const result = await home.runHeadlessAsync("delegate the read", {
			env: mockProviderEnv(),
		});
		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain("TEST BACKSTOP");
		expect(result.stderr).not.toContain("storage unavailable");

		const { Database } = await import("bun:sqlite");
		const db = new Database(
			`${home.home}/data/cortexkit/magic-context/context.db`,
			{ readonly: true },
		);
		const sessions = db
			.prepare("SELECT session_id, is_subagent FROM session_meta")
			.all() as { session_id: string; is_subagent: number }[];
		const compartments = db
			.prepare("SELECT session_id, title, content FROM compartments")
			.all() as { session_id: string; title: string; content: string }[];
		db.close();

		// A child session was managed…
		const child = sessions.find((session) => session.is_subagent === 1);
		expect(child).toBeDefined();
		// …and the fold is what it produced (not a drop: this history had
		// nothing the emergency lane could retire above the floor).
		expect(
			compartments.some(
				(compartment) => compartment.session_id === child!.session_id,
			),
		).toBe(true);
		expect(compartments[0]?.content.length).toBeGreaterThan(0);
	}, 300_000);
});
