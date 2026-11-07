/**
 * Baseline node renderer (T041) — the frozen half of the DSH head.
 *
 * The baseline reproduces the core m[0] contract verbatim: guidance,
 * `<project-docs>`, `<user-profile>`, decay-rendered `<session-history>`
 * (with DSH projection dates), the shared V2 `<project-memory>` block, and
 * the optional mural. Every block comes from the shared renderers — the
 * adapter contributes only data enrichment (durable-projection message
 * times into the core time index, workspace identity) and the guidance
 * frame, so a DSH baseline's blocks are the bytes every other harness
 * renders.
 *
 * Cursors are the core's: `materializeM0` persists the m[0] snapshot
 * markers (the `cached_m0_*` columns) in the same write that renders the
 * baseline, which is what the freeze rules in `contracts/head.md` require —
 * the baseline write and its cursors share one decision, so a crash between
 * the managed-change decision and its effect replays the same render.
 */
import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	DEFAULT_MEMORY_BUDGET_TOKENS,
	type M0M1RenderOptions,
	type M0SnapshotMarkers,
	materializeM0,
} from "@magic-context/core/hooks/magic-context/inject-compartments";
import type { DshLogProjection } from "./dsh-session-log.js";
import { type BaselineMural, resolveBaselineMural } from "./mural.js";
import { syncProjectionTimes } from "./projection-times.js";

export interface BaselineContext {
	readonly mcSession: string;
	/** Subagent rule set narrows the guidance (no long-term-partner frame). */
	readonly subagent: boolean;
	/** Durable-log projection; supplies the message times behind compartment dates. */
	readonly projection?: DshLogProjection;
	/** Routed model advertises image input (FR-006); unknown ⇒ false ⇒ no mural. */
	readonly imageInput?: boolean;
}

export interface BaselineResult {
	/** Guidance + m[0]: the exact bytes of the baseline surface node. */
	readonly text: string;
	/** The delta the baseline shipped with (the core empty-delta placeholder). */
	readonly m1Text: string;
	/** The cursors frozen with this render (the delta renders against these). */
	readonly markers: M0SnapshotMarkers;
	readonly renderedMemoryIds: readonly number[];
	/** Encoded mural PNG when this baseline carries a mural image (T047). */
	readonly muralBytes?: Uint8Array;
}

export class BaselineRenderer {
	constructor(
		/** Shared store handle (the delta renderer renders through it). */
		readonly db: ContextDatabase,
		private readonly config: MagicContextConfig,
		private readonly projectDir: string,
	) {}

	/** The Magic Context guidance block; the only adapter-authored bytes in the head. */
	guidance(subagent: boolean): string {
		return buildMagicContextSection(
			null,
			0,
			true,
			false,
			false,
			false,
			subagent,
			undefined,
			this.config.memory?.enabled ?? true,
			"full",
			undefined,
			this.config.smart_notes?.enabled ?? false,
		);
	}

	/**
	 * The shared m[0]/m[1] render options for this session: identical option
	 * construction for the baseline and every later delta, so a delta never
	 * re-derives a policy the baseline froze.
	 */
	coreOptions(mcSession: string): M0M1RenderOptions {
		const memoryEnabled = this.config.memory?.enabled ?? true;
		return {
			db: this.db,
			sessionId: mcSession,
			state: getOrCreateSessionMeta(this.db, mcSession),
			projectPath: resolveProjectIdentityForSession(this.projectDir),
			injectDocs: this.config.dreamer?.inject_docs !== false,
			memoryEnabled,
			...(this.config.memory?.injection_budget_tokens !== undefined
				? {
						memoryInjectionBudgetTokens:
							this.config.memory.injection_budget_tokens,
					}
				: {}),
			temporalAwareness: this.config.temporal_awareness,
		};
	}

	/**
	 * Re-render the baseline from the CURRENT store state and persist the new
	 * cursors. Only called on a contract-eligible moment: first render, an
	 * explicit re-baseline, a fold, or a render-identity (epoch) change —
	 * never on a routine pass.
	 */
	materialize(context: BaselineContext): BaselineResult {
		if (context.projection !== undefined)
			syncProjectionTimes(this.db, context.mcSession, context.projection);
		// Mural (T047): flag + identity + ROUTE capability gate the core's
		// on-demand render. Explicit wire options override the core's internal
		// (registry-based) model-key gate — the DSH route's advertised
		// modalities are the capability truth here.
		const mural: BaselineMural | undefined = resolveBaselineMural(
			this.db,
			this.config,
			resolveProjectIdentityForSession(this.projectDir),
			context.imageInput === true,
			this.config.memory?.injection_budget_tokens ??
				DEFAULT_MEMORY_BUDGET_TOKENS,
			context.mcSession,
		);
		const result = materializeM0({
			...this.coreOptions(context.mcSession),
			...(mural !== undefined ? { mural: mural.options } : {}),
		});
		// Retired sources (T046): the v1 adapter cached its memory block in
		// `session_meta.memory_block_cache`; the baseline now renders through the
		// core materializer, so any stale cache is cleared once (idempotent).
		try {
			this.db
				.prepare(
					"UPDATE session_meta SET memory_block_cache = NULL, memory_block_count = 0 WHERE session_id = ? AND memory_block_cache IS NOT NULL",
				)
				.run(context.mcSession);
		} catch {
			// Clearing a retired cache is best effort.
		}
		const guidance = this.guidance(context.subagent);
		return {
			text: `${guidance}\n\n${result.m0Text}`,
			m1Text: result.m1Text,
			markers: result.snapshotMarkers,
			renderedMemoryIds: result.renderedMemoryIds,
			...(mural?.bytes !== undefined ? { muralBytes: mural.bytes } : {}),
		};
	}
}
