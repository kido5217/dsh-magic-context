/**
 * Auto-search assistance lane (T031).
 *
 * Before the agent answers, Magic Context may know something the prompt does
 * not say: a memory, an earlier session, a commit. The core's auto-search
 * decides whether such a hint is worth attaching to the entering user message,
 * persists the decision (so a replay is byte-stable and a skip is remembered),
 * and renders the hint. This module is the DSH adapter: it maps the durable
 * projection into the selector's message shape, runs the core runner, and diffs
 * the result back out as a single node operation on that user message.
 *
 * What the adapter deliberately does NOT do:
 * - choose candidates or rank them (the core's embedding/git sources do);
 * - re-implement the hint text or the `<ctx-search-hint>` markers;
 * - decide to run per pass (the core coalesces per user turn and skips short
 *   prompts, ignored notifications, and already-augmented messages).
 *
 * Degradation is the core's own: with no embedding backend the runner records a
 * skip and returns, so the lane is a no-op — identical to the other harnesses
 * on a machine without embeddings.
 */

import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type AutoSearchOutcome,
	runAutoSearchHint,
} from "@magic-context/core/hooks/magic-context/auto-search-runner";
import { cavemanWordRulesForLanguage } from "@magic-context/core/hooks/magic-context/caveman";
import type { NodeOpRequest } from "../surface/node-ops.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

/** The host-shaped message the core runner reads and augments. */
interface AutoSearchMessage {
	info: { id: string; role: string };
	parts: { type: string; text: string }[];
}

/**
 * Build the runner's message array. Only messages the agent would actually see
 * are included, and structured bodies (images, tool blocks) are skipped: the
 * hint attaches to plain prose.
 */
export function autoSearchMessages(context: LaneContext): {
	messages: AutoSearchMessage[];
	messageIdByIndex: string[];
} {
	const messages: AutoSearchMessage[] = [];
	const messageIdByIndex: string[] = [];
	for (const record of context.projection.records) {
		if (record.role !== "user" && record.role !== "assistant") continue;
		if (record.blocks !== undefined) {
			const textOnly =
				record.blocks.length === 1 && record.blocks[0]?.type === "text";
			if (!textOnly) continue;
		}
		messages.push({
			info: { id: record.messageId, role: record.role },
			parts: [{ type: "text", text: record.text }],
		});
		messageIdByIndex.push(record.messageId);
	}
	return { messages, messageIdByIndex };
}

/** Memory ids the head has already shown this session (rendered-id capture). */
function renderedMemoryIds(context: LaneContext): Set<number> | undefined {
	const row = context.db
		.prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
		.get(context.mcSession) as { memory_block_ids?: string | null } | null;
	if (row?.memory_block_ids == null) return undefined;
	try {
		const parsed: unknown = JSON.parse(row.memory_block_ids);
		if (!Array.isArray(parsed)) return undefined;
		const ids = parsed.filter(
			(value): value is number => typeof value === "number",
		);
		return ids.length > 0 ? new Set(ids) : undefined;
	} catch {
		return undefined;
	}
}

export interface AutoSearchSelection {
	readonly requests: readonly NodeOpRequest[];
	readonly outcome?: AutoSearchOutcome;
}

/** Pure (store-reading) selector: run the core runner and diff its augmentation. */
export async function selectAutoSearch(
	context: LaneContext,
): Promise<AutoSearchSelection> {
	const autoSearch = context.config.memory?.auto_search;
	if (autoSearch?.enabled !== true) return { requests: [] };
	const projectPath = resolveProjectIdentityForSession(context.projectDir);
	if (projectPath === null || projectPath === undefined)
		return { requests: [] };
	const { messages, messageIdByIndex } = autoSearchMessages(context);
	// Memories the head already renders must not come back as hints: they are
	// not new information, and a duplicate is exactly what the visible-memory
	// filter exists to prevent.
	const visibleMemoryIds = renderedMemoryIds(context);
	if (messages.length === 0) return { requests: [] };
	const before = messages.map((message) => message.parts[0]?.text ?? "");
	const outcome = await runAutoSearchHint({
		sessionId: context.mcSession,
		db: context.db,
		messages: messages as never,
		options: {
			enabled: true,
			scoreThreshold: autoSearch.score_threshold,
			minPromptChars: autoSearch.min_prompt_chars,
			directory: context.projectDir,
			projectPath,
			memoryEnabled: context.config.memory.enabled,
			...(visibleMemoryIds !== undefined ? { visibleMemoryIds } : {}),
			wordRules: cavemanWordRulesForLanguage(context.config.language),
		},
	});
	const requests: NodeOpRequest[] = [];
	for (const [index, message] of messages.entries()) {
		const after = message.parts[0]?.text ?? "";
		if (after === before[index]) continue;
		requests.push({
			messageId: messageIdByIndex[index]!,
			content: [{ type: "text", text: after }],
		});
	}
	return { requests, outcome };
}

export const autoSearchLane: Lane = {
	name: "auto-search",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): Promise<LaneSelection> | LaneSelection {
		return selectAutoSearch(context).then((selection) => ({
			requests: selection.requests,
			...(selection.requests.length > 0
				? { reason: "attached an auto-search hint" }
				: {}),
		}));
	},
};
