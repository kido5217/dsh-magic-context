/**
 * Session-head management (T017; baseline+delta refactor: T043).
 *
 * The head is the DSH reproduction of the core m[0]/m[1] contract with TWO
 * durable nodes (contracts/head.md): a frozen BASELINE — guidance + the core
 * m[0] render (project docs, user profile, decay-rendered compartments with
 * projection dates, the shared V2 memory block, optional mural) at the head
 * position — and a volatile DELTA — the core m[1] (`renderSessionDelta`)
 * against the baseline's frozen cursors, appended after the tail. The
 * positional difference from OpenCode/Pi is recorded; the byte-stability
 * contract is not: the baseline re-renders only at a contract-eligible
 * moment (first render, a fold, an explicit re-baseline, a render-identity
 * change), and the delta is diff-guarded, so an unchanged pass performs no
 * durable write at all.
 *
 * Durable bookkeeping:
 * - `session_meta.systemPromptHash` carries the pair fingerprint,
 *   `md5(baseline)|md5(delta)`; a restart rediscovers both nodes by matching
 *   that fingerprint against the adapter's own surface records, so a resumed
 *   session never re-emits folded content or stacks duplicate heads.
 * - the baseline cursors are persisted by the core materializer itself
 *   (`session_meta.cached_m0_*`), which is what lets the delta (and the
 *   visible-memory filter) render against frozen state.
 * - Managed-change brackets (`mc/manage-start…end`) wrap every node write,
 *   with `head-rebaseline` for baseline renders and `head-refresh` for
 *   delta replacements.
 *
 * Positioning note (recorded divergence): between folds the delta is
 * replaced IN PLACE — new conversation nodes may sit after it. In-place
 * replacement is what guarantees the delta write invalidates no cached bytes
 * ahead of it; the fold (and a re-baseline) re-emits it after the tail.
 */
import { createHash, randomUUID } from "node:crypto";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import type { M0SnapshotMarkers } from "@magic-context/core/hooks/magic-context/inject-compartments";
import type { DshSession } from "../host.js";
import type { DshLogProjection } from "./dsh-session-log.js";
import { isAdapterSurfaceId } from "./dsh-session-log.js";
import type { McReplacementContent } from "./events.js";
import { BaselineRenderer } from "./head-baseline.js";
import { readHeadCursors } from "./head-cursors.js";
import { DeltaRenderer } from "./head-delta.js";
import type { ManagedEdits, ShadowInfo } from "./managed-edits.js";

export interface HeadRenderContext {
	readonly mcSession: string;
	/** Subagent rule set narrows the guidance (no long-term-partner frame). */
	readonly subagent: boolean;
	/** A managed change already landed this pass ⇒ the head must exist to carry guidance. */
	readonly managedChangeLanded?: boolean;
	/** Current durable-log projection; identifies the head nodes on rediscovery. */
	readonly projection: DshLogProjection;
}

export interface HeadState {
	/** Baseline node seq (the head node; `peek().seq` keeps its v1 meaning). */
	readonly seq: number;
	/** The baseline's rendered bytes (guidance + m[0]). */
	readonly text: string;
	/** Delta node seq; undefined only in the window before the first delta emit. */
	readonly deltaSeq?: number;
	/** The delta's rendered bytes (m[1], possibly the core placeholder). */
	readonly deltaText: string;
	/** Cursors frozen with this baseline (persisted twin: `head-cursors.ts`). */
	readonly markers?: M0SnapshotMarkers;
	/** Memory ids the baseline shows (the visible-memory filter input). */
	readonly renderedMemoryIds?: readonly number[];
}

function md5(text: string): string {
	return createHash("md5").update(text).digest("hex");
}

function pairFingerprint(baselineText: string, deltaText: string): string {
	return `${md5(baselineText)}|${md5(deltaText)}`;
}

function textContent(text: string): McReplacementContent {
	return [{ type: "text", text }];
}

export class HeadManager {
	private readonly pairs = new Map<string, HeadState>();
	readonly baseline: BaselineRenderer;
	private readonly deltas: DeltaRenderer;

	constructor(
		private readonly db: ContextDatabase,
		private readonly managedEdits: ManagedEdits,
		private readonly config: MagicContextConfig,
		private readonly projectDir: string,
	) {
		this.baseline = new BaselineRenderer(db, config, projectDir);
		this.deltas = new DeltaRenderer(this.baseline);
	}

	/** The cached head pair for a session (durable seqs + rendered bytes). */
	peek(mcSession: string): HeadState | undefined {
		return this.pairs.get(mcSession);
	}

	forget(mcSession: string): void {
		this.pairs.delete(mcSession);
	}

