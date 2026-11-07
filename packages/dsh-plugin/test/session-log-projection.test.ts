/**
 * Structured projection (T014): records keep the provider-neutral block shape,
 * not just concatenated text, so lane selectors can see tool identity,
 * reasoning and non-text content.
 */
import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import {
	type DshLogMessageRecord,
	isAdapterSurfaceId,
	projectDshSessionLog,
} from "../src/surface/dsh-session-log.js";

const records: readonly DshLogMessageRecord[] = [
	{
		seq: 10,
		messageId: "m1",
		role: "user",
		text: "hello",
		blocks: [{ type: "text", text: "hello" }],
	},
	{
		seq: 11,
		messageId: "m2",
		role: "assistant",
		text: "thinking\ncalling",
		reasoningSigned: true,
		blocks: [
			{ type: "reasoning", text: "thinking" },
			{ type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a"}' },
		] as unknown as ContentBlock[],
	},
	{
		seq: 12,
		messageId: "m3",
		role: "tool",
		text: "result",
		toolCallId: "c1",
		blocks: [{ type: "text", text: "result" }],
	},
];

describe("structured session-log projection", () => {
	test("keeps block structure, tool identity and signature presence", () => {
		const projection = projectDshSessionLog(records);
		expect(projection.records).toHaveLength(3);

		const assistant = projection.records[1]!;
		expect(assistant.reasoningSigned).toBe(true);
		expect(assistant.blocks?.map((block) => block.type)).toEqual([
			"reasoning",
			"tool-call",
		]);
		const call = assistant.blocks?.find(
			(block) => block.type === "tool-call",
		) as { name?: string; arguments?: string; id?: string } | undefined;
		expect(call?.name).toBe("read");
		expect(call?.arguments).toBe('{"path":"a"}');

		const tool = projection.records[2]!;
		expect(tool.toolCallId).toBe("c1");
	});

	test("ordinals are surface positions and text still projects for core readers", () => {
		const projection = projectDshSessionLog(records);
		expect(projection.rawMessages.map((message) => message.ordinal)).toEqual([
			1, 2, 3,
		]);
		expect(projection.rawMessages[0]!.parts).toEqual([
			{ type: "text", text: "hello" },
		]);
		expect(projection.byMessageId.get("m3")).toMatchObject({
			ordinal: 3,
			seq: 12,
		});
	});

	test("records without blocks stay text-only rather than failing", () => {
		const projection = projectDshSessionLog([
			{ seq: 1, messageId: "plain", role: "user", text: "fallback" },
		]);
		expect(projection.records[0]!.blocks).toBeUndefined();
		expect(projection.rawMessages[0]!.parts).toEqual([
			{ type: "text", text: "fallback" },
		]);
	});

	test("adapter-owned ids are identifiable", () => {
		expect(isAdapterSurfaceId("mc-drop-123")).toBe(true);
		expect(isAdapterSurfaceId("m1")).toBe(false);
	});
});
