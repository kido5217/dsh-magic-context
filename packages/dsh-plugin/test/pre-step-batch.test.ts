/**
 * Pre-step batch rewrite spike (T006).
 *
 * Question: can a pre-step listener replace the history a step will send, the
 * way OpenCode/Pi rewrites their outbound request?
 *
 * The host's `agent/pre-step` is a waterfall whose enter decision carries
 * `messages: UserMessage[]` — the user messages ADMITTED FOR THIS STEP, not a
 * full history array (`runtime-types.d.ts:117`). The test below pins the two
 * consequences the adapter design depends on:
 *
 * 1. an outer listener can merge its own user messages into an inner
 *    listener's decision (so several plugins can inject in one step), and
 * 2. what crosses the seam is `UserMessage[]` only — history replacement is
 *    not expressible here, which is why Magic Context's reductions are durable
 *    surface edits (applied before the step) instead of per-request rewrites.
 */
import { describe, expect, test } from "bun:test";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-session";

/** One registered pre-step listener, innermost last (waterfall order). */
type Listener = (
	next: () => Promise<PreStepDecision>,
) => Promise<PreStepDecision>;

/** Model the host waterfall: innermost decision propagates out through `next()`. */
async function waterfall(
	listeners: readonly Listener[],
): Promise<PreStepDecision> {
	const chain = async (index: number): Promise<PreStepDecision> => {
		const listener = listeners[index];
		if (listener === undefined) return { kind: "enter", messages: [] };
		return listener(() => chain(index + 1));
	};
	return chain(0);
}

function userMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as unknown as UserMessage;
}

describe("pre-step batch", () => {
	test("an outer listener merges its messages ahead of the inner decision", async () => {
		const decision = await waterfall([
			async (next) => {
				const inner = await next();
				if (inner.kind !== "enter") return inner;
				return {
					...inner,
					messages: [userMessage("outer"), ...inner.messages],
				};
			},
			async () => ({ kind: "enter", messages: [userMessage("inner")] }),
		]);
		expect(decision.kind).toBe("enter");
		const texts =
			decision.kind === "enter"
				? decision.messages.map(
						(message) => (message.content[0] as { text: string }).text,
					)
				: [];
		expect(texts).toEqual(["outer", "inner"]);
	});

	test("a reject short-circuits the chain before any message is admitted", async () => {
		let innerRan = false;
		const decision = await waterfall([
			async (next) => {
				void next;
				return { kind: "reject" };
			},
			async () => {
				innerRan = true;
				return { kind: "enter", messages: [] };
			},
		]);
		expect(decision.kind).toBe("reject");
		expect(innerRan).toBe(false);
	});

	test("the seam admits user messages only — history is not writable here", () => {
		// Compile-time evidence: the enter decision's payload is UserMessage[].
		// A history array (assistant/tool nodes) cannot be expressed, which is
		// why the adapter's lanes write durable surface edits instead.
		const decision: PreStepDecision = {
			kind: "enter",
			messages: [userMessage("batch")],
		};
		expect(decision.kind === "enter" && Array.isArray(decision.messages)).toBe(
			true,
		);
	});
});
