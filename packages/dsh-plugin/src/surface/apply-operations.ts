/**
 * Queued drops → DSH managed changes (T016).
 *
 * The core keeps reduction policy in the shared store: `ctx_reduce`/heuristics
 * stamp drops with `queuePendingOp`; `applyPendingOperations` is the mechanism
 * that consumes the queue and persists the drop decision (tag status,
 * `drop_mode` frozen once so every later replay renders byte-identically).
 * On OpenCode/Pi the same call also rewrites the in-flight request; on DSH the
 * request is frozen (PARITY #1), so the *effect* half happens here: each drop
 * cluster becomes one managed change — a plugin-appended `user/message`
 * replacing the shadowed seq range, carrying the canonical
 * `[dropped §N§]` placeholders (`renderDroppedText`/`buildReplacementContent`,
 * pure functions of the tag number ⇒ defer passes re-render identically).
 *
 * When a queued tag's message is not in this pass's projection (already
 * folded, or never served), the core itself persists the drop on the
 * `target_absent` branch of `applyPendingOperations` — the same core baseline
 * Pi's passes rely on, never re-applied later (dropped tags never return to
 * `active`).
 *
 * Protected-recent rule: the core's recent-content protection is
 * `protected_tokens` (config/schema/magic-context.ts — `protected_tags` is
 * deprecated/no-op); the newest messages whose cumulative tokens fit the
 * budget are never auto-queued, dropped or folded. DSH v1 caps the budget by
 * the history-block share of the routed window so the protected tail shrinks
 * with the window exactly when pressure says it must.
 */
