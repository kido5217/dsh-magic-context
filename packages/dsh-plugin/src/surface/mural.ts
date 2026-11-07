/**
 * Mural wiring (T047) — the memory-mural image for the baseline node.
 *
 * The mural itself is the core's: a deterministic PNG of the project memories
 * the budget left out of `<project-memory>`, rendered and cached by
 * `ensureMuralRendered` (coverage gate, cue pool, deterministic layout text —
 * all core logic, no host specifics). What the DSH adapter owns is the TWO
 * gates around it, mirroring FR-006:
 *
 *  1. the feature flag (`mural.enabled`, default false), and
 *  2. the ROUTE capability: the image only ships when the CURRENT routed
 *     model advertises `image` input. A route with unknown modalities gets
 *     text-only — never a guessed image, and never a downgrade of the rest
 *     of the head (the mural block simply does not enter the baseline text).
 *
 * The bytes are a data URL here; `HeadManager.applyPair` commits them through
 * the host attachment store so the baseline node carries a durable
 * `image` content block next to its text. Rendering happens only inside
 * baseline materialization — a natural fold moment — so the image swaps on
 * folds, never mid-session (the core's own invariant for the m[0] mural).
 */
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { ensureMuralRendered } from "@magic-context/core/features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "@magic-context/core/features/magic-context/mural/resolve-mural";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { DEFAULT_MEMORY_BUDGET_TOKENS } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { sessionLog } from "@magic-context/core/shared/logger";

/** Does this route accept image input? Unknown ⇒ false (text-only). */
export function acceptsImage(
	modalities: readonly string[] | undefined,
): boolean {
	return modalities?.includes("image") === true;
}

export interface BaselineMural {
	/** Wire options handed to `materializeM0` (its `mural` override). */
	readonly options: MuralWireOptions;
	/** Encoded PNG bytes when the core produced a mural image. */
	readonly bytes?: Uint8Array;
}

/** Decode a `data:image/png;base64,…` URL produced by the core renderer. */
export function decodeMuralDataUrl(dataUrl: string): Uint8Array | undefined {
	const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
	if (match === null) return undefined;
	return Buffer.from(match[1] as string, "base64");
}

/**
 * Resolve the mural for one baseline materialization: flag + identity + route
 * gate first (cheap), then the core's on-demand render (persist mode — the
 * baseline render is a fold moment and may write the cached PNG).
 * `undefined` means: no mural option at all (text-only baseline).
 */
export function resolveBaselineMural(
	db: ContextDatabase,
	config: MagicContextConfig,
	projectIdentity: string | undefined,
	imageInput: boolean,
	memoryBudgetTokens: number = DEFAULT_MEMORY_BUDGET_TOKENS,
	mcSession?: string,
): BaselineMural | undefined {
	if (config.mural?.enabled !== true || !projectIdentity) {
		return undefined;
	}
	if (!imageInput) {
		// A text-only route is a durable route fact, not a silent no-op
		// (quickstart V4): record it, and tell the core the mural is on but
		// this render carries no vision surface.
		if (mcSession !== undefined) {
			sessionLog(mcSession, "mural skipped: routed model lacks image input");
		}
		return { options: { enabled: true, supportsVision: false } };
	}
	const result = ensureMuralRendered(
		db,
		projectIdentity,
		memoryBudgetTokens,
		"persist",
	);
	if (!result.hasMural || result.dataUrl === undefined) {
		if (result.skipReason !== undefined && mcSession !== undefined) {
			sessionLog(mcSession, `mural skipped: ${result.skipReason}`);
		}
		return { options: { enabled: true, supportsVision: true } };
	}
	const bytes = decodeMuralDataUrl(result.dataUrl);
	if (bytes === undefined)
		return { options: { enabled: true, supportsVision: true } };
	return {
		options: {
			enabled: true,
			supportsVision: true,
			dataUrl: result.dataUrl,
			...(result.contentHash !== undefined
				? { contentHash: result.contentHash }
				: {}),
		},
		bytes,
	};
}