	/**
	 * One head pass. Baselines are never re-rendered here; the delta is
	 * re-rendered against the frozen cursors and written only when its bytes
	 * changed. A session with no in-memory pair first tries durable
	 * rediscovery, then (if there is something to say) emits a fresh pair.
	 */
	async refresh(
		session: DshSession,
		context: HeadRenderContext,
	): Promise<ShadowInfo | null> {
		const pair = this.pairs.get(context.mcSession) ?? this.rediscover(context);
		if (pair !== undefined && !this.pairs.has(context.mcSession))
			this.pairs.set(context.mcSession, pair);
		if (pair === undefined) {
			if (!(await this.hasAnythingToSay(context))) return null;
			return this.materializePair(session, context);
		}
		const frozen =
			pair.markers !== undefined
				? {
						markers: pair.markers,
						renderedMemoryIds: pair.renderedMemoryIds ?? [],
					}
				: this.cursors(context);
		if (frozen === undefined) return null;
		const next = this.deltas.render(
			{ mcSession: context.mcSession, projection: context.projection },
			// Frozen cursors: the pair's (baseline-time) markers, refilled from
			// the persisted copy after a restart or a lost pair entry.
			frozen.markers,
			frozen.renderedMemoryIds,
		);
		if (pair.deltaSeq === undefined) {
			const shadow = await this.appendDelta(session, context, pair, next.text);
			return shadow;
		}
		if (next.text === pair.deltaText) return null;
		return this.replaceDelta(session, context, pair, next.text);
	}

	/**
	 * Standalone whole-surface re-baseline: fold `coveredSeqs` (which must
	 * include the old pair) into a freshly rendered baseline, with a new
	 * placeholder delta after the tail. Runs in its own managed bracket.
	 */
	async rebaseline(
		session: DshSession,
		context: HeadRenderContext,
		coveredSeqs: readonly number[],
	): Promise<ShadowInfo | null> {
		const surface = session.surfaceNodes();
		const ordered = surface.filter((seq) => coveredSeqs.includes(seq));
		if (ordered.length === 0) return null;
		const changeId = `mc-head-${randomUUID()}`;
		const shadow = await this.managedEdits.runManagedChange(
			"head-rebaseline",
			changeId,
			context.mcSession,
			{
				decision: () => this.renderBaseline(context),
				effect: (rendered) =>
					this.applyPair(session, context, rendered, ordered),
			},
		);
		return shadow;
	}

	/**
	 * Re-baseline effect for the historian fold: runs inside the fold's
	 * managed bracket (no second bracket), collapsing `coveredSeqs` into the
	 * freshly rendered baseline plus a new placeholder delta.
	 */
	async foldRebaselineEffect(
		session: DshSession,
		context: HeadRenderContext,
		coveredSeqs: readonly number[],
	): Promise<ShadowInfo> {
		const surface = session.surfaceNodes();
		const ordered = surface.filter((seq) => coveredSeqs.includes(seq));
		if (ordered.length === 0) return {};
		const rendered = await this.renderBaseline(context);
		return this.applyPair(session, context, rendered, ordered);
	}

	// ── internals ────────────────────────────────────────────────────────────

	private cursors(context: HeadRenderContext) {
		return readHeadCursors(this.db, context.mcSession, {
			projectPath: resolveProjectIdentityForSession(this.projectDir),
			injectDocs: this.config.dreamer?.inject_docs !== false,
			memoryEnabled: this.config.memory?.enabled ?? true,
		});
	}

	/** The first pass for a session: baseline + placeholder delta, both appended. */
	private async materializePair(
		session: DshSession,
		context: HeadRenderContext,
	): Promise<ShadowInfo> {
		const changeId = `mc-head-${randomUUID()}`;
		return this.managedEdits.runManagedChange(
			"head-rebaseline",
			changeId,
			context.mcSession,
			{
				decision: () => this.renderBaseline(context),
				effect: (rendered) => this.applyPair(session, context, rendered, []),
			},
		);
	}

	/**
	 * Baseline decision: render m[0] through the core materializer (which
	 * persists the new cursors) and record the pair fingerprint — baseline
	 * bytes + the delta placeholder it shipped with.
	 */
	private async renderBaseline(context: HeadRenderContext): Promise<{
		baselineText: string;
		deltaText: string;
	}> {
		const base = this.baseline.materialize(context);
		updateSessionMeta(this.db, context.mcSession, {
			systemPromptHash: pairFingerprint(base.text, base.m1Text),
		});
		return { baselineText: base.text, deltaText: base.m1Text };
	}