import { randomUUID } from "node:crypto";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getPendingOps,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage-ops";
import {
	getActiveTagsBySession,
	getTagsByNumbers,
} from "@magic-context/core/features/magic-context/storage-tags";
import {
	applyPendingOperations,
	buildReplacementContent,
	renderDroppedText,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import type { DshSession } from "../host.js";
import type {
	DshLogMessageRecord,
	DshLogProjection,
} from "./dsh-session-log.js";
import { isAdapterSurfaceId } from "./dsh-session-log.js";
import type { McReplacementContent } from "./events.js";
import type { ManagedEdits, ShadowInfo } from "./managed-edits.js";

export interface DropPassRequest {
	readonly session: DshSession;
	readonly mcSession: string;
	readonly projection: DshLogProjection;
	/** Auto-queue unprotected stale tags when the pass has execution rights. */
	readonly autoQueue: boolean;
	/** Tokens of newest content that stay verbatim this pass. */
	readonly protectedTailTokens: number;
}

/** Estimate one projected message in core token coordinates. */
export function recordTokenEstimate(record: DshLogMessageRecord): number {
	return estimateTokens(record.text);
}

/**
 * Split records (surface position order) at the protected-recent boundary:
 * the newest messages whose cumulative token estimate fits `budgetTokens`
 * (always at least one) are protected; the rest are eligible.
 */
export function splitProtectedTail(
	records: readonly DshLogMessageRecord[],
	budgetTokens: number,
): {
	readonly eligible: readonly DshLogMessageRecord[];
	readonly protectedTail: readonly DshLogMessageRecord[];
} {
	let acc = 0;
	let split = records.length;
	for (let i = records.length - 1; i >= 0; i -= 1) {
		const cost = recordTokenEstimate(records[i]!);
		// The newest message is always protected; older ones join the tail
		// only while they fit the verbatim budget.
		if (split < records.length && acc + cost > budgetTokens) break;
		acc += cost;
		split = i;
	}
	return {
		eligible: records.slice(0, split),
		protectedTail: records.slice(split),
	};
}

/**
 * History-block share of the routed window (core `history_budget_percentage`),
 * clamped by `protected_tokens`: pressure at the force/refuse bands must still
 * leave a foldable window, so the budget halves on an emergency pass and never
 * exceeds the history share of the routed context window.
 */
export function protectedTailBudget(
	config: Pick<
		MagicContextConfig,
		"protected_tokens" | "history_budget_percentage"
	>,
	contextWindow: number | undefined,
	emergency: boolean,
): number {
	const configured = config.protected_tokens ?? 4_000;
	const historyShare =
		contextWindow !== undefined && contextWindow > 0
			? Math.floor(contextWindow * config.history_budget_percentage)
			: configured;
	const budget = Math.min(configured, historyShare);
	return emergency ? Math.max(200, Math.floor(budget / 2)) : budget;
}

function dropNodeText(tagIds: readonly number[]): string {
	const placeholders = tagIds.map((tagId) =>
		renderDroppedText(tagId, buildReplacementContent(tagId)),
	);
	return `${placeholders.join("\n")}\n\nMagic Context reduced ${String(tagIds.length)} item(s) above. Use ctx_expand to recover any of them verbatim.`;
}

function dropNodeContent(tagIds: readonly number[]): McReplacementContent {
	return [{ type: "text", text: dropNodeText(tagIds) }];
}

/** One dropped message, resolved to the durable node it must rewrite. */
interface DropTarget {
	readonly tagNumber: number;
	readonly record: DshLogMessageRecord;
}

export interface DropChangeResult {
	/** One shadow per rewritten node, in surface order. */
	readonly shadows: readonly ShadowInfo[];
	readonly tagIds: readonly number[];
	/** Targets the surface could not rewrite (assistant bodies; the fold's job). */
	readonly deferred: readonly number[];
}

export class DropApplier {
	constructor(
		private readonly db: ContextDatabase,
		private readonly managedEdits: ManagedEdits,
	) {}

	/**
	 * Apply the session's queued drops as ONE managed change (one bracket), with
	 * one per-node edit per dropped message (T017).
	 *
	 * Per-node, not per-cluster: a tool result is rewritten in place (content
	 * only, identity preserved, tool pairing untouched) and a user message is
	 * replaced by a fresh plugin-sourced node. The old span replacement could
	 * only land as a `user/message` covering `min…max`, which swallowed every
	 * unrelated node between two drops and erased assistant turns the store had
	 * never decided to reduce.
	 *
	 * Assistant bodies have no in-place rewrite (PARITY: the projection lane
	 * owns them); a queued assistant target is reported in `deferred` and left
	 * for the fold, which summarizes it instead.
	 */
	async applyQueuedDrops(
		request: DropPassRequest,
	): Promise<DropChangeResult | null> {
		const { session, mcSession, projection } = request;
		const surfaceSeqs = new Set(session.surfaceNodes());
		// Protected-tail budget accounts for REAL conversation only: adapter
		// nodes (head, drop clusters) are derived artifacts that are never
		// reclaim targets and must not consume the verbatim budget.
		const tail = splitProtectedTail(
			projection.records.filter(
				(record) => !isAdapterSurfaceId(record.messageId),
			),
			request.protectedTailTokens,
		);
		const protectedSeqs = new Set(
			tail.protectedTail.map((record) => record.seq),
		);

		// Decision input: what this pass may stamp (auto-queue) and what is
		// already queued (agent ctx_reduce stamps land here too).
		const queueable: number[] = [];
		if (request.autoQueue) {
			const active = getActiveTagsBySession(this.db, mcSession).filter(
				(tag) => tag.type === "message",
			);
			for (const tag of active.sort(
				(left, right) => left.tagNumber - right.tagNumber,
			)) {
				if (isAdapterSurfaceId(tag.messageId)) continue;
				const placed = projection.byMessageId.get(tag.messageId);
				if (placed === undefined) continue;
				if (protectedSeqs.has(placed.seq) || !surfaceSeqs.has(placed.seq))
					continue;
				queueable.push(tag.tagNumber);
			}
		}
		const queued = getPendingOps(this.db, mcSession).map((op) => op.tagId);
		const candidates = new Set<number>([...queued, ...queueable]);
		if (candidates.size === 0) return null;

		const changeId = `mc-drop-${randomUUID()}`;
		const shadows: ShadowInfo[] = [];
		const appliedTagIds: number[] = [];
		const deferred: number[] = [];
		await this.managedEdits.runManagedChange("drop", changeId, mcSession, {
			decision: async () => {
				// Core queue: idempotent stamping (ctx_reduce path), then the
				// core apply mechanism persists the decision (status `dropped`,
				// frozen drop_mode, queue drain) — no targets map: the DSH
				// transcript lives in the session log, and the core persists
				// transcript-absent drops on its `target_absent` baseline.
				for (const tagNumber of queueable)
					queuePendingOp(this.db, mcSession, tagNumber, "drop");
				applyPendingOperations(mcSession, this.db, new Map(), new Set());
				const settled = getTagsByNumbers(this.db, mcSession, [
					...candidates,
				]).filter(
					(tag) => tag.status === "dropped" || tag.status === "compacted",
				);
				const targets: DropTarget[] = [];
				for (const tag of settled) {
					const placed = projection.byMessageId.get(tag.messageId);
					if (placed === undefined || !surfaceSeqs.has(placed.seq)) continue;
					const record = projection.records.find(
						(candidate) => candidate.messageId === tag.messageId,
					);
					if (record === undefined) continue;
					targets.push({ tagNumber: tag.tagNumber, record });
				}
				return { changeId, targets };
			},
			effect: async (decision) => {
				const ordered = [...decision.targets].sort(
					(left, right) => left.record.seq - right.record.seq,
				);
				for (const target of ordered) {
					if (target.record.role === "tool") {
						const { replacementSeq } = await session.rewriteToolResult(
							target.record.seq,
							dropNodeContent([target.tagNumber]),
						);
						shadows.push({ replacementSeq, shadowedSeqs: [target.record.seq] });
						appliedTagIds.push(target.tagNumber);
					} else if (target.record.role === "user") {
						const { replacementSeq } = await session.rewriteUserMessage(
							target.record.seq,
							dropNodeContent([target.tagNumber]),
						);
						shadows.push({ replacementSeq, shadowedSeqs: [target.record.seq] });
						appliedTagIds.push(target.tagNumber);
					} else if (target.record.role === "assistant") {
						// T004 verdict: the projection lane edits an assistant body
						// in place (identity preserved, node membership unchanged).
						const { eventSeq } = await session.rewriteAssistantBody(
							target.record.seq,
							dropNodeContent([target.tagNumber]),
						);
						shadows.push({
							replacementSeq: eventSeq,
							shadowedSeqs: [target.record.seq],
						});
						appliedTagIds.push(target.tagNumber);
					} else {
						// No sanctioned edit for this role; the fold owns it.
						deferred.push(target.tagNumber);
					}
				}
				const shadowedSeqs = shadows.flatMap(
					(shadow) => shadow.shadowedSeqs ?? [],
				);
				const replacementSeq =
					shadows.length === 1 ? shadows[0]!.replacementSeq : undefined;
				return {
					...(replacementSeq !== undefined ? { replacementSeq } : {}),
					...(shadowedSeqs.length > 0 ? { shadowedSeqs } : {}),
				};
			},
		});
		if (appliedTagIds.length === 0 && deferred.length === 0) return null;
		return { shadows, tagIds: appliedTagIds.sort((a, b) => a - b), deferred };
	}
}
