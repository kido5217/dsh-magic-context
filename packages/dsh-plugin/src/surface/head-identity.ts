/**
 * Render identity (T048) — when a baseline MAY change, and where that fact
 * lives across restarts.
 *
 * The baseline is frozen between folds; the shared cache policy (FR-017)
 * forbids re-emitting it on routine passes. But it must change when the
 * RENDER CONTRACT changes: a new renderer epoch (adapter upgrade), a
 * different routed model (per-model prompt-surface blocks), a memory budget /
 * docs-injection / memory-enable / temporal-awareness / mural change (config
 * edited mid-session), or a vision-capability switch while the mural is on.
 * The identity is the digest of exactly that input set, stored in the
 * persisted head pair — `session_meta.systemPromptHash` carries
 * `md5(baseline)|md5(delta)|md5(identity)`, written in the same decision as
 * the pair itself, so a restart compares the SAME contract the baseline was
 * rendered under, not the config of the moment.
 *
 * Policy: identity mismatch ⇒ ONE re-baseline (the pair collapses into the
 * new baseline; history is untouched), never per-pass churn — after the fold
 * the stored identity matches again. A pair persisted before this field
 * existed carries no identity segment and folds once on the next pass.
 */
import { createHash } from "node:crypto";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";

/**
 * Adapter head renderer generation. Bump on ANY change to the baseline's
 * composition (guidance frame, block order, framing) — every live session
 * then re-baselines once, the same way a core prompt epoch works.
 */
export const HEAD_RENDERER_EPOCH = "dsh-head-2";

export interface RenderIdentityInputs {
	readonly config: MagicContextConfig;
	/**
	 * Canonical routed model (`provider/model`), the key the core renders
	 * per-model prompt-surface blocks under. Empty ⇒ no route observed yet.
	 */
	readonly modelKey: string;
	/** Routed model advertises image input; only relevant while the mural is on. */
	readonly imageInput: boolean;
}

/** The baseline-affecting configuration, serialized deterministically. */
export function renderIdentity(inputs: RenderIdentityInputs): string {
	const config = inputs.config;
	return JSON.stringify([
		HEAD_RENDERER_EPOCH,
		inputs.modelKey,
		config.dreamer?.inject_docs !== false,
		config.memory?.enabled ?? true,
		config.memory?.injection_budget_tokens ?? null,
		config.temporal_awareness ?? true,
		// Vision only matters while the mural can produce bytes; with the
		// feature off, a modality switch changes no baseline bytes.
		config.mural?.enabled === true ? inputs.imageInput : false,
	]);
}

export function md5(text: string): string {
	return createHash("md5").update(text).digest("hex");
}

export function identityDigest(inputs: RenderIdentityInputs): string {
	return md5(renderIdentity(inputs));
}

/**
 * The persisted head-pair fingerprint: baseline, delta, render identity.
 * `identity` is the digest (pre-hashed identity), so the delta paths can
 * carry the pair's stored segment through verbatim.
 */
export function pairFingerprint(
	baselineText: string,
	deltaText: string,
	identity: string,
): string {
	return `${md5(baselineText)}|${md5(deltaText)}|${identity}`;
}

export interface PairFingerprintParts {
	readonly baselineHash: string;
	readonly deltaHash?: string;
	/** Absent on pairs persisted before the identity segment existed. */
	readonly identityDigest?: string;
}

export function parsePairFingerprint(
	hash: string,
): PairFingerprintParts | undefined {
	const [baselineHash, deltaHash, identityDigest] = hash.split("|");
	if (baselineHash === undefined || baselineHash === "") return undefined;
	return {
		baselineHash,
		...(deltaHash !== undefined && deltaHash !== "" ? { deltaHash } : {}),
		...(identityDigest !== undefined && identityDigest !== ""
			? { identityDigest }
			: {}),
	};
}
