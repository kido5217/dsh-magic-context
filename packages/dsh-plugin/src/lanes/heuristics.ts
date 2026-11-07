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
 * `dedup` is deliberately NOT bound here yet. The core's dedup selector
 * (`applyHeuristicCleanup`) selects in TOOL-TAG space and needs each tool tag to
 * carry `toolName`/`toolOwnerMessageId`; the adapter's tagger does not stamp
 * that identity yet, so a hand-rolled lookalike would be adapter policy rather
 * than the shared core's. The tagger work + binding is tracked as the remainder
 * of T024.
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { stripSystemInjection } from "@magic-context/core/hooks/magic-context/system-injection-stripper";
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
