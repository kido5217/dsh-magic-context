/**
 * Protected-tail boundary (T029).
 *
 * The v1 adapter approximated the protected window with a token budget over the
 * newest messages (`splitProtectedTail`). The core's real rule is a boundary
 * SNAPSHOT: it fences tool-call arcs so a fold never splits an invocation from
 * its result, respects the compartment anchor, and derives the eligible end in
 * raw-message ORDINALS.
 *
 * DSH stores compartment boundaries as durable SEQS (the only coordinate that
 * survives shadowing — PARITY 8), while the resolver's index is ordinal-based.
 * This module owns exactly that conversion and nothing else: it asks the core
 * for everything policy-shaped, hands it the compartment anchor expressed as an
 * ordinal, and maps the result back to durable message ids.
 *
 * It is deliberately best-effort. A missing raw provider, a store hiccup or an
 * empty session returns undefined and the caller keeps its token-budget
 * fallback — an unresolvable boundary must never refuse a step.
 */

import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	resolveBoundaryContext,
	resolveProtectedTailBoundary,
} from "@magic-context/core/hooks/magic-context/protected-tail-boundary";
import { log } from "@magic-context/core/shared/logger";
import type { DshLogProjection } from "./dsh-session-log.js";
import { isAdapterSurfaceId } from "./dsh-session-log.js";

export interface DshBoundary {
	/** First ordinal (1-based) of the verbatim protected tail. */
	readonly protectedTailStart: number;
	/** Last ordinal eligible for a fold/drop. */
	readonly eligibleEndOrdinal: number;
	/** Durable ids of the protected tail, in surface order. */
	readonly protectedMessageIds: ReadonlySet<string>;
	/** Durable ids eligible for reduction, in surface order. */
	readonly eligibleMessageIds: readonly string[];
	/** How the boundary was resolved (evidence for gates/diagnostics). */
	readonly source: "resolver" | "fallback";
}

export interface DshBoundaryInput {
	readonly db: ContextDatabase;
	readonly config: MagicContextConfig;
	readonly mcSession: string;
	readonly projection: DshLogProjection;
	readonly contextWindow: number | undefined;
	readonly percentage: number | undefined;
	readonly pressureTokens: number | undefined;
	/** Emergency passes scale the tail down in the core's own policy. */
	readonly emergency?: boolean;
}

/** Ordinal of a durable message id in the current projection. */
function ordinalOf(
	projection: DshLogProjection,
	messageId: string | undefined,
): number | null {
	if (messageId === undefined) return null;
	return projection.byMessageId.get(messageId)?.ordinal ?? null;
}

/** Message id at one projection ordinal (1-based). */
function messageIdAt(
	projection: DshLogProjection,
	ordinal: number,
): string | null {
	for (const [messageId, entry] of projection.byMessageId) {
		if (entry.ordinal === ordinal) return messageId;
	}
	return null;
}

/**
 * Resolve the boundary, converting the compartment anchor from seq to ordinal.
 * Returns undefined whenever the snapshot cannot be trusted.
 */
export function resolveDshBoundary(
	input: DshBoundaryInput,
): DshBoundary | undefined {
	const { db, config, mcSession, projection } = input;
	if (projection.rawMessages.length === 0) return undefined;
	const contextLimit = input.contextWindow ?? 0;
	if (contextLimit <= 0) return undefined;
	try {
		// The store records the anchor as a durable SEQ; the resolver indexes
		// raw messages by ORDINAL. Convert through the projection, and clear the
		// anchor when its message is no longer projected (a fold moved past it).
		const anchorSeq = getLastCompartmentEndMessage(db, mcSession);
		const anchorMessageId =
			anchorSeq >= 0
				? (projection.records.find((record) => record.seq === anchorSeq)
						?.messageId ?? null)
				: null;
		const anchorOrdinal = ordinalOf(projection, anchorMessageId ?? undefined);
		const base = resolveBoundaryContext({
			db,
			sessionId: mcSession,
			mode: input.emergency === true ? "transform-force" : "trigger",
			contextLimit,
			executeThresholdPercentage: percentageOf(config),
			usage:
				input.pressureTokens !== undefined
					? {
							percentage: input.percentage ?? 0,
							inputTokens: input.pressureTokens,
						}
					: null,
			usageSource:
				input.pressureTokens !== undefined ? "live" : "provisional-zero",
			providerShapeVersion: "dsh-v1",
			cacheNamespace: `dsh:${mcSession}`,
			...(input.emergency === true ? { emergencyTailScale: 0.5 as const } : {}),
		});
		const snapshot = resolveProtectedTailBoundary({
			...base,
			lastCompartmentEndOrdinal:
				anchorOrdinal ?? base.lastCompartmentEndOrdinal,
			lastCompartmentEndMessageId: anchorMessageId,
		});
		const protectedMessageIds = new Set<string>();
		for (
			let ordinal = snapshot.protectedTailStart;
			ordinal <= projection.rawMessages.length;
			ordinal += 1
		) {
			const messageId = messageIdAt(projection, ordinal);
			if (messageId !== null && !isAdapterSurfaceId(messageId))
				protectedMessageIds.add(messageId);
		}
		const eligibleMessageIds: string[] = [];
		for (
			let ordinal = snapshot.offset;
			ordinal < snapshot.protectedTailStart;
			ordinal += 1
		) {
			const messageId = messageIdAt(projection, ordinal);
			if (messageId !== null && !isAdapterSurfaceId(messageId))
				eligibleMessageIds.push(messageId);
		}
		return {
			protectedTailStart: snapshot.protectedTailStart,
			eligibleEndOrdinal: snapshot.eligibleEndOrdinal,
			protectedMessageIds,
			eligibleMessageIds,
			source: "resolver",
		};
	} catch (error) {
		log(
			`[dsh-magic-context] protected-tail boundary unavailable for ${mcSession}; using the token-budget fallback: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

function percentageOf(config: MagicContextConfig): number {
	const value = config.execute_threshold_percentage;
	return typeof value === "number" ? value : (value?.default ?? 85);
}

/** The token-budget fallback, used when the boundary cannot be resolved. */
export function fallbackProtectedMessageIds(
	projection: DshLogProjection,
	protectedTail: readonly { messageId: string }[],
): Set<string> {
	return new Set(
		protectedTail
			.map((record) => record.messageId)
			.filter((id) => !isAdapterSurfaceId(id)),
	);
}
