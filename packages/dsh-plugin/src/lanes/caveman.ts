/**
 * Caveman compression lane (T027).
 *
 * Reduced prose still carries the meaning; the words around it do not. The
 * core's `cavemanCompress` is a pure, deterministic text transform that drops
 * filler, hedging, pleasantries and (at deeper levels) articles and
 * auxiliaries — while preserving code, URLs, paths, hashes, `§N§` tag markers
 * and the user's own `U:` lines.
 *
 * Gating and tiers are the core's policy, expressed in DSH terms:
 * - PRIMARY ONLY. A subagent's history is summarized away rather than
 *   rewritten, and its caller reads the result, so degrading its prose buys
 *   nothing (contract: "primary only, with heuristics").
 * - Config-gated by `caveman_text_compression` (default off): this lane
 *   rewrites agent-visible history, which must be an explicit opt-in.
 * - AGE TIERS by position among the eligible (outside-protected-tail) textual
 *   nodes: oldest 20% → ultra, next 20% → full, next 20% → lite, newest 40%
 *   untouched. Age, not size: the oldest content is the least likely to be
 *   re-read closely.
 *
 * Byte stability: compression is a pure function of the SOURCE text, so a
 * replay of the same tier produces the same bytes. A node already at its
 * target depth is untouched, which is what stops a deferred pass from
 * re-compressing its own output into gibberish.
 */

import {
	getActiveTagsBySession,
	updateCavemanDepth,
} from "@magic-context/core/features/magic-context/storage-tags";
import {
	type CavemanLevel,
	cavemanCompress,
} from "@magic-context/core/hooks/magic-context/caveman";
import type { NodeOpRequest } from "../surface/node-ops.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

/** The tier for a 0-based position among eligible nodes. */
export function cavemanTierFor(
	index: number,
	total: number,
): CavemanLevel | undefined {
	if (total === 0) return undefined;
	const share = index / total;
	if (share < 0.2) return "ultra";
	if (share < 0.4) return "full";
	if (share < 0.6) return "lite";
	return undefined;
}

/** Numeric depth of each level (the tag stores this, so replay can skip). */
export const CAVEMAN_DEPTH: Readonly<Record<CavemanLevel, number>> = {
	lite: 1,
	full: 2,
	ultra: 3,
};

/**
 * Nodes this lane may rewrite, with the age tier the CORE's policy assigns.
 *
 * Tiers are computed from the node's position in the session's whole tag
 * population (tag numbers are immutable), not from its index in the filtered
 * candidate list. That distinction is what makes the lane stable: a node that
 * leaves the candidate set (protected, dropped, or rewritten into an
 * adapter-node) keeps its slot, so its neighbours never slide into a deeper
 * tier and get compressed a second time.
 *
 * The tag is also the idempotency key: `tags.caveman_depth` records the depth
 * already applied, because the transform is not a fixed point — compressing
 * already-compressed prose would keep eating words.
 */
interface CavemanNode {
	readonly messageId: string;
	readonly text: string;
	readonly tagNumber: number;
	readonly depth: number;
	readonly tier: CavemanLevel;
}

function eligible(context: LaneContext): CavemanNode[] {
	const tags = getActiveTagsBySession(context.db, context.mcSession).sort(
		(left, right) => left.tagNumber - right.tagNumber,
	);
	const total = tags.length;
	const byMessageId = new Map<
		string,
		{ tagNumber: number; depth: number; tier: CavemanLevel | undefined }
	>();
	for (const [index, tag] of tags.entries()) {
		if (tag.type !== "message") continue;
		byMessageId.set(tag.messageId, {
			tagNumber: tag.tagNumber,
			depth: tag.cavemanDepth,
			tier: cavemanTierFor(index, total),
		});
	}
	const nodes: CavemanNode[] = [];
	for (const record of context.projection.records) {
		if (record.role !== "user" && record.role !== "assistant") continue;
		if (context.protectedMessageIds.has(record.messageId)) continue;
		if (
			record.blocks !== undefined &&
			(record.blocks.length !== 1 || record.blocks[0]?.type !== "text")
		)
			continue;
		if (record.text.length < context.config.caveman_text_compression.min_chars)
			continue;
		const tag = byMessageId.get(record.messageId);
		if (tag === undefined || tag.tier === undefined) continue;
		nodes.push({
			messageId: record.messageId,
			text: record.text,
			tagNumber: tag.tagNumber,
			depth: tag.depth,
			tier: tag.tier,
		});
	}
	return nodes;
}

export interface CavemanSelection {
	readonly requests: readonly NodeOpRequest[];
	/** Depth to persist once the edits land (tag number ⇒ depth). */
	readonly depths: readonly {
		readonly tagNumber: number;
		readonly depth: number;
	}[];
}

export function selectCavemanDetailed(context: LaneContext): CavemanSelection {
	if (context.config.caveman_text_compression.enabled !== true)
		return { requests: [], depths: [] };
	if (context.rules.role !== "primary") return { requests: [], depths: [] };
	const nodes = eligible(context);
	const requests: NodeOpRequest[] = [];
	const depths: { tagNumber: number; depth: number }[] = [];
	for (const node of nodes) {
		const target = CAVEMAN_DEPTH[node.tier];
		// Already at (or past) the target depth: the transform is not a fixed
		// point, so the depth — not a byte comparison — is the idempotency key.
		if (node.depth >= target) continue;
		const compressed = cavemanCompress(node.text, node.tier);
		if (compressed === node.text || compressed.length === 0) continue;
		requests.push({
			messageId: node.messageId,
			content: [{ type: "text", text: compressed }],
		});
		depths.push({ tagNumber: node.tagNumber, depth: target });
	}
	return { requests, depths };
}

export function selectCaveman(context: LaneContext): NodeOpRequest[] {
	return [...selectCavemanDetailed(context).requests];
}

export const cavemanLane: Lane = {
	name: "caveman",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const selection = selectCavemanDetailed(context);
		return {
			requests: selection.requests,
			...(selection.requests.length > 0
				? {
						reason: `compressed ${String(selection.requests.length)} aged message(s)`,
						// Persist the applied depth with the decision, so a restart
						// resumes at the tier the node already reached.
						decision: async () => {
							for (const entry of selection.depths) {
								updateCavemanDepth(
									context.db,
									context.mcSession,
									entry.tagNumber,
									entry.depth,
								);
							}
							return { compressed: selection.depths };
						},
					}
				: {}),
		};
	},
};
