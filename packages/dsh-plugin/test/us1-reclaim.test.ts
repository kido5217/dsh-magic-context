/**
 * US1 reclaim lanes (T025): tool-tag identity and the supersession selector.
 *
 * The core's supersession selector protects the newest owners (a 20-owner
 * window), so the test builds just over that window: the oldest spent
 * control-plane call must be selected, the recent ones must not. This is the
 * property that failed to hold before tool tags carried
 * `(callId, toolOwnerMessageId, toolName)` — without identity the core cannot
 * see a tool call at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getActiveTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import type { LaneContext } from "../src/lanes/engine.js";
import { selectSupersession } from "../src/lanes/reclaim.js";
import { rulesForRole } from "../src/sessions/subagent-rules.js";
import { indexToolCalls } from "../src/sessions/tool-identity.js";
import {
	type DshLogMessageRecord,
	projectDshSessionLog,
} from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
});

afterAll(async () => {
	await closeDatabase();
});

const cfg = MagicContextConfigSchema.parse({});

/** Assistant turn that issues one tool call. */
function assistantWithCall(
	seq: number,
	id: string,
	callId: string,
	name: string,
	args = "{}",
): Partial<DshLogMessageRecord> {
	void seq;
	void id;
	// Branded block ids are the host's business; the projection reads them as
	// strings, so the fixture casts at this single boundary.
	return {
		blocks: [{ type: "tool-call", id: callId, name, arguments: args } as never],
	};
}

describe("tool identity", () => {
	test("a projection joins a result to its call, owner and tool name", () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-identity" }, [0, 1]);
		session.seedMessage(
			0,
			"a1",
			"",
			"assistant",
			assistantWithCall(0, "a1", "call-1", "grep"),
		);
		session.seedMessage(1, "t1", "matches", "tool", { toolCallId: "call-1" });
		const index = indexToolCalls(projectDshSessionLog(session.logRecords()));
		const identity = index.byCallId.get("call-1");
		expect(identity).toMatchObject({
			callId: "call-1",
			name: "grep",
			ownerMessageId: "a1",
		});
		expect(index.forRecord(session.logRecords()[1]!)?.ownerMessageId).toBe(
			"a1",
		);
	});

	test("the tagger stamps tool tags with composite identity", () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-tag-tool" }, [0, 1]);
		session.seedMessage(
			0,
			"a1",
			"",
			"assistant",
			assistantWithCall(0, "a1", "call-1", "grep"),
		);
		session.seedMessage(1, "t1", "matches", "tool", { toolCallId: "call-1" });
		const projection = projectDshSessionLog(session.logRecords());
		const tagger = createTagger();
		const tools = indexToolCalls(projection);
		const record = session.logRecords()[1]!;
		const identity = tools.forRecord(record)!;
		tagger.assignToolTag(
			"s-tag-tool",
			identity.callId,
			identity.ownerMessageId,
			record.text.length,
			db,
			0,
			identity.name,
			identity.inputBytes,
		);
		const tags = getActiveTagsBySession(db, "s-tag-tool");
		const toolTag = tags.find((tag) => tag.type === "tool")!;
		expect(toolTag).toMatchObject({
			toolName: "grep",
			toolOwnerMessageId: "a1",
		});
	});
});

describe("supersession selector", () => {
	test("selects a spent control-plane call outside the recent window only", () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-supersede" }, []);
		const tagger = createTagger();
		// 25 assistant turns, each issuing one ctx_reduce call; the first is the
		// one outside the 20-owner protection window.
		for (let index = 0; index < 25; index += 1) {
			const owner = `a${String(index)}`;
			tagger.assignTag("s-supersede", owner, "message", 10, db);
			tagger.assignToolTag(
				"s-supersede",
				`call-${String(index)}`,
				owner,
				10,
				db,
				0,
				"ctx_reduce",
				2,
			);
		}
		const context: LaneContext = {
			session,
			mcSession: "s-supersede",
			projection: projectDshSessionLog([]),
			rules: rulesForRole("primary"),
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
		};
		const selection = selectSupersession(context);
		const tags = getActiveTagsBySession(db, "s-supersede");
		const oldestToolTag = tags
			.filter((tag) => tag.type === "tool")
			.sort((left, right) => left.tagNumber - right.tagNumber)[0]!;
		expect(selection.tagIds).toContain(oldestToolTag.tagNumber);
		// Recent turns stay: their output is still actionable.
		const newestToolTag = tags
			.filter((tag) => tag.type === "tool")
			.sort((left, right) => right.tagNumber - left.tagNumber)[0]!;
		expect(selection.tagIds).not.toContain(newestToolTag.tagNumber);
	});
});
