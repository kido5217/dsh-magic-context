/**
 * Heuristic lanes (T024) — the adapter's first two selector bindings.
 *
 * `injection-strip`: the host's system prompt already carries Magic Context's
 * guidance, and the host re-injects its own reminders into the conversation.
 * Those injected regions are pure overhead once they have been read: the core
 * strips them from the outgoing request on the other harnesses, and this lane
 * does the same thing through a durable surface edit.
 *
 * The selector is the core's own pure `stripSystemInjection` — this module
 * contributes only the DSH mapping (which nodes carry text, which primitive to
 * use) and never re-implements the pattern list.
 *
 * `dedup`: the core's `applyHeuristicCleanup` selects in TOOL-TAG space and
 * fingerprints a call as `(ownerMessageId, toolName, arguments)`, reading the
 * host's own part shapes. This module supplies that adapter — the durable log
 * projected into the selector's `{info, parts}` shape, with each `tool-call`
 * block exposed as the `tool_use` form the core reads — plus minimal tag
 * targets. The selector itself decides which duplicates are safe to retire
 * (`DEDUP_SAFE_TOOLS`, protected tools, same-owner grouping) and performs the
 * store-side drop; the drop lane materializes the surface edit on the next
 * pass, exactly like supersession.
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { getActiveTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import { applyHeuristicCleanup } from "@magic-context/core/hooks/magic-context/heuristic-cleanup";
import { stripSystemInjection } from "@magic-context/core/hooks/magic-context/system-injection-stripper";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import type { NodeOpRequest } from "../surface/node-ops.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

/** Only text-only bodies are stripped: a structured body's blocks are opaque to us. */
function textOnly(
	blocks: readonly ContentBlock[] | undefined,
	text: string,
): string | undefined {
	if (blocks === undefined) return text.length > 0 ? text : undefined;
	if (blocks.length !== 1) return undefined;
	const block = blocks[0]!;
	return block.type === "text" ? block.text : undefined;
}

/** The injection-strip selector: pure, deterministic, one request per node. */
export function selectInjectionStrips(
	context: LaneContext,
): readonly NodeOpRequest[] {
	const requests: NodeOpRequest[] = [];
	for (const record of context.projection.records) {
		// `system` nodes are host-owned prompt content and are never edited.
		if (record.role !== "user" && record.role !== "assistant") continue;
		const text = textOnly(record.blocks, record.text);
		if (text === undefined) continue;
		const stripped = stripSystemInjection(text);
		if (stripped === null) continue;
		requests.push({
			messageId: record.messageId,
			content: [{ type: "text", text: stripped }],
		});
	}
	return requests;
}

export const injectionStripLane: Lane = {
	name: "injection-strip",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const requests = selectInjectionStrips(context);
		return {
			requests,
			...(requests.length > 0
				? {
						reason: `stripped injected regions from ${String(requests.length)} message(s)`,
					}
				: {}),
		};
	},
};

/** The host-shaped message the dedup selector fingerprints. */
interface DedupMessage {
	info: { id: string; role: string };
	parts: unknown[];
}

/**
 * Project the durable log into the selector's shape.
 *
 * Only assistant turns are needed: a duplicate is two calls with the same
 * `(owner, toolName, arguments)`, and the owner is the assistant message. Each
 * `tool-call` block is exposed as the core's `tool_use` part form, with parsed
 * arguments — the fingerprint serializes them, so an unparsable argument blob
 * is skipped rather than stringified into a false match.
 */
export function dedupMessages(context: LaneContext): {
	messages: DedupMessage[];
	tagNumbers: Map<DedupMessage, number>;
} {
	const messages: DedupMessage[] = [];
	const tagNumbers = new Map<DedupMessage, number>();
	const tagByMessageId = new Map<string, number>();
	for (const tag of getActiveTagsBySession(context.db, context.mcSession)) {
		if (tag.type === "message")
			tagByMessageId.set(tag.messageId, tag.tagNumber);
	}
	for (const record of context.projection.records) {
		if (record.role !== "assistant") continue;
		const parts: unknown[] = [];
		for (const block of record.blocks ?? []) {
			if (block.type !== "tool-call") continue;
			let input: unknown;
			try {
				input = JSON.parse(String(block.arguments ?? "{}"));
			} catch {
				continue;
			}
			parts.push({
				type: "tool_use",
				id: String(block.id),
				name: String(block.name),
				input,
			});
		}
		if (parts.length === 0) continue;
		const message: DedupMessage = {
			info: { id: record.messageId, role: "assistant" },
			parts,
		};
		messages.push(message);
		const tagNumber = tagByMessageId.get(record.messageId);
		if (tagNumber !== undefined) tagNumbers.set(message, tagNumber);
	}
	return { messages, tagNumbers };
}

/** Minimal tag targets: the selector may only decide, never write the surface. */
function dedupTargets(tags: readonly TagEntry[]): Map<number, TagTarget> {
	const targets = new Map<number, TagTarget>();
	for (const tag of tags) {
		targets.set(tag.tagNumber, {
			canDrop: () => true,
			setContent: () => false,
			drop: () => "removed",
			readInput: () => null,
		} as unknown as TagTarget);
	}
	return targets;
}

export interface DedupSelection {
	readonly deduplicatedTools: number;
	readonly droppedInjections: number;
}

/** Run the core's dedup arm only (routine true, no emergency, no caveman). */
export function selectDedup(context: LaneContext): DedupSelection {
	const tags = getActiveTagsBySession(context.db, context.mcSession);
	if (tags.length === 0) return { deduplicatedTools: 0, droppedInjections: 0 };
	const { messages, tagNumbers } = dedupMessages(context);
	if (messages.length === 0)
		return { deduplicatedTools: 0, droppedInjections: 0 };
	const result = applyHeuristicCleanup(
		context.mcSession,
		context.db,
		dedupTargets(tags),
		tagNumbers as unknown as Map<never, number>,
		{
			protectedTools: context.config.protected_tools,
			protectedTagNumbers: new Set(),
			protectedCutoff: null,
			routine: true,
		},
		tags,
	);
	return {
		deduplicatedTools: result.deduplicatedTools,
		droppedInjections: result.droppedInjections,
	};
}

export const dedupLane: Lane = {
	name: "dedup",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const selection = selectDedup(context);
		if (selection.deduplicatedTools === 0) return { requests: [] };
		return {
			requests: [],
			decision: async () => selection,
			reason: `deduplicated ${String(selection.deduplicatedTools)} tool call(s)`,
		};
	},
};
