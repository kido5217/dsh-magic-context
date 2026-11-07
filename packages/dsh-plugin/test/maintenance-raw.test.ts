/**
 * T061 — DSH raw-history providers over the durable session log.
 * Privacy rules are the contract: genuine typed user text only, tool
 * metadata only, adapter-injected nodes excluded.
 */
import { describe, expect, test } from "bun:test";
import type { DshSessionHistorySource } from "../src/maintenance/raw-session.js";
import {
	createDshPrimerRawProviderFactory,
	createDshRetrospectiveRawProvider,
	projectRetrospectiveRows,
} from "../src/maintenance/raw-session.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";

function user(
	id: string,
	text: string,
	ts: number,
	blocks?: readonly unknown[],
): DshLogMessageRecord {
	return {
		seq: 1,
		messageId: id,
		role: "user",
		text,
		createdAt: ts,
		blocks: (blocks ?? [
			{ type: "text", text },
		]) as DshLogMessageRecord["blocks"],
	};
}

describe("retrospective projection", () => {
	test("keeps genuine user text, drops assistant text, keeps tool metadata", () => {
		const rows = projectRetrospectiveRows("s1", [
			user("u1", "the build is broken again", 100),
			{
				seq: 2,
				messageId: "a1",
				role: "assistant",
				text: "secret file contents here",
				createdAt: 110,
				blocks: [
					{
						type: "tool-call",
						id: "c1",
						name: "bash",
						arguments: "{}",
					},
				] as unknown as DshLogMessageRecord["blocks"],
			},
			{
				seq: 3,
				messageId: "t1",
				role: "tool",
				text: "huge raw tool output",
				createdAt: 120,
				toolCallId: "c1",
				isError: true,
			},
			user("u2", "still broken", 130),
		]);
		expect(rows.map((row) => row.role)).toEqual(["user", "tool", "user"]);
		expect(rows[1]).toMatchObject({
			role: "tool",
			text: "",
			toolName: "bash",
			isError: true,
		});
		// The second user turn follows an assistant reply.
		expect(rows[2]?.followsAssistantReply).toBe(true);
	});

	test("synthetic user blocks and adapter nodes never reach the window", () => {
		const rows = projectRetrospectiveRows("s1", [
			user("u1", "", 100, [
				{ type: "text", text: "adapter injected", synthetic: true },
			]),
			user("mc-1", "reduction notice", 110),
			user("u2", "real typed text", 120),
		]);
		expect(rows.map((row) => row.text)).toEqual(["real typed text"]);
	});

	test("an oversized user message is head/tail clamped with the marker", () => {
		const huge = `${"a".repeat(9000)}TAILMARK`;
		const rows = projectRetrospectiveRows("s1", [user("u1", huge, 100)]);
		const text = rows[0]?.text ?? "";
		expect(text.length).toBeLessThanOrEqual(8100);
		expect(text.startsWith("aaaa")).toBe(true);
		expect(text.endsWith("TAILMARK")).toBe(true);
		expect(text).toContain("truncated by Magic Context");
	});
});

function fakeSource(
	sessions: Record<string, readonly DshLogMessageRecord[]>,
	listed: readonly { sessionId: string; updatedAt?: number }[],
): DshSessionHistorySource {
	return {
		async listProjectSessions() {
			return listed;
		},
		async readSessionRecords(sessionId) {
			return sessions[sessionId] ?? [];
		},
	};
}

describe("retrospective provider", () => {
	test("since/before reads, caps and truncation signal", async () => {
		const records: DshLogMessageRecord[] = [
			user("u1", "one", 100),
			user("u2", "two", 200),
			user("u3", "three", 300),
		];
		const provider = createDshRetrospectiveRawProvider(
			fakeSource({ s1: records, "session-mc-maint-x": [] }, [
				{ sessionId: "s1" },
				{ sessionId: "session-mc-maint-x" },
			]),
			"/proj",
		);
		expect(await provider.listProjectSessions("/proj")).toEqual([
			{ sessionId: "s1" },
		]);
		// Oldest-first under the cap (the OpenCode provider's LIMIT ... ASC
		// semantics): the run advances a watermark and resumes later.
		const since = await provider.readUserMessagesSince("s1", 150, 1);
		expect(since.messages.map((row) => row.text)).toEqual(["two"]);
		expect(since.truncated).toBe(true);
		const before = await provider.readUserMessagesBefore("s1", 250, 2);
		expect(before.map((row) => row.text)).toEqual(["one", "two"]);
		const oldest = await provider.readOldestMessageTimesSince?.(["s1"], 50);
		expect(oldest).toEqual(new Map([["s1", 100]]));
		provider.dispose?.();
	});

	test("the primer factory yields a provider, or null for an empty session", async () => {
		const factory = createDshPrimerRawProviderFactory(
			fakeSource({ s1: [user("u1", "seed text", 100)] }, []),
		);
		const provider = await factory("s1");
		expect(provider?.readMessages()).toEqual([
			{
				ordinal: 1,
				id: "u1",
				role: "user",
				parts: [{ type: "text", text: "seed text" }],
				createdAt: 100,
			},
		]);
		expect(await factory("missing")).toBeNull();
	});
});
