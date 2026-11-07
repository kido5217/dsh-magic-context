/**
 * Reclaim lanes (T025): supersession and stale-`ctx_reduce` strip.
 *
 * Both are the core's own selectors, called with the tag-space inputs the
 * adapter can now supply (tool tags carry `toolName` + `toolOwnerMessageId`
 * after `sessions/tool-identity.ts` joined the log).
 *
 * Division of labour, deliberately the same as the other harnesses:
 * - the SELECTOR decides which tool tags are spent control-plane output
 *   (superseded `todowrite`/`ctx_reduce`/zero-value meta tools, `ctx_note`
 *   read/dismiss, and duplicates of a newer call);
 * - the DECISION queues those tags through the core queue (`queuePendingOp`),
 *   which is idempotent and survives a restart;
 * - the MATERIALIZER is the drop lane, which on the next pass drains the queue
 *   through `applyPendingOperations` and rewrites each node.
 *
 * The queue-then-materialize split is what makes this lane safe under a crash:
 * a decision written without its surface effect simply replays, and the store
 * — not the surface — is the single source of truth for what was decided.
 */

import {
	getPendingOps,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage-ops";
import { getActiveTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import type { TagEntry } from "@magic-context/core/features/magic-context/types";
import {
	buildSupersessionReclaimOps,
	recentSupersessionOwnerMessageIds,
} from "@magic-context/core/hooks/magic-context/supersession-reclaim";
import type { TagTarget } from "@magic-context/core/hooks/magic-context/tag-messages";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

/**
 * Minimal tag targets for the core selectors.
 *
 * A `TagTarget` is the selector's view of "what would a write do here": it can
 * report whether a drop is possible and read the call's input. The adapter
 * materializes through node operations instead of the target's own writers, so
 * `setContent` is intentionally not implemented — `canDrop` is the only
 * contract the selectors use for selection, and `planNodeOps` revalidates the
 * live surface before anything is written.
 */
export function laneTargets(
	tags: readonly TagEntry[],
	readInput?: (toolName: string) => Record<string, unknown> | null,
): Map<number, TagTarget> {
	const targets = new Map<number, TagTarget>();
	for (const tag of tags) {
		targets.set(tag.tagNumber, {
			canDrop: () => true,
			setContent: () => false,
			...(readInput !== undefined && tag.toolName !== null
				? { readInput: () => readInput(tag.toolName!) }
				: {}),
		} as unknown as TagTarget);
	}
	return targets;
}

/** Tags whose owner message sits in the verbatim protected tail. */
export function protectedTagNumbers(
	tags: readonly TagEntry[],
	protectedMessageIds: ReadonlySet<string>,
): Set<number> {
	const protectedNumbers = new Set<number>();
	for (const tag of tags) {
		const owner = tag.type === "tool" ? tag.toolOwnerMessageId : tag.messageId;
		if (owner !== null && protectedMessageIds.has(owner))
			protectedNumbers.add(tag.tagNumber);
	}
	return protectedNumbers;
}

export interface SupersessionSelection {
	readonly tagIds: readonly number[];
	readonly ops: readonly {
		readonly tagId: number;
		readonly operation: string;
	}[];
}

/** Pure selector wrapper: which tags the core wants dropped as superseded. */
export function selectSupersession(
	context: LaneContext,
): SupersessionSelection {
	const tags = getActiveTagsBySession(context.db, context.mcSession);
	const targets = laneTargets(tags);
	const ops = buildSupersessionReclaimOps({
		db: context.db,
		sessionId: context.mcSession,
		targets,
		pendingOps: getPendingOps(context.db, context.mcSession),
		protectedTools: context.config.protected_tools,
		recentMessageIds: recentSupersessionOwnerMessageIds(
			context.db,
			context.mcSession,
		),
		protectedTagNumbers: protectedTagNumbers(tags, context.protectedMessageIds),
	});
	return {
		tagIds: ops.map((op) => op.tagId).sort((left, right) => left - right),
		ops: ops.map((op) => ({ tagId: op.tagId, operation: op.operation })),
	};
}

export const supersessionLane: Lane = {
	name: "supersession",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const selection = selectSupersession(context);
		if (selection.tagIds.length === 0) return { requests: [] };
		return {
			// No surface request: this lane's product is a durable QUEUE entry,
			// materialized by the drop lane on the next pass (see the module doc).
			requests: [],
			decision: async () => {
				for (const tagId of selection.tagIds)
					queuePendingOp(context.db, context.mcSession, tagId, "drop");
				return { queuedTagIds: selection.tagIds };
			},
			reason: `queued ${String(selection.tagIds.length)} superseded tool tag(s)`,
		};
	},
};
