/**
 * Lane engine (T023).
 *
 * One pass runs an ordered list of lanes. Each lane is a pure SELECTOR over the
 * current projection (plus store state) that returns the node operations it
 * wants — never a surface write. The engine then:
 *
 *   gate → select → (nothing selected ⇒ no bracket) → one managed bracket →
 *   record the outcome.
 *
 * Three properties make the pass safe:
 *
 * 1. **Containment.** A lane that throws fails only its own application for
 *    this pass: the engine records the error, closes any bracket the managed
 *    edit layer opened, and returns the other lanes' outcomes. It never turns
 *    into an unmanaged request and never leaves a half-applied span (each node
 *    op is one durable edit and the plan is validated before any write).
 * 2. **One bracket per lane.** A lane's edits share one `mc/manage-<lane>`
 *    bracket with the decision that produced them, so a crash between decision
 *    and effect is visible as an open bracket and replays.
 * 3. **Determinism.** Selection is a pure function of (projection, store,
 *    config). Re-running the same pass state renders the same bytes, which is
 *    what keeps the provider prefix stable across deferred passes.
 *
 * The engine does not decide WHICH lanes exist or when they are allowed — the
 * caller supplies the ordered lane list and the gate request; `LaneGates`
 * supplies the episode policy.
 */
import { randomUUID } from "node:crypto";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { log } from "@magic-context/core/shared/logger";
import type { DshSession } from "../host.js";
import type { McRoleRules } from "../sessions/subagent-rules.js";
import type { DshLogProjection } from "../surface/dsh-session-log.js";
import type { McManagedChangeKind } from "../surface/events.js";
import type { ManagedEdits } from "../surface/managed-edits.js";
import {
	type AppliedNodeOp,
	applyNodeOps,
	type NodeOpRequest,
	planNodeOps,
	type SkippedNodeOp,
} from "../surface/node-ops.js";
import type {
	GatedLaneName,
	LaneFrequency,
	LaneGateRequest,
	LaneGates,
	PressureLane,
	RebuildPermission,
} from "./gating.js";

/** Everything a selector may read. Selectors must not write. */
export interface LaneContext {
	readonly session: DshSession;
	readonly mcSession: string;
	readonly projection: DshLogProjection;
	readonly rules: McRoleRules;
	readonly band: PressureLane;
	readonly permission: RebuildPermission;
	readonly config: MagicContextConfig;
	/** Store handle for selectors that read tag/pending state. */
	readonly db: ContextDatabase;
	/** Message ids in the verbatim protected tail (never reclaim targets). */
	readonly protectedMessageIds: ReadonlySet<string>;
	/** Current pressure reading, for lanes that plan against a token target. */
	readonly pressure?: LanePressure;
}

/** The pressure facts a lane may price against. */
export interface LanePressure {
	readonly pressureTokens?: number;
	readonly contextWindow?: number;
	readonly percentage?: number;
}

/** A selector's answer for one pass. */
export interface LaneSelection {
	/** Node edits to apply. An empty list means "nothing to do". */
	readonly requests: readonly NodeOpRequest[];
	/** Store-side decision payload, written BEFORE the surface effect. */
	readonly decision?: () => Promise<unknown>;
	/** Optional human-readable reason, recorded in the outcome. */
	readonly reason?: string;
}

export interface Lane {
	readonly name: GatedLaneName;
	readonly frequency: LaneFrequency;
	/** Managed-change kind recorded on the bracket. */
	readonly changeKind: McManagedChangeKind;
	select(context: LaneContext): Promise<LaneSelection> | LaneSelection;
}

/** The outcome of one lane on one pass. */
export interface LaneOutcome {
	readonly lane: GatedLaneName;
	/** False when the gate refused the lane (no selection ran). */
	readonly ran: boolean;
	readonly changed: boolean;
	readonly applied: readonly AppliedNodeOp[];
	readonly skipped: readonly SkippedNodeOp[];
	readonly reason?: string;
	readonly error?: string;
}

export interface LanePassRequest {
	readonly session: DshSession;
	readonly mcSession: string;
	readonly projection: DshLogProjection;
	readonly rules: McRoleRules;
	readonly band: PressureLane;
	readonly permission: RebuildPermission;
	readonly config: MagicContextConfig;
	readonly db: ContextDatabase;
	readonly protectedMessageIds?: ReadonlySet<string>;
	readonly pressure?: LanePressure;
	readonly lanes: readonly Lane[];
	readonly gates: LaneGates;
}

