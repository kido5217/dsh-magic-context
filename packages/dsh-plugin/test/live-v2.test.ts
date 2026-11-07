/**
 * V2 live gate (T039, second half): the subagent emergency fold.
 *
 * A delegated child is driven to the refuse band with only foldable history:
 * its tool output is real but below the emergency planner's minimum achievable
 * reclaim (EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS = 2,000), so the emergency
 * lane cannot act, the reclaim lanes cannot act, and the DSH divergence fires —
 * ONE historian fold for that child, which summarizes rather than deletes.
 *
 * Two mechanics the driver must get right, both proven by the earlier
 * attempts recorded in `gate-evidence/v2-subagent-fold/`:
 *
 * 1. The `subagent` tool is ASYNCHRONOUS: the parent's turn completes while
 *    the child is still a background agent, so a driver that positions
 *    responses fails. Replies are matched on request CONTENT, and the parent's
 *    final reply is STALLED (delayMs) to keep the host process — and with it
 *    the child scheduler — alive while the child takes its second step.
 * 2. The historian's aux call rides the same route, so the transcript
 *    (which quotes the child prompt) must be classified BEFORE the child.
 *
 * The assertion is on the shared store: a compartment must exist for the CHILD
 * session (classified as a subagent), and both agents must complete.
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

// ~1.3k tokens: above the protected tail (so the fold has an eligible window)
// and below the emergency planner's minimum (so only a fold can act).
const READ_TARGET = `${import.meta.dir}/fixtures/v2-child-read.txt`;

describe("V2 live", () => {
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
		const seen = { historian: 0, childSteps: 0 };
		// The parent and the child interleave, so replies are matched on what
		// the request carries — never on position.
		provider.respond((body) => {
			const messages =
				(body["messages"] as { role?: string; content?: unknown }[]) ?? [];
			const raw = JSON.stringify(body);
			// The historian's aux call quotes the child transcript, so it must
			// be answered first or it would look like another child step.
			if (raw.includes("the hippocampus of a long-running coding agent")) {
				seen.historian += 1;
				return {
					text: "- folded child history: one read of the support file, no findings",
					promptTokens: 500,
				};
			}
			// After the fold the child's original prompt is gone from the
			// surface: what identifies the child's LATER requests is the
			// frozen baseline node (it opens with the `## Magic Context`
			// guidance and carries the fold's compartment heading). Before the
			// fold it is the prompt itself. The parent never reaches pressure,
			// so only the child ever carries a baseline node.
			const folded = raw.includes("Session history");
			const isChild = messages.some(
				(message) =>
					message.role === "user" &&
					(JSON.stringify(message.content ?? "").includes("support file") ||
						JSON.stringify(message.content ?? "").includes("## Magic Context")),
			);
			if (isChild) {
				seen.childSteps += 1;
				const toolResults = messages.filter(
					(message) => message.role === "tool",
				).length;
				// Once the baseline is in the served history the child must
				// WRAP UP: another tool call would just hand the fold another
				// eligible window on the next pass and never finish.
				if (folded || toolResults >= 2)
					return { text: "child report", promptTokens: 1_000 };
				// Refuse band from the first step; the fold is what must open
				// the SECOND step, and the emergency lane must not be able to.
				return {
					toolCalls: [
						{ name: "read", arguments: JSON.stringify({ path: READ_TARGET }) },
					],
					promptTokens: 5_900,
				};
			}
			if (folded) return { text: "child report", promptTokens: 1_000 };
			const hasTool = messages.some((message) => message.role === "tool");
			return hasTool
				? {
						text: "parent done",
						promptTokens: 1_000,
						// Keep the host alive: the child is a background agent
						// and dies with the parent's turn otherwise.
						delayMs: 25_000,
					}
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
		const hashes = db
			.prepare(
				"SELECT session_id, is_subagent, system_prompt_hash FROM session_meta",
			)
			.all() as {
			session_id: string;
			is_subagent: number;
			system_prompt_hash: string;
		}[];
		db.close();

		// The driver reached the child's SECOND step (the fold's moment)…
		expect(seen.childSteps).toBeGreaterThanOrEqual(2);
		// …the historian really ran (the only possible caller is the child's
		// fold pass; the parent never reaches pressure)…
		expect(seen.historian).toBeGreaterThanOrEqual(1);
		// …one or more managed child sessions…
		const childIds = new Set(
			sessions
				.filter((session) => session.is_subagent === 1)
				.map((session) => session.session_id),
		);
		expect(childIds.size).toBeGreaterThanOrEqual(1);
		// The child's head pair persisted: the pair fingerprint (baseline hash
		// | delta hash) lives in session_meta for restart rediscovery (T044).
		const childHash = hashes.find(
			(row) => row.is_subagent === 1 && row.system_prompt_hash !== "",
		)?.system_prompt_hash;
		expect(childHash).toMatch(/^[0-9a-f]{32}\|[0-9a-f]{32}\|[0-9a-f]{32}$/);
		// …and every compartment is a fold of CHILD history (not a drop: this
		// history had nothing the emergency lane could retire above its
		// minimum). The unpressured parent produced none.
		expect(
			compartments.some((compartment) => childIds.has(compartment.session_id)),
		).toBe(true);
		expect(
			compartments.every((compartment) => childIds.has(compartment.session_id)),
		).toBe(true);
		expect(compartments[0]?.content.length).toBeGreaterThan(0);
	}, 300_000);
});
