/**
 * Overflow recovery lane (T028).
 *
 * A provider can reject a request as too large even when the meter believed it
 * would fit — the route's real window is smaller than advertised, or the
 * estimate drifted. DSH surfaces that as `agent/request-error`, a waterfall
 * whose `retry` action re-sends the request. The recovery is:
 *
 *   detect overflow → learn the route's real limit → fold → retry once.
 *
 * Detection and limit extraction are the core's `detectOverflow` (pattern list
 * and provenance included). What this module owns is the DSH policy:
 *
 * - **Learn conservatively.** A reported limit is recorded as the session's
 *   learned window, and the pass prices against `min(advertised, learned)` from
 *   then on — a route that once reported 128k is never treated as 200k again in
 *   this process.
 * - **Retry at most once per failing request.** A second overflow after a fold
 *   means folding cannot fix it (a single oversized message), so the error is
 *   returned to the host unchanged rather than looping.
 * - **Learn in memory, not in the shared schema.** The limit is a property of
 *   the live route in this process; persisting it would require a new shared
 *   column that no other host reads, which the repo boundary forbids without a
 *   cross-host decision (recorded in the census as the remaining gap).
 */
import {
	detectOverflow,
	type OverflowDetection,
} from "@magic-context/core/features/magic-context/overflow-detection";
import { log } from "@magic-context/core/shared/logger";

/** What the adapter remembers about one session's route after an overflow. */
export interface LearnedLimit {
	readonly limit?: number;
	readonly reportedInputTokens?: number;
	/** The pressure percentage that triggered the rejection, when derivable. */
	readonly percentage?: number;
}

/** Detect an overflow from an arbitrary error value (host failure envelope included). */
export function detectOverflowError(error: unknown): OverflowDetection {
	return detectOverflow(error);
}

/** Extract the durable lesson from a detection (no store write). */
export function learnFromOverflow(
	detection: OverflowDetection,
	advertisedWindow?: number,
): LearnedLimit {
	const limit =
		detection.reportedLimit !== undefined ? detection.reportedLimit : undefined;
	const percentage =
		detection.reportedInputTokens !== undefined &&
		limit !== undefined &&
		limit > 0
			? Math.min(100, Math.ceil((detection.reportedInputTokens / limit) * 100))
			: undefined;
	return {
		...(limit !== undefined ? { limit } : {}),
		...(detection.reportedInputTokens !== undefined
			? { reportedInputTokens: detection.reportedInputTokens }
			: {}),
		...(percentage !== undefined ? { percentage } : {}),
		...(advertisedWindow !== undefined &&
		limit !== undefined &&
		limit > advertisedWindow
			? { limit: advertisedWindow }
			: {}),
	};
}

/**
 * Per-process learned windows. Keyed by session so two sessions on different
 * routes do not contaminate each other's pricing.
 */
export class OverflowLedger {
	private readonly learned = new Map<string, LearnedLimit>();

	/** `min(advertised, learned)` — the window the pass should price against. */
	effectiveWindow(
		sessionId: string,
		advertised: number | undefined,
	): number | undefined {
		const learned = this.learned.get(sessionId)?.limit;
		if (learned === undefined) return advertised;
		if (advertised === undefined) return learned;
		return Math.min(advertised, learned);
	}

	record(
		sessionId: string,
		detection: OverflowDetection,
		advertised?: number,
	): LearnedLimit | undefined {
		if (!detection.isOverflow) return undefined;
		const lesson = learnFromOverflow(detection, advertised);
		const previous = this.learned.get(sessionId);
		// Keep the tightest knowledge; a later, larger report never loosens it.
		const merged: LearnedLimit = {
			...(lesson.limit !== undefined
				? {
						limit:
							previous?.limit !== undefined
								? Math.min(previous.limit, lesson.limit)
								: lesson.limit,
					}
				: previous?.limit !== undefined
					? { limit: previous.limit }
					: {}),
			...(lesson.reportedInputTokens !== undefined
				? { reportedInputTokens: lesson.reportedInputTokens }
				: previous?.reportedInputTokens !== undefined
					? { reportedInputTokens: previous.reportedInputTokens }
					: {}),
		};
		this.learned.set(sessionId, merged);
		log(
			`[dsh-magic-context] overflow learned for ${sessionId}: limit ${String(merged.limit ?? "unknown")} (pattern ${detection.matchedPattern ?? "413"})`,
		);
		return merged;
	}

	peek(sessionId: string): LearnedLimit | undefined {
		return this.learned.get(sessionId);
	}

	detach(sessionId: string): void {
		this.learned.delete(sessionId);
	}

	detachAll(): void {
		this.learned.clear();
	}
}

/** One recorded overflow attempt, so a repeated failure cannot loop. */
export class OverflowRecoveryGate {
	private readonly attempts = new Map<string, number>();

	/** True when this request has NOT yet been retried after a fold. */
	claim(sessionId: string): boolean {
		const count = this.attempts.get(sessionId) ?? 0;
		if (count >= 1) return false;
		this.attempts.set(sessionId, count + 1);
		return true;
	}

	reset(sessionId: string): void {
		this.attempts.delete(sessionId);
	}

	detachAll(): void {
		this.attempts.clear();
	}
}

/**
 * Fold-before-retry. The caller passes the fold it wants to run (the pre-step
 * pass's historian), so the overflow path reuses the same summarizer and the
 * same coverage bookkeeping.
 */
export async function recoverOverflow(input: {
	readonly sessionId: string;
	readonly detection: OverflowDetection;
	readonly ledger: OverflowLedger;
	readonly gate: OverflowRecoveryGate;
	readonly advertisedWindow?: number;
	readonly fold: () => Promise<unknown>;
}): Promise<boolean> {
	if (!input.detection.isOverflow) return false;
	input.ledger.record(input.sessionId, input.detection, input.advertisedWindow);
	if (!input.gate.claim(input.sessionId)) return false;
	try {
		const outcome = await input.fold();
		if (outcome === null) {
			// Nothing was folded: release the claim so a later overflow in the
			// session can still attempt recovery (N-02).
			input.gate.reset(input.sessionId);
			return false;
		}
		return true;
	} catch (error) {
		input.gate.reset(input.sessionId);
		log(
			`[dsh-magic-context] overflow recovery fold failed for ${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}
