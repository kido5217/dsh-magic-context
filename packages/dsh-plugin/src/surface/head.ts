/**
 * Session-head management (T017).
 *
 * The session head is one plugin-appended surface node carrying Magic
 * Context's own content: the reduction/marker guidance plus the summarized
 * history (`<session-history>` compartments + session facts). On OpenCode/Pi
 * the head is rewritten in the outbound request every pass; on DSH the head
 * is part of the durable surface, so it changes only through managed edits:
 *
 * - `head-refresh`: replaces the previous head node with a single new node
 *   (old head seq set → one replacement). The rendered text is diffed against
 *   the cached render first: identical bytes ⇒ no managed change at all
 *   (append-cache invariant — a re-render must never re-shadow and bust the
 *   provider prefix).
 * - `head-rebaseline`: whole-surface fold — the covered seq range (folded
 *   history + the old head) collapses into one fresh head node. The historian
 *   fold embeds this as its effect; a standalone re-baseline (e.g. after a
 *   host compaction absorbed the head) runs it in its own bracket.
 *
 * v1 scope: the head renders guidance + compartments + session facts through
 * the core renderers (`buildMagicContextSection`, `buildCompartmentBlock`);
 * project-memory blocks, aging (P1–P4 tiers) and the mural ride the full
 * `renderCompartmentInjection` pipeline and are deferred (scope ledger).
 */
import { createHash, randomUUID } from "node:crypto";
import { buildCompartmentBlock, getCompartments, getSessionFacts } from "@magic-context/core/features/magic-context/compartment-storage";
import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { ManagedEdits, ShadowInfo } from "./managed-edits.js";
import type { DshSession } from "../host.js";
import type { McReplacementContent } from "./events.js";

export interface HeadRenderContext {
	readonly mcSession: string;
	/** Subagent rule set narrows the guidance (no long-term-partner frame). */
	readonly subagent: boolean;
	/** A managed change already landed this pass ⇒ the head must exist to carry guidance. */
	readonly managedChangeLanded?: boolean;
}

interface HeadState {
	readonly seq: number;
	readonly text: string;
}

export class HeadManager {
	private readonly heads = new Map<string, HeadState>();

	constructor(
		private readonly db: ContextDatabase,
		private readonly managedEdits: ManagedEdits,
		private readonly config: MagicContextConfig,
	) {}

	/** The cached head node for a session (durable seq + rendered bytes). */
	peek(mcSession: string): HeadState | undefined {
		return this.heads.get(mcSession);
	}

	forget(mcSession: string): void {
		this.heads.delete(mcSession);
	}

	/** Deterministic head bytes for the current store state (guidance + history). */
	renderText(context: HeadRenderContext): string {
		const guidance = buildMagicContextSection(
			null,
			0,
			true,
			false,
			false,
			false,
			context.subagent,
			undefined,
			this.config.memory?.enabled ?? true,
			"full",
			undefined,
			this.config.smart_notes?.enabled ?? false,
		);
		const block = buildCompartmentBlock(getCompartments(this.db, context.mcSession), getSessionFacts(this.db, context.mcSession));
		return block.length > 0 ? `${guidance}\n\n<session-history>\n${block}\n</session-history>` : guidance;
	}

	/**
	 * Refresh the head node if (and only if) the rendered bytes changed.
	 * Returns null for a no-op (cache-consistent head), the ShadowInfo of the
	 * `head-refresh` managed change otherwise.
	 */
	async refresh(session: DshSession, context: HeadRenderContext): Promise<ShadowInfo | null> {
		const text = this.renderText(context);
		const cached = this.heads.get(context.mcSession);
		if (cached !== undefined && cached.text === text) return null;
		if (cached === undefined && !this.hasAnythingToSay(context)) return null;
		return this.publish(session, context, text, cached);
	}

	/**
	 * Standalone whole-surface re-baseline: fold `coveredSeqs` (which must
	 * include the current head node) into one fresh head node, in its own
	 * managed bracket.
	 */
	async rebaseline(session: DshSession, context: HeadRenderContext, coveredSeqs: readonly number[]): Promise<ShadowInfo | null> {
		const text = this.renderText(context);
		return this.publish(session, context, text, this.heads.get(context.mcSession), coveredSeqs);
	}

	private hasAnythingToSay(context: HeadRenderContext): boolean {
		return context.managedChangeLanded === true || getCompartments(this.db, context.mcSession).length > 0;
	}

	private async publish(session: DshSession, context: HeadRenderContext, text: string, cached: HeadState | undefined, coveredSeqs?: readonly number[]): Promise<ShadowInfo> {
		const changeId = `mc-head-${randomUUID()}`;
		const kind = coveredSeqs !== undefined ? "head-rebaseline" : "head-refresh";
		const content: McReplacementContent = [{ type: "text", text }];
		const shadow = await this.managedEdits.runManagedChange(kind, changeId, context.mcSession, {
			decision: async () => {
				// Durable decision: the head render's identity is recorded on
				// the core session-meta row (content-addressed fingerprint).
				updateSessionMeta(this.db, context.mcSession, { systemPromptHash: createHash("md5").update(text).digest("hex") });
				return { changeId };
			},
			effect: () => {
				const surface = session.surfaceNodes();
				if (coveredSeqs !== undefined) {
					const ordered = surface.filter((seq) => coveredSeqs.includes(seq));
					if (ordered.length === 0) return Promise.resolve({});
					return session
						.replaceSurface(content, ordered[0]!, ordered[ordered.length - 1]!, ordered)
						.then(({ replacementSeq }) => ({ replacementSeq, shadowedSeqs: ordered }));
				}
				if (cached !== undefined && surface.includes(cached.seq)) {
					return session
						.replaceSurface(content, cached.seq, cached.seq, [cached.seq])
						.then(({ replacementSeq }) => ({ replacementSeq, shadowedSeqs: [cached.seq] }));
				}
				return session.appendNotice(content).then(({ seq }) => ({ replacementSeq: seq }));
			},
		});
		if (shadow.replacementSeq !== undefined) {
			this.heads.set(context.mcSession, { seq: shadow.replacementSeq, text });
		} else {
			this.heads.delete(context.mcSession);
		}
		return shadow;
	}

	/**
	 * Re-baseline effect for the historian fold: runs inside the fold's
	 * managed bracket (no second bracket), collapsing `coveredSeqs` into the
	 * freshly rendered head node.
	 */
	async foldRebaselineEffect(session: DshSession, context: HeadRenderContext, coveredSeqs: readonly number[]): Promise<ShadowInfo> {
		const text = this.renderText(context);
		const surface = session.surfaceNodes();
		const ordered = surface.filter((seq) => coveredSeqs.includes(seq));
		if (ordered.length === 0) return {};
		const content: McReplacementContent = [{ type: "text", text }];
		const { replacementSeq } = await session.replaceSurface(content, ordered[0]!, ordered[ordered.length - 1]!, ordered);
		this.heads.set(context.mcSession, { seq: replacementSeq, text });
		return { replacementSeq, shadowedSeqs: ordered };
	}
}
