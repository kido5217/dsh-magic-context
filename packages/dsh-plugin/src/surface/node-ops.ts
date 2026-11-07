/**
 * Node operations (T016) — the durable single-node surface edits every
 * reduction lane is built from.
 *
 * The host admits exactly three shapes of plugin surface edit (0.2.2-rc.1):
 * append a node, replace a range of nodes with a `user/message` node, or
 * rewrite one current `tool/result` node's content while preserving every
 * other field. Magic Context's lanes need all three, but they must never be
 * applied blind: the store decision names messages by durable id, and by the
 * time the effect runs the surface may have moved on (a fold landed, a node
 * was already rewritten, the session was resumed from a shorter log).
 *
 * This module is the single place where a durable id becomes a live node and
 * where the host's per-shape rules are enforced:
 *
 * 1. **Plan before effect.** Every request is revalidated against the live
 *    surface and the current projection first; the plan records exactly one
 *    current node per request (never a range, never an inferred neighbour).
 * 2. **Shape by role.** A tool result is rewritten in place (identity
 *    preserved, tool pairing untouched); any other conversation node is
 *    replaced by a fresh plugin-sourced `user/message`. Nothing else is
 *    editable — an assistant body has no host-sanctioned in-place rewrite.
 * 3. **Decision before effect.** `applyNodeOps` runs inside a managed bracket
 *    supplied by the caller (`runNodeOpsInBracket`), so a store failure can
 *    never leave a surface edit without the decision that justifies it.
 *
 * A request whose target is no longer current is *skipped*, not thrown: the
 * message was already reduced (or folded into a compartment), which is the
 * outcome the decision wanted. Skipping keeps a deferred pass idempotent;
 * only a malformed request (unknown role, empty content) is an error.
 */

import type { DshSession } from "../host.js";
import type {
	DshLogMessageRecord,
	DshLogProjection,
} from "./dsh-session-log.js";
import type { McManagedChangeKind, McReplacementContent } from "./events.js";
import type { ManagedEdits, ShadowInfo } from "./managed-edits.js";

/** Why a node operation could not be planned. */
export type NodeOpRefusal =
	| "not-current"
	| "unknown-target"
	| "empty-content"
	| "not-tool-result"
	| "not-user-message";

/** A malformed node operation (a caller bug), as opposed to a stale target. */
export class NodeOpError extends Error {
	public override readonly name = "NodeOpError";

	constructor(
		message: string,
		readonly reason: NodeOpRefusal,
	) {
		super(message);
	}
}

/** The two node shapes a lane may produce. */
export type NodeOpKind =
	| "tool-result-rewrite"
	| "user-rewrite"
	| "assistant-rewrite";

/** One requested content change, anchored on a durable message id. */
export interface NodeOpRequest {
	/** Durable message id (the store's tag `messageId`), not a seq. */
	readonly messageId: string;
	readonly content: McReplacementContent;
}

/** A planned operation: the live node it targets and the shape to use. */
export interface PlannedNodeOp {
	readonly messageId: string;
	readonly seq: number;
	readonly role: string;
	readonly kind: NodeOpKind;
	readonly content: McReplacementContent;
	/** Mutation applied by the plan (a rewrite, not a stored value). */
	/** The record the op was planned from (kept for lane bookkeeping). */
	readonly record: DshLogMessageRecord;
}

/** Result of applying one planned op. */
export interface AppliedNodeOp {
	readonly messageId: string;
	readonly seq: number;
	readonly kind: NodeOpKind;
	readonly replacementSeq: number;
}

/** Why a request did not become an op. */
export interface SkippedNodeOp {
	readonly messageId: string;
	readonly reason: NodeOpRefusal;
}

export interface NodeOpPlan {
	readonly ops: readonly PlannedNodeOp[];
	readonly skipped: readonly SkippedNodeOp[];
}

/** Which hosts shape a given role projects to. */
export function nodeOpKindForRole(role: string): NodeOpKind | undefined {
	if (role === "tool") return "tool-result-rewrite";
	// `user` is the only replaceable conversation role: a replacement node is
	// itself a `user/message`, so replacing an assistant or system node with
	// one would rewrite the transcript's authorship (and the host refuses a
	// system replacement that is not a system/message).
	if (role === "user") return "user-rewrite";
	// An assistant body has no surface replacement (it embeds its source
	// stream), but the projection lane rewrites its content in place: node
	// membership and identity survive, and a log replayed without this plugin
	// degrades to the original body (T004 verdict).
	if (role === "assistant") return "assistant-rewrite";
	return undefined;
}

/**
 * Plan a batch of node operations against the current surface.
 *
 * Pure: reads the session's node list and the caller's projection, and never
 * mutates. Requests naming a message that is not a current surface node are
 * skipped with `not-current` (already reduced or folded); a role with no
 * sanctioned edit is skipped with the role's refusal reason.
 */
