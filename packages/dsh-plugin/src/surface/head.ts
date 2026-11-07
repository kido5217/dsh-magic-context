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
 * the core renderers (`buildMagicContextSection`, `buildCompartmentBlock`),
 * plus the project-memory block (rendered and cached exactly like the core
 * injection pipeline, so `ctx_search` hard-filtering sees the same ids) and
 * temporal date ranges resolved from the durable log (T042). v2 tier aging
 * (P1–P4) and the mural ride the dreamer-maintained pipeline and remain a
 * declared deferral (PARITY).
 */
import { createHash, randomUUID } from "node:crypto";
import { buildCompartmentBlock, getCompartments, getSessionFacts, type Compartment, type CompartmentDateRanges } from "@magic-context/core/features/magic-context/compartment-storage";
import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { renderMemoryBlock, trimMemoriesToBudget } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { formatDate } from "@magic-context/core/hooks/magic-context/temporal-awareness";
import { getMemoriesByProject } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { ManagedEdits, ShadowInfo } from "./managed-edits.js";
import type { DshSession } from "../host.js";
import type { DshLogProjection } from "./dsh-session-log.js";
import type { McReplacementContent } from "./events.js";

export interface HeadRenderContext {
	readonly mcSession: string;
	/** Subagent rule set narrows the guidance (no long-term-partner frame). */
	readonly subagent: boolean;
	/** A managed change already landed this pass ⇒ the head must exist to carry guidance. */
	readonly managedChangeLanded?: boolean;
	/** Current durable-log projection; temporal ranges resolve their dates from it. */
	readonly projection: DshLogProjection;
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
		private readonly projectDir: string,
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
		const compartments = getCompartments(this.db, context.mcSession);
		const memoryBlock = this.renderMemorySection(context);
		const dateRanges = this.temporalRanges(context, compartments);
		const block = buildCompartmentBlock(compartments, getSessionFacts(this.db, context.mcSession), memoryBlock, dateRanges);
		return block.length > 0 ? `${guidance}\n\n<session-history>\n${block}\n</session-history>` : guidance;
	}

	/**
	 * The `<project-memory>` block, rendered and cached exactly like the core
	 * injection pipeline: the session_meta cache row keeps the bytes stable
	 * across background memory changes (no provider-prefix bust), and the
	 * rendered-id capture is what `ctx_search` uses to hard-filter memories
	 * the agent already sees.
	 */
	private renderMemorySection(context: HeadRenderContext): string | undefined {
		if (!(this.config.memory?.enabled ?? true)) return undefined;
		const projectPath = resolveProjectIdentityForSession(this.projectDir);
		if (!projectPath) return undefined;
		const cached = this.db
			.prepare("SELECT memory_block_cache, memory_block_count FROM session_meta WHERE session_id = ?")
			.get(context.mcSession) as { memory_block_cache: string; memory_block_count: number } | null;
		if (cached?.memory_block_cache) return cached.memory_block_cache;
		let memories = getMemoriesByProject(this.db, projectPath, ["active", "permanent"]);
		const budget = this.config.memory?.injection_budget_tokens;
		if (budget && memories.length > 0) memories = trimMemoriesToBudget(context.mcSession, memories, budget);
		const memoryBlock = renderMemoryBlock(memories) ?? undefined;
		// Snapshot the render (SQLITE_BUSY swallow mirrors the core pipeline:
		// a one-pass cache miss beats failing the pass over a pure optimization).
		try {
			this.db
				.prepare("UPDATE session_meta SET memory_block_cache = ?, memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?")
				.run(memoryBlock ?? "", memories.length, JSON.stringify(memories.map((memory) => memory.id)), context.mcSession);
		} catch {
			// Cache write is best effort; the block itself is returned regardless.
		}
		return memoryBlock;
	}

	/** Compartment date ranges from the durable log's own message timestamps. */
	private temporalRanges(context: HeadRenderContext, compartments: readonly Compartment[]): CompartmentDateRanges | undefined {
		if (!this.config.temporal_awareness || compartments.length === 0) return undefined;
		const times = new Map<string, number>();
		for (const record of context.projection.records) {
			if (record.createdAt !== undefined) times.set(record.messageId, record.createdAt);
		}
		const byId = new Map<number, { start: string; end: string }>();
		for (const compartment of compartments) {
			const startMs = compartment.startMessageId !== undefined ? times.get(compartment.startMessageId) : undefined;
			const endMs = compartment.endMessageId !== undefined ? times.get(compartment.endMessageId) : undefined;
			if (startMs !== undefined && endMs !== undefined) byId.set(compartment.id, { start: formatDate(startMs), end: formatDate(endMs) });
		}
		return byId.size > 0 ? { byId } : undefined;
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
		return context.managedChangeLanded === true || getCompartments(this.db, context.mcSession).length > 0 || this.renderMemorySection(context) !== undefined;
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
				return session.appendTail(content).then(({ seq }) => ({ replacementSeq: seq }));
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
