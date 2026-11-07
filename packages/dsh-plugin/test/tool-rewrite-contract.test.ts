/**
 * Tool-result rewrite contract (T005, structural half).
 *
 * DSH allows a plugin to replace exactly one current `tool/result` node, and
 * only its `content`: identity and every other data field must stay equal.
 * This test pins that contract against the installed host package, so the
 * surface-v2 operations (T015/T016) cannot drift into a shape the host rejects.
 *
 * The live half of the spike — the next provider request carrying the new
 * content and a reopen preserving it — runs through `test/live-home.ts`; see
 * `specs/002-dsh-full-parity/gate-evidence/spike-tool-rewrite.md`.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { deriveEventMessage, foldSurface } from "@deepseek-ai/dsh-session";

function event(value: Record<string, unknown>): SessionEvent {
	return { time: 1, ...value } as unknown as SessionEvent;
}

function logWithReplacement(
	content: string,
	overrides: { toolCallId?: string } = {},
): SessionEvent[] {
	const user = event({
		seq: 0,
		type: "user/message",
		surfaceOp: "append",
		data: {
			id: "m1",
			role: "user",
			content: [{ type: "text", text: "hi" }],
			source: { kind: "user" },
		},
	});
	const assistant = event({
		seq: 1,
		type: "assistant/message",
		surfaceOp: "append",
		data: {
			message: {
				id: "m2",
				role: "assistant",
				content: [
					{ type: "tool-call", id: "c1", name: "read", arguments: "{}" },
				],
			},
		},
	});
	const result = event({
		seq: 2,
		type: "tool/result",
		surfaceOp: "append",
		data: {
			turn: 1,
			step: 1,
			message: {
				id: "m3",
				role: "tool",
				toolCallId: "c1",
				content: [{ type: "text", text: "original output" }],
				source: { kind: "tool" },
			},
		},
	});
	const replacement = event({
		seq: 3,
		type: "tool/result",
		surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
		sourceEventSeqs: [2],
		data: {
			turn: 1,
			step: 1,
			message: {
				id: "m3",
				role: "tool",
				toolCallId: overrides.toolCallId ?? "c1",
				content: [{ type: "text", text: content }],
				source: { kind: "tool" },
			},
		},
	});
	return [user, assistant, result, replacement];
}

describe("tool/result rewrite contract", () => {
	test("an identity-preserving content rewrite replaces exactly one node", () => {
		const events = logWithReplacement("[dropped §1§]");
		const fold = foldSurface(events);
		expect(fold.nodes.map(Number)).toEqual([0, 1, 3]);
		const replacement = events[3]!;
		expect(deriveEventMessage(replacement)?.content).toEqual([
			{ type: "text", text: "[dropped §1§]" },
		]);
	});

	test("changing anything but content is rejected", () => {
		const events = logWithReplacement("[dropped §1§]", { toolCallId: "c2" });
		expect(() => foldSurface(events)).toThrow("may change only content");
	});

	test("the same node cannot be replaced twice", () => {
		const events = logWithReplacement("[dropped §1§]");
		const second = event({
			seq: 4,
			type: "tool/result",
			surfaceOp: { op: "replace", startSeq: 2, endSeq: 2 },
			sourceEventSeqs: [2],
			data: {
				turn: 1,
				step: 1,
				message: {
					id: "m3",
					role: "tool",
					toolCallId: "c1",
					content: [{ type: "text", text: "again" }],
					source: { kind: "tool" },
				},
			},
		});
		expect(() => foldSurface([...events, second])).toThrow();
	});
});
