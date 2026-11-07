/**
 * Lane gating (T022).
 *
 * The shared core decides WHAT to reclaim; this module decides WHEN a lane may
 * act on a DSH session. The policy is the core's, expressed in the two
 * dimensions DSH exposes:
 *
 * - **Rebuild permission** — a pass may only apply new decisions when the core
 *   scheduler says `execute`, when the band is at/above force, when the request
 *   is at the refuse wall, or when a managed change is already landing this
 *   pass (its prefix is busted anyway, so riding it costs nothing extra).
 *   Without permission a pass may still replay frozen decisions, never invent
 *   new ones.
 * - **Episode** — on a primary session a routine lane applies at most ONCE per
 *   pressure episode (the episode ends when the band falls below `execute`),
 *   while a subagent applies on every permitted pass: a child is short-lived
 *   and can afford the churn, and its caller is blocked on it. The emergency
 *   lane is the exception on both: it only runs from the force band, and once
 *   per episode on a primary.
 *
 * State is intentionally in-memory and per process: an episode is a property
 * of the live pressure curve, and a restart re-derives it from the next
 * reading. Every decision that matters is already durable in the store, so a
 * lost episode set can only cost one redundant (idempotent) pass.
 */
import type { McSessionRole } from "../sessions/mapping.js";

/** Band vocabulary shared with the pressure meter (`meter.lane()`). */
export type PressureLane = "below-execute" | "execute" | "force" | "refuse";

/** What the scheduler and the band say about this pass. */
export interface RebuildInputs {
	readonly schedulerAllows: boolean;
	readonly band: PressureLane;
	/** A managed change already landed this pass (its prefix is already paid for). */
	readonly managedChangeLanded?: boolean;
}

export interface RebuildPermission {
	readonly permitted: boolean;
	/** Why permission was granted (first match); absent when refused. */
	readonly reason?:
		| "scheduler"
		| "force-band"
		| "refuse-wall"
		| "managed-change";
}

/** Compute rebuild permission for one pass. */
export function rebuildPermission(inputs: RebuildInputs): RebuildPermission {
	if (inputs.schedulerAllows) return { permitted: true, reason: "scheduler" };
	if (inputs.band === "force") return { permitted: true, reason: "force-band" };
	if (inputs.band === "refuse")
		return { permitted: true, reason: "refuse-wall" };
	if (inputs.managedChangeLanded === true)
		return { permitted: true, reason: "managed-change" };
	return { permitted: false };
}

/** How often a lane may apply. */
export type LaneFrequency = "routine" | "emergency";

/** The lanes that participate in episode gating (head/drops are adapter-level). */
export type GatedLaneName =
	| "dedup"
	| "injection-strip"
	| "supersession"
	| "stale-reduce"
	| "caveman"
	| "temporal"
	| "auto-search"
	| "note-nudge"
	| "reduce-nudge"
	| "todo"
	| "emergency";

export interface LaneGateRequest {
	readonly sessionId: string;
	readonly lane: GatedLaneName;
	readonly frequency: LaneFrequency;
	readonly role: McSessionRole;
	readonly band: PressureLane;
	readonly permission: RebuildPermission;
}

/**
 * Per-session episode gate. `allows` is pure with respect to the store: it
 * reads and updates only in-memory episode sets, and records a lane as applied
 * only when the caller says the lane actually changed something (`commit`),
 * so a lane that selected nothing does not burn its episode slot.
 */
export class LaneGates {
	private readonly applied = new Map<string, Set<GatedLaneName>>();

	/** Whether `lane` may apply on this pass (without consuming its slot). */
	allows(request: LaneGateRequest): boolean {
		if (!request.permission.permitted) return false;
		// Emergency selection is a force-band tool: it never runs on a routine
		// execute pass, where age-based dropping would be noise.
		if (
			request.frequency === "emergency" &&
			request.band !== "force" &&
			request.band !== "refuse"
		)
			return false;
		if (request.role === "subagent") return true;
		return !this.episode(request.sessionId).has(request.lane);
	}

	/** Consume the lane's episode slot after it changed the surface. */
	commit(sessionId: string, lane: GatedLaneName, role: McSessionRole): void {
		if (role === "subagent") return;
		this.episode(sessionId).add(lane);
	}

	/** Below the execute band a new episode begins: routine lanes re-arm. */
	resetEpisode(sessionId: string): void {
		this.applied.delete(sessionId);
	}

	/** Which lanes already applied in the current episode (observability). */
	snapshot(sessionId: string): readonly GatedLaneName[] {
		return [...(this.applied.get(sessionId) ?? [])];
	}

	detach(sessionId: string): void {
		this.applied.delete(sessionId);
	}

	detachAll(): void {
		this.applied.clear();
	}

	private episode(sessionId: string): Set<GatedLaneName> {
		let set = this.applied.get(sessionId);
		if (set === undefined) {
			set = new Set();
			this.applied.set(sessionId, set);
		}
		return set;
	}
}