	/**
	 * Baseline effect: when a covered range exists (fold/re-baseline) the
	 * pair collapses into it at the head position; otherwise the baseline is
	 * appended. The delta placeholder always lands after the tail.
	 */
	private async applyPair(
		session: DshSession,
		context: HeadRenderContext,
		rendered: { baselineText: string; deltaText: string },
		ordered: readonly number[],
	): Promise<ShadowInfo> {
		let baselineSeq: number;
		let shadowedSeqs: readonly number[] = [];
		if (ordered.length > 0) {
			const result = await session.replaceSurface(
				textContent(rendered.baselineText),
				ordered[0]!,
				ordered[ordered.length - 1]!,
				ordered,
			);
			baselineSeq = result.replacementSeq;
			shadowedSeqs = ordered;
		} else {
			baselineSeq = (
				await session.appendTail(textContent(rendered.baselineText))
			).seq;
		}
		const deltaSeq = (await session.appendTail(textContent(rendered.deltaText)))
			.seq;
		updateSessionMeta(this.db, context.mcSession, {
			systemPromptHash: pairFingerprint(
				rendered.baselineText,
				rendered.deltaText,
			),
		});
		const cursors = this.cursors(context);
		this.pairs.set(context.mcSession, {
			seq: baselineSeq,
			text: rendered.baselineText,
			deltaSeq,
			deltaText: rendered.deltaText,
			...(cursors !== undefined
				? {
						markers: cursors.markers,
						renderedMemoryIds: cursors.renderedMemoryIds,
					}
				: {}),
		});
		return { replacementSeq: baselineSeq, shadowedSeqs };
	}

	private async replaceDelta(
		session: DshSession,
		context: HeadRenderContext,
		pair: HeadState,
		text: string,
	): Promise<ShadowInfo | null> {
		const changeId = `mc-head-${randomUUID()}`;
		const shadow = await this.managedEdits.runManagedChange(
			"head-refresh",
			changeId,
			context.mcSession,
			{
				decision: async () => {
					updateSessionMeta(this.db, context.mcSession, {
						systemPromptHash: pairFingerprint(pair.text, text),
					});
					return { text };
				},
				effect: async () => {
					const result = await session.replaceSurface(
						textContent(text),
						pair.deltaSeq!,
						pair.deltaSeq!,
						[pair.deltaSeq!],
					);
					this.pairs.set(context.mcSession, {
						...pair,
						deltaSeq: result.replacementSeq,
						deltaText: text,
					});
					return {
						replacementSeq: result.replacementSeq,
						shadowedSeqs: [pair.deltaSeq!],
					};
				},
			},
		);
		return shadow;
	}

	private async appendDelta(
		session: DshSession,
		context: HeadRenderContext,
		pair: HeadState,
		text: string,
	): Promise<ShadowInfo> {
		const changeId = `mc-head-${randomUUID()}`;
		return this.managedEdits.runManagedChange(
			"head-refresh",
			changeId,
			context.mcSession,
			{
				decision: async () => {
					updateSessionMeta(this.db, context.mcSession, {
						systemPromptHash: pairFingerprint(pair.text, text),
					});
					return { text };
				},
				effect: async () => {
					const { seq } = await session.appendTail(textContent(text));
					this.pairs.set(context.mcSession, {
						...pair,
						deltaSeq: seq,
						deltaText: text,
					});
					return { replacementSeq: seq };
				},
			},
		);
	}

	/**
	 * Restart rediscovery: the persisted cursors plus the pair fingerprint
	 * identify both nodes among the adapter's own surface records. A missing
	 * baseline node (a host compaction absorbed it) yields no pair: the next
	 * pass re-materializes, which is fold-equivalent by definition.
	 */
	private rediscover(context: HeadRenderContext): HeadState | undefined {
		const cursors = this.cursors(context);
		if (cursors === undefined) return undefined;
		const state = getOrCreateSessionMeta(this.db, context.mcSession);
		const hash = state.systemPromptHash ?? "";
		const [baselineHash, deltaHash] = hash.split("|");
		if (baselineHash === undefined || baselineHash === "") return undefined;
		let baselineSeq: number | undefined;
		let baselineText: string | undefined;
		let deltaSeq: number | undefined;
		let deltaText: string | undefined;
		for (const record of context.projection.records) {
			if (!isAdapterSurfaceId(record.messageId)) continue;
			const digest = md5(record.text);
			if (digest === baselineHash) {
				baselineSeq = record.seq;
				baselineText = record.text;
			} else if (deltaHash !== undefined && digest === deltaHash) {
				deltaSeq = record.seq;
				deltaText = record.text;
			}
		}
		if (baselineSeq === undefined || baselineText === undefined)
			return undefined;
		return {
			seq: baselineSeq,
			text: baselineText,
			...(deltaSeq !== undefined ? { deltaSeq } : {}),
			deltaText: deltaText ?? "",
			markers: cursors.markers,
			renderedMemoryIds: cursors.renderedMemoryIds,
		};
	}

	private async hasAnythingToSay(context: HeadRenderContext): Promise<boolean> {
		if (context.managedChangeLanded === true) return true;
		if (getCompartments(this.db, context.mcSession).length > 0) return true;
		const projectPath = resolveProjectIdentityForSession(this.projectDir);
		if (projectPath === undefined) return false;
		return (
			this.config.memory?.enabled !== false &&
			getMemoriesByProject(this.db, projectPath, ["active", "permanent"])
				.length > 0
		);
	}
}
