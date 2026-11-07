/**
 * Compaction coexistence claim (T011).
 *
 * While Magic Context manages a session, exactly one provider may fold its
 * surface — two providers on one session is a bug (contracts/
 * dsh-plugin-surface.md). This module supplies the MC-side `ctx.compaction`
 * backend: a `CompactionEngine` subclass (the sanctioned way to own
 * `ctx.compaction`; the default backend is disabled by the bundle patch).
 *
 * Policy:
 * - Managed session, automatic trigger (`compactIfNeeded`): return `null` —
 *   MC owns folding; the fold runs through the MC pass, not the host's
 *   pressure hook. The decision is logged so the deferral is diagnosable.
 * - Managed session, explicit `compactNow` / `compactRegion`: delegate to the
 *   MC fold callback the adapter injects (the same MC fold the pass would do,
 *   so `/compact` and region compaction produce one MC-bracketed fold).
 * - Non-managed session: no-op (`null`) — the claim engine never compacts
 *   unmanaged sessions; `compactRegion` rejects with a `changed`
 *   ManualCompactionError (no shadowable MC decision for that session).
 */
import type { Context } from "@deepseek-ai/cordis";
import {
	type CompactionAgentContext,
	CompactionEngine,
	type CompactionResult,
	type CompactionTrigger,
	type ManualCompactAgentContext,
	ManualCompactionError,
} from "@deepseek-ai/dsh-compaction";
import { log } from "@magic-context/core/shared/logger";

/** One MC fold over a managed session; `region` absent ⇒ fold the default head range. */
export type McFoldCallback = (
	agent: CompactionAgentContext,
	region: { start: number; end: number } | undefined,
	signal: AbortSignal | undefined,
) => Promise<CompactionResult | null>;

/** Set of sessions whose compaction is claimed while attached/detached. */
export class CompactionClaimRegistry {
	private readonly managed = new Set<string>();

	attach(sessionId: string): void {
		this.managed.add(sessionId);
	}

	detach(sessionId: string): void {
		this.managed.delete(sessionId);
	}

	isManaged(sessionId: string): boolean {
		return this.managed.has(sessionId);
	}

	clear(): void {
		this.managed.clear();
	}
}

/** The MC `ctx.compaction` backend (claim + delegated folds). */
export class McCompactionClaim extends CompactionEngine {
	constructor(
		ctx: Context,
		private readonly registry: CompactionClaimRegistry,
		private readonly fold: McFoldCallback,
	) {
		super(ctx);
	}

	override compactIfNeeded(
		agent: CompactionAgentContext,
		trigger: CompactionTrigger,
		_signal: AbortSignal,
	): Promise<CompactionResult | null> {
		if (this.registry.isManaged(agent.session.id)) {
			log(
				`[dsh-magic-context] compaction trigger "${trigger}" deferred for session ${agent.session.id}: Magic Context owns folding on managed sessions (T011)`,
			);
		}
		return Promise.resolve(null);
	}

	override compactNow(
		agent: ManualCompactAgentContext,
		signal: AbortSignal,
		_sourceCommandId?: unknown,
	): Promise<CompactionResult | null> {
		if (!this.registry.isManaged(agent.session.id))
			return Promise.resolve(null);
		return this.fold(agent, undefined, signal);
	}

	override async compactRegion(
		start: number,
		end: number,
		agent: CompactionAgentContext,
		signal?: AbortSignal,
	): Promise<CompactionResult> {
		if (this.registry.isManaged(agent.session.id)) {
			const result = await this.fold(agent, { start, end }, signal);
			if (result) return result;
			throw new ManualCompactionError(
				"changed",
				`Magic Context fold produced no result for region ${start}..${end} of session ${agent.session.id}`,
			);
		}
		throw new ManualCompactionError(
			"changed",
			`session ${agent.session.id} is not Magic-Context-managed; no MC decision backs this region fold`,
		);
	}
}
