/**
 * Emergency drop lane (T026).
 *
 * At the force band the routine lanes have already had their pass; if the
 * session is still above the ceiling, the only thing left to reclaim is aged
 * tool output. The core's `planEmergencyDrop` decides which tool tags to
 * retire, in age tiers, against a token target derived from the ceiling and
 * the measured floor — this module supplies the DSH inputs and materializes
 * nothing itself (the drop lane drains the queue, exactly like supersession).
 *
 * Two inputs are DSH-specific and deliberate:
 * - **floor tags** are the ENTIRE active tag set (all types): their served
 *   mass is what the plan calls the irreducible floor. Passing only tool tags
 *   would fold real conversation into the floor and systematically
 *   under-evict.
 * - **the episode latch** is the core's persisted `last_emergency_input_sample`:
 *   zero means this pressure episode has not dropped yet, non-zero means it
 *   already had its originating batch. Re-using the core's latch (rather than
 *   an adapter counter) keeps a restart from re-dropping on every pass.
 */

import {
	getEmergencyInputSample,
	setEmergencyDropSample,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import {
	getActiveTagsBySession,
	getMaxTagNumberBySession,
} from "@magic-context/core/features/magic-context/storage-tags";
import { planEmergencyDrop } from "@magic-context/core/hooks/magic-context/emergency-drop";
import { resolveExecuteThresholdPercentage } from "../pressure/meter.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

export interface EmergencySelection {
	readonly tagIds: readonly number[];
	readonly reclaimTokens: number;
	readonly reason: string;
}

/**
 * Pure selector wrapper. Returns no tags whenever the core says the plan is a
 * no-op (unknown ceiling, unknown usage, nothing left, or the latch is held).
 */
export function selectEmergencyDrop(context: LaneContext): EmergencySelection {
	const usage = context.pressure ?? {};
	const tags = getActiveTagsBySession(context.db, context.mcSession);
	const ceilingTokens =
		usage.contextWindow !== undefined
			? Math.floor(
					(usage.contextWindow *
						resolveExecuteThresholdPercentage(context.config)) /
						100,
				)
			: 0;
	const plan = planEmergencyDrop({
		tags: tags.filter((tag) => tag.type === "tool"),
		protectedTools: context.config.protected_tools,
		floorTags: tags,
		maxTag: getMaxTagNumberBySession(context.db, context.mcSession) ?? 0,
		protectedCutoff: null,
		...(usage.percentage !== undefined
			? { usagePercentage: usage.percentage }
			: {}),
		currentTotalInputTokens: usage.pressureTokens ?? 0,
		ceilingTokens,
		priorInputSample: getEmergencyInputSample(context.db, context.mcSession),
		hasPriorDrop: getEmergencyInputSample(context.db, context.mcSession) > 0,
	});
	return {
		tagIds: plan.shouldDrop ? [...plan.tagNumbers] : [],
		reclaimTokens: plan.reclaimTokens,
		reason: plan.reason,
	};
}

export const emergencyDropLane: Lane = {
	name: "emergency",
	frequency: "emergency",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const selection = selectEmergencyDrop(context);
		if (selection.tagIds.length === 0)
			return { requests: [], reason: selection.reason };
		return {
			// Queue only: the drop lane materializes on the next pass, so a crash
			// between decision and effect replays instead of double-dropping.
			requests: [],
			decision: async () => {
				for (const tagId of selection.tagIds)
					queuePendingOp(context.db, context.mcSession, tagId, "drop");
				// Latch the episode only once content actually leaves.
				setEmergencyDropSample(
					context.db,
					context.mcSession,
					context.pressure?.pressureTokens ?? 0,
				);
				return {
					queuedTagIds: selection.tagIds,
					reclaimTokens: selection.reclaimTokens,
				};
			},
			reason: `queued ${String(selection.tagIds.length)} aged tool tag(s) (${selection.reason})`,
		};
	},
};
