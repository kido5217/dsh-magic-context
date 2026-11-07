/**
 * Delta node renderer (T042) — the volatile half of the DSH head.
 *
 * The delta is the core m[1] itself (`renderSessionDelta`, T040): memory
 * updates after the frozen `maxMemoryMutationId`, compartments after
 * `maxCompartmentSeq` (always tier 1), memories after `maxMemoryId`, and
 * the profile when its version advanced — all computed against the
 * baseline's FROZEN markers, including `materializedAt`, which the core
 * renderer reuses from the markers rather than the clock. An empty delta
 * renders the core placeholder form, never an empty node.
 *
 * Position is the only deviation from the other harnesses: on OpenCode/Pi
 * the delta is a request-side message before the live tail; on DSH it is a
 * durable node AFTER the current tail, so replacing it cannot invalidate
 * any cached prefix bytes.
 */
import {
	type M0SnapshotMarkers,
	type RenderM1Result,
	renderSessionDelta,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import type { DshLogProjection } from "./dsh-session-log.js";
import type { BaselineRenderer } from "./head-baseline.js";
import { syncProjectionTimes } from "./projection-times.js";

export interface DeltaContext {
	readonly mcSession: string;
	/** Present on eligible passes; publishes boundary times the delta dates need. */
	readonly projection?: DshLogProjection;
}

export class DeltaRenderer {
	constructor(private readonly baseline: BaselineRenderer) {}

	/**
	 * One delta render against the frozen cursors. Byte-stable between
	 * eligible passes by construction: the inputs are the frozen markers,
	 * the same option set the baseline froze, and the shared store — a
	 * background memory write only appends, which surfaces here, never in
	 * the baseline.
	 */
	render(
		context: DeltaContext,
		markers: M0SnapshotMarkers,
		renderedMemoryIds: readonly number[],
	): RenderM1Result {
		if (context.projection !== undefined)
			syncProjectionTimes(
				this.baseline.db,
				context.mcSession,
				context.projection,
			);
		return renderSessionDelta(
			this.baseline.coreOptions(context.mcSession),
			markers,
			renderedMemoryIds,
		);
	}
}
