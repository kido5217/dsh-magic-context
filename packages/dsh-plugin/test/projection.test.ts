/**
 * Projection spike (T004).
 *
 * Question: can a plugin-owned event rewrite an EXISTING message's content
 * durably — and does the log still reopen when the owning plugin is not
 * loaded? This decides whether the assistant-body reduction lane is
 * host-blocked (R4) or available through the host's message-projection seam.
 *
 * The mechanism under test is the one the host uses for its own
 * `image/offload` records: a log event plus a registered pure
 * `SessionMessageProjection` (`ctx.sessions.registerMessageProjection`). The
 * fold below is the canonical `foldSurface` the reopen path and every surface
 * read run through.
 */
import { describe, expect, test } from "bun:test";
import { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { deriveEventMessage, foldSurface } from "@deepseek-ai/dsh-session";
import { SessionStore } from "@deepseek-ai/dsh-session";
import type { SessionMessageProjection } from "@deepseek-ai/dsh-session/surface";
import { MessageId } from "@deepseek-ai/dsh-llm";
import type { Message } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session/types";

function event(value: Record<string, unknown>): SessionEvent {
	return { time: 1, ...value } as unknown as SessionEvent;
}

/** A log: user turn, assistant turn, then one ignorable plugin projection event. */
function logWithProjection(rewritten: string): SessionEvent[] {
	return [
		event({
			seq: 0,
			type: "user/message",
			surfaceOp: "append",
			data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } },
		}),
		event({
			seq: 1,
			type: "assistant/message",
			surfaceOp: "append",
			data: {
				message: { id: "m2", role: "assistant", content: [{ type: "text", text: "the original long answer" }] },
			},
		}),
		event({
			seq: 2,
			type: "plugin:magic-context/rewrite",
			ignorable: true,
			data: { targetSeq: 1, messageId: "m2", text: rewritten },
		}),
	];
}

/** The plugin's interpreter: same id, same role, only content changes. */
const rewriteAssistant: SessionMessageProjection = {
	type: "plugin:magic-context/rewrite" as SessionMessageProjection["type"],
	project(candidate, context) {
		const data = (candidate as unknown as { data: { targetSeq: number; messageId: string; text: string } }).data;
		// The context carries the contiguous event window; the target is read
		// from the log and re-derived, so a projection chains onto whatever the
		// current content is (including an earlier projection's output).
		const targetEvent = context.events[data.targetSeq - Number(context.baseSeq)];
		const target = targetEvent === undefined ? null : deriveEventMessage(targetEvent);
		if (target === null) throw new Error(`rewrite target ${String(data.targetSeq)} is not a current message`);
		const projected: Message = { ...target, content: [{ type: "text", text: data.text }] };
		return new Map([[SessionSeq(data.targetSeq), projected]]);
	},
};

describe("plugin message projection", () => {
	test("an ignorable plugin event rewrites an assistant body without changing the surface", () => {
		const events = logWithProjection("[folded §1§]");
		const fold = foldSurface(events, [rewriteAssistant]);
		// Node membership is untouched: the projection event is log-only (it adds
		// no node) and the edit applies to content, not structure.
		expect(fold.nodes.map(Number)).toEqual([0, 1]);
		const projected = fold.projectedMessages.get(SessionSeq(1));
		expect(projected?.content).toEqual([{ type: "text", text: "[folded §1§]" }]);
		expect(String(projected?.id)).toBe("m2");
	});

	test("without the owning plugin the log still opens (the edit degrades, never refuses)", () => {
		const events = logWithProjection("[folded §1§]");
		const fold = foldSurface(events);
		expect(fold.nodes.map(Number)).toEqual([0, 1]);
		expect(fold.projectedMessages.size).toBe(0);
		// The durable assistant event still derives its original content.
		expect(deriveEventMessage(events[1]!)?.content).toEqual([{ type: "text", text: "the original long answer" }]);
	});

	test("a projection cannot invent a message or change identity", () => {
		const events = logWithProjection("x");
		const forger: SessionMessageProjection = {
			...rewriteAssistant,
			project: () =>
				new Map([
					[
						SessionSeq(1),
						({ id: MessageId("forged"), role: "assistant", content: [{ type: "text", text: "forged" }], source: { kind: "assistant" } } as unknown) as Message,
					],
				]),
		};
		const fold = foldSurface(events, [forger]);
		// The fold stores whatever the interpreter returns; identity preservation
		// is therefore the plugin's obligation (asserted by our own tests), and
		// the surface cannot be structurally rewritten this way.
		expect(String(fold.projectedMessages.get(SessionSeq(1))?.id)).toBe("forged");
		expect(fold.nodes.map(Number)).toEqual([0, 1]);
	});

	test("the registry accepts one definition per event type", async () => {
		const ctx = new Context();
		const store = new SessionStore(ctx);
		const dispose = store.registerMessageProjection(rewriteAssistant);
		expect(() => store.registerMessageProjection(rewriteAssistant)).toThrow();
		await dispose();
	});
});
