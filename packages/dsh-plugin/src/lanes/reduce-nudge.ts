/**
 * `ctx_reduce` nudge lane — channel 2 (T033).
 *
 * When a session's tail is mostly spent tool output, the cheapest reclaim is
 * the agent's own `ctx_reduce`: it knows which outputs it already used. The
 * core owns the whole policy — the predicate (`evaluateChannel2`: floor,
 * severity, minimum tail), the copy (`buildChannel2Reminder`) and the hint
 * format — and this lane supplies the DSH measurement plus delivery.
 *
 * Measurement: the durable projection is priced with the same estimator the
 * core uses for budgets. `T` (tail tokens) is every projected message;
 * `U` (reclaimable) is the tool output still active — the part a `ctx_reduce`
 * could actually stamp. Both are estimates, and the predicate is built to
 * tolerate that: it refuses to fire below its floor.
 *
 * Delivery: a TAIL notice. Channel 1 (the post-execute verdict) is a different
 * seam and is not wired here yet — on DSH a tool result can be rewritten by
 * `tools/post-execute`, which is where channel 1's "your next step" would ride.
 * The lease below is per process and per episode, so one nudge is delivered per
 * pressure episode rather than on every pass.
 */

import { getActiveTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import {
	buildChannel1Reminder,
	buildChannel2Reminder,
	type Channel1Level,
	decideChannel1,
	evaluateChannel2,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { isAdapterSurfaceId } from "../surface/dsh-session-log.js";
import type { McReplacementContent } from "../surface/events.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

export interface Channel2Measurement {
	readonly tailTokens: number;
	readonly reclaimableTokens: number;
	readonly shouldTrigger: boolean;
	readonly reason: string;
}

/** Price the tail and the reclaimable tool output from the durable projection. */
export function measureChannel2(context: LaneContext): Channel2Measurement {
	const activeToolOwners = new Set<string>();
	for (const tag of getActiveTagsBySession(context.db, context.mcSession)) {
		if (tag.type === "tool" && tag.toolOwnerMessageId !== null)
			activeToolOwners.add(tag.messageId);
	}
	let tailTokens = 0;
	let reclaimableTokens = 0;
	for (const record of context.projection.records) {
		if (isAdapterSurfaceId(record.messageId)) continue;
		const cost = estimateTokens(record.text);
		tailTokens += cost;
		if (record.role === "tool" && record.toolCallId !== undefined)
			reclaimableTokens += cost;
	}
	const evaluation = evaluateChannel2({
		evaluable: true,
		baselineU: reclaimableTokens,
		baselineT: tailTokens,
		turnDeltaU: 0,
		turnDeltaT: 0,
		generationInvalidated: false,
	});
	return {
		tailTokens,
		reclaimableTokens,
		shouldTrigger: evaluation.shouldTrigger,
		reason: evaluation.verdictReason,
	};
}

/** One nudge per pressure episode, per session. */
export class Channel2Lease {
	private readonly delivered = new Set<string>();

	/** Claim delivery for this episode; false when already delivered. */
	claim(sessionId: string): boolean {
		if (this.delivered.has(sessionId)) return false;
		this.delivered.add(sessionId);
		return true;
	}

	reset(sessionId: string): void {
		this.delivered.delete(sessionId);
	}

	detachAll(): void {
		this.delivered.clear();
	}
}

export const channel2Lease = new Channel2Lease();

export function selectReduceNudge(
	context: LaneContext,
	lease: Channel2Lease = channel2Lease,
): McReplacementContent | undefined {
	const measurement = measureChannel2(context);
	if (!measurement.shouldTrigger) return undefined;
	// The lease is claimed only when the pass can actually deliver: claiming at
	// selection time would burn the episode on a pass the gate refused.
	if (!lease.claim(context.mcSession)) return undefined;
	return [
		{
			type: "text",
			text: buildChannel2Reminder(
				measurement.reclaimableTokens,
				countReclaimable(context),
			),
		},
	];
}

function countReclaimable(context: LaneContext): number {
	let count = 0;
	for (const tag of getActiveTagsBySession(context.db, context.mcSession)) {
		if (tag.type === "tool") count += 1;
	}
	return count;
}

export const reduceNudgeLane: Lane = {
	name: "reduce-nudge",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const content = selectReduceNudge(context);
		if (content === undefined) return { requests: [] };
		return {
			requests: [],
			tail: content,
			reason: "delivered the ctx_reduce channel-2 nudge",
		};
	},
};

/**
 * Channel 1 — the post-execute verdict (T033 second half).
 *
 * Channel 1 is the "your next step" nudge: it rides the tool result that the
 * agent just produced, so the reminder lands exactly where the decision about
 * that output is being made. On DSH that seam is `tools/post-execute`, whose
 * `accept` decision can attach user-visible context for the next request —
 * the durable analogue of the other harnesses' post-tool injection.
 *
 * The core decides WHEN (its growth/band/dampening state machine, including
 * post-reduce grace); this module keeps the per-session memory the machine
 * needs and turns its verdict into the core's own reminder copy.
 */
export interface Channel1State {
	lastNudgeUndropped: number;
	lastNudgeLevel: Channel1Level | "";
	lastFireOrdinal: number;
}

export class Channel1Tracker {
	private readonly states = new Map<string, Channel1State>();

	read(sessionId: string): Channel1State {
		const existing = this.states.get(sessionId);
		if (existing !== undefined) return existing;
		const created: Channel1State = {
			lastNudgeUndropped: 0,
			lastNudgeLevel: "",
			lastFireOrdinal: 0,
		};
		this.states.set(sessionId, created);
		return created;
	}

	/** A `ctx_reduce` call was observed: the next decision starts from grace. */
	noteReduce(sessionId: string): void {
		const state = this.read(sessionId);
		state.lastNudgeUndropped = 0;
		state.lastNudgeLevel = "";
	}

	detachAll(): void {
		this.states.clear();
	}
}

export interface Channel1Verdict {
	readonly fire: boolean;
	readonly text?: string;
	readonly level: Channel1Level;
	readonly reason: string;
}

/**
 * Decide and render one channel-1 nudge. `hasRecentReduce` suppresses the
 * nudge right after the agent already acted on it.
 */
export function decideChannel1For(
	context: LaneContext,
	tracker: Channel1Tracker,
	hasRecentReduce: boolean,
): Channel1Verdict {
	const measurement = measureChannel2(context);
	const state = tracker.read(context.mcSession);
	const decision = decideChannel1({
		baselineU: measurement.reclaimableTokens,
		baselineT: measurement.tailTokens,
		turnDeltaU: 0,
		turnDeltaT: 0,
		lastNudgeUndropped: state.lastNudgeUndropped,
		lastNudgeLevel: state.lastNudgeLevel,
		lastFireOrdinal: state.lastFireOrdinal,
		hasRecentReduce,
		agentDropsAppliedThisPass: false,
	});
	if (!decision.fire) {
		return {
			fire: false,
			level: decision.level,
			reason: decision.verdictReason,
		};
	}
	state.lastNudgeUndropped = decision.nextLastNudge;
	state.lastNudgeLevel = decision.nextLastNudgeLevel;
	state.lastFireOrdinal += 1;
	return {
		fire: true,
		level: decision.level,
		reason: decision.verdictReason,
		text: buildChannel1Reminder(
			decision.level,
			decision.undroppedTokens,
			countReclaimable(context),
			undefined,
			decision.sticky,
		).trim(),
	};
}