export function planNodeOps(
	session: DshSession,
	projection: DshLogProjection,
	requests: readonly NodeOpRequest[],
): NodeOpPlan {
	const nodes = new Set(session.surfaceNodes());
	const ops: PlannedNodeOp[] = [];
	const skipped: SkippedNodeOp[] = [];
	const planned = new Set<number>();
	for (const request of requests) {
		if (request.content.length === 0)
			throw new NodeOpError(
				`node op for ${request.messageId} has empty content`,
				"empty-content",
			);
		const record = projection.records.find(
			(candidate) => candidate.messageId === request.messageId,
		);
		if (record === undefined) {
			skipped.push({ messageId: request.messageId, reason: "unknown-target" });
			continue;
		}
		if (!nodes.has(record.seq) || planned.has(record.seq)) {
			skipped.push({ messageId: request.messageId, reason: "not-current" });
			continue;
		}
		const kind = nodeOpKindForRole(record.role);
		if (kind === undefined) {
			skipped.push({
				messageId: request.messageId,
				reason: record.role === "tool" ? "not-tool-result" : "not-user-message",
			});
			continue;
		}
		planned.add(record.seq);
		ops.push({
			messageId: request.messageId,
			seq: record.seq,
			role: record.role,
			kind,
			content: request.content,
			record,
		});
	}
	return { ops, skipped };
}

/**
 * Apply one planned op. The caller owns ordering and failure policy; the host
 * rules (one node, content-only tool rewrite) are enforced inside the session
 * seam, and re-checked here so a double behaves the same as production.
 */
export async function applyPlannedNodeOp(
	session: DshSession,
	op: PlannedNodeOp,
): Promise<AppliedNodeOp> {
	if (op.kind === "tool-result-rewrite") {
		const { replacementSeq } = await session.rewriteToolResult(
			op.seq,
			op.content,
		);
		return {
			messageId: op.messageId,
			seq: op.seq,
			kind: op.kind,
			replacementSeq,
		};
	}
	if (op.kind === "assistant-rewrite") {
		const { eventSeq } = await session.rewriteAssistantBody(op.seq, op.content);
		return {
			messageId: op.messageId,
			seq: op.seq,
			kind: op.kind,
			replacementSeq: eventSeq,
		};
	}
	const { replacementSeq } = await session.rewriteUserMessage(
		op.seq,
		op.content,
	);
	return {
		messageId: op.messageId,
		seq: op.seq,
		kind: op.kind,
		replacementSeq,
	};
}

/** Apply a plan in surface order, collecting every applied op. */
export async function applyNodeOps(
	session: DshSession,
	plan: NodeOpPlan,
): Promise<AppliedNodeOp[]> {
	const ordered = [...plan.ops].sort((left, right) => left.seq - right.seq);
	const applied: AppliedNodeOp[] = [];
	for (const op of ordered) applied.push(await applyPlannedNodeOp(session, op));
	return applied;
}

export interface NodeOpBracketRequest<T> {
	readonly kind: McManagedChangeKind;
	readonly changeId: string;
	readonly mcSession: string;
	/** Step 2: write the store decision; its result feeds `plan`. */
	readonly decision: () => Promise<T>;
	/** Turn the committed decision into requests (pure; reads the live surface). */
	readonly requests: (decision: T) => readonly NodeOpRequest[];
}

export interface NodeOpBracketOutcome<T> {
	readonly shadow: ShadowInfo;
	readonly decision: T;
	readonly plan: NodeOpPlan;
	readonly applied: readonly AppliedNodeOp[];
}

/**
 * Run one batch of node operations inside a managed bracket: decision first,
 * then plan, then effects, bracketed by `mc/manage-start…end`. The bracket's
 * shadow bookkeeping lists every rewritten node, so a replacement is traceable
 * to the decision that produced it (the compaction precedent).
 */
export async function runNodeOpsInBracket<T>(
	managedEdits: ManagedEdits,
	session: DshSession,
	projection: DshLogProjection,
	request: NodeOpBracketRequest<T>,
): Promise<NodeOpBracketOutcome<T>> {
	let plan: NodeOpPlan = { ops: [], skipped: [] };
	let applied: readonly AppliedNodeOp[] = [];
	let decision: T | undefined;
	const shadow = await managedEdits.runManagedChange(
		request.kind,
		request.changeId,
		request.mcSession,
		{
			decision: async () => {
				decision = await request.decision();
				return decision;
			},
			// Plan and apply AFTER the store decision committed: a store failure
			// then leaves the surface untouched (the decision replays), while a
			// surface failure closes the bracket with the decision already
			// durable — the documented replay-or-refuse case, never an
			// unmanaged write.
			effect: async (committed) => {
				plan = planNodeOps(session, projection, request.requests(committed));
				applied = await applyNodeOps(session, plan);
				const shadowedSeqs = applied.map((op) => op.seq);
				const replacementSeq =
					applied.length === 1 ? applied[0]!.replacementSeq : undefined;
				return {
					...(replacementSeq !== undefined ? { replacementSeq } : {}),
					...(shadowedSeqs.length > 0 ? { shadowedSeqs } : {}),
				};
			},
		},
	);
	return { shadow, decision: decision as T, plan, applied };
}