export interface LanePassResult {
	readonly outcomes: readonly LaneOutcome[];
	/** Any lane changed the surface — head refresh / fold decisions need to know. */
	readonly changed: boolean;
}

/** Run the ordered lane list for one pass. Never throws for a lane failure. */
export async function runLanePass(
	managedEdits: ManagedEdits,
	request: LanePassRequest,
): Promise<LanePassResult> {
	const context: LaneContext = {
		session: request.session,
		mcSession: request.mcSession,
		projection: request.projection,
		rules: request.rules,
		band: request.band,
		permission: request.permission,
		config: request.config,
		db: request.db,
		protectedMessageIds: request.protectedMessageIds ?? new Set<string>(),
		...(request.pressure !== undefined ? { pressure: request.pressure } : {}),
	};
	const outcomes: LaneOutcome[] = [];
	let changed = false;
	for (const lane of request.lanes) {
		const gate: LaneGateRequest = {
			sessionId: request.session.id,
			lane: lane.name,
			frequency: lane.frequency,
			role: request.rules.role,
			band: request.band,
			permission: request.permission,
		};
		if (!request.gates.allows(gate)) {
			outcomes.push({
				lane: lane.name,
				ran: false,
				changed: false,
				applied: [],
				skipped: [],
			});
			continue;
		}
		const outcome = await runLane(managedEdits, lane, context, request);
		outcomes.push(outcome);
		if (outcome.changed) {
			changed = true;
			request.gates.commit(request.session.id, lane.name, request.rules.role);
		}
	}
	return { outcomes, changed };
}

async function runLane(
	managedEdits: ManagedEdits,
	lane: Lane,
	context: LaneContext,
	request: LanePassRequest,
): Promise<LaneOutcome> {
	let selection: LaneSelection;
	try {
		selection = await lane.select(context);
	} catch (error) {
		return {
			lane: lane.name,
			ran: false,
			changed: false,
			applied: [],
			skipped: [],
			error: describe(error),
		};
	}
	if (selection.requests.length === 0 && selection.decision === undefined) {
		return {
			lane: lane.name,
			ran: true,
			changed: false,
			applied: [],
			skipped: [],
			...(selection.reason !== undefined ? { reason: selection.reason } : {}),
		};
	}
	const changeId = `mc-${lane.name}-${randomUUID()}`;
	try {
		// Validate the whole batch against the live surface BEFORE any write:
		// a plan that no longer targets current nodes becomes a no-op instead of
		// a half-applied lane.
		const plan = planNodeOps(
			request.session,
			request.projection,
			selection.requests,
		);
		let writes: readonly AppliedNodeOp[] = [];
		await managedEdits.runManagedChange(
			lane.changeKind,
			changeId,
			request.mcSession,
			{
				decision: async () =>
					selection.decision !== undefined
						? await selection.decision()
						: { changeId },
				effect: async () => {
					writes = await applyNodeOps(request.session, plan);
					const shadowedSeqs = writes.map((op) => op.seq);
					return {
						...(writes.length === 1
							? { replacementSeq: writes[0]?.replacementSeq }
							: {}),
						...(shadowedSeqs.length > 0 ? { shadowedSeqs } : {}),
					};
				},
			},
		);
		const changed = writes.length > 0;
		if (changed)
			log(
				`[dsh-magic-context] lane ${lane.name} applied ${String(writes.length)} node edit(s)`,
			);
		return {
			lane: lane.name,
			ran: true,
			changed,
			applied: writes,
			skipped: plan.skipped,
			...(selection.reason !== undefined ? { reason: selection.reason } : {}),
		};
	} catch (error) {
		// Contained: the bracket is error-closed inside ManagedEdits, the
		// decision replays next pass, and the rest of the pass continues.
		log(
			`[dsh-magic-context] lane ${lane.name} failed for ${request.session.id}: ${describe(error)}`,
		);
		return {
			lane: lane.name,
			ran: true,
			changed: false,
			applied: [],
			skipped: [],
			error: describe(error),
		};
	}
}

function describe(error: unknown): string {
	return error instanceof Error
		? `${error.name}: ${error.message}`
		: String(error);
}
