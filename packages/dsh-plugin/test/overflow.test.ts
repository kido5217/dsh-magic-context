/**
 * Overflow recovery (T028).
 *
 * Detection and limit extraction are the core's; the DSH policy under test is
 * that a reported limit TIGHTENS the session's window for later passes, that a
 * later, larger report never loosens it, and that a failing request is retried
 * at most once (a second overflow means folding cannot fix it).
 */
import { describe, expect, test } from "bun:test";
import {
	detectOverflowError,
	OverflowLedger,
	OverflowRecoveryGate,
	recoverOverflow,
} from "../src/lanes/overflow.js";

const OVERFLOW_ERROR = new Error(
	"400 Bad Request: prompt is too long: 210000 tokens > 128000 maximum context length",
);

describe("overflow recovery", () => {
	test("detects an overflow and reads its limit", () => {
		const detection = detectOverflowError(OVERFLOW_ERROR);
		expect(detection.isOverflow).toBe(true);
		const plain = detectOverflowError(new Error("connection reset"));
		expect(plain.isOverflow).toBe(false);
	});

	test("the learned window tightens and never loosens", () => {
		const ledger = new OverflowLedger();
		ledger.record("s-of", detectOverflowError(OVERFLOW_ERROR), 200_000);
		const learned = ledger.peek("s-of");
		expect(learned?.limit).toBeDefined();
		expect(learned!.limit!).toBeLessThanOrEqual(128_000);
		// A later report of a larger limit cannot widen what we already learned.
		ledger.record(
			"s-of",
			{ isOverflow: true, reportedLimit: 900_000 },
			200_000,
		);
		expect(ledger.effectiveWindow("s-of", 200_000)).toBe(learned!.limit!);
		// A larger advertised window is clamped to the learned one.
		expect(ledger.effectiveWindow("s-of", 1_000_000)).toBe(learned!.limit!);
		// A smaller advertised window still wins.
		expect(ledger.effectiveWindow("s-of", 64_000)).toBe(64_000);
	});

	test("a request is retried at most once", async () => {
		const ledger = new OverflowLedger();
		const gate = new OverflowRecoveryGate();
		let folds = 0;
		const attempt = () =>
			recoverOverflow({
				sessionId: "s-retry",
				detection: detectOverflowError(OVERFLOW_ERROR),
				ledger,
				gate,
				fold: async () => {
					folds += 1;
					return { folded: true };
				},
			});
		expect(await attempt()).toBe(true);
		expect(folds).toBe(1);
		// Second failure for the same request: no second fold, no retry.
		expect(await attempt()).toBe(false);
		expect(folds).toBe(1);
	});

	test("a fold that folds nothing releases the claim for a later overflow (N-02)", async () => {
		const ledger = new OverflowLedger();
		const gate = new OverflowRecoveryGate();
		let folds = 0;
		const attempt = (outcome: unknown) =>
			recoverOverflow({
				sessionId: "s-noop",
				detection: detectOverflowError(OVERFLOW_ERROR),
				ledger,
				gate,
				fold: async () => {
					folds += 1;
					return outcome;
				},
			});
		// A fold that returns null folded nothing → release, don't latch.
		expect(await attempt(null)).toBe(false);
		expect(folds).toBe(1);
		// The next overflow gets a fresh attempt because the claim was released.
		expect(await attempt({ folded: true })).toBe(true);
		expect(folds).toBe(2);
		// A real fold latches the claim: the next overflow cannot re-fold.
		expect(await attempt({ folded: true })).toBe(false);
		expect(folds).toBe(2);
	});

	test("a pre-step pass releases a completed recovery for the next episode (N-02)", () => {
		// The gate release path in runPass: reset(sessionId) clears the one-shot
		// claim so a later overflow is a new episode, matching the core.
		const gate = new OverflowRecoveryGate();
		expect(gate.claim("s-episode")).toBe(true);
		expect(gate.claim("s-episode")).toBe(false);
		gate.reset("s-episode");
		expect(gate.claim("s-episode")).toBe(true);
	});

	test("a failed fold does not authorize a retry", async () => {
		const ledger = new OverflowLedger();
		const gate = new OverflowRecoveryGate();
		const recovered = await recoverOverflow({
			sessionId: "s-fold-fail",
			detection: detectOverflowError(OVERFLOW_ERROR),
			ledger,
			gate,
			fold: async () => {
				throw new Error("store busy");
			},
		});
		expect(recovered).toBe(false);
	});
});

// ─── N-02: the learned window prices the BAND, not just the budgets ───

import { PressureMeter } from "../src/pressure/meter.js";

describe("pressure band with learned window (N-02)", () => {
	const host = {
		// Advertises 200k but the route really serves ~128k.
		pressure: (_sessionId: string) => ({
			pressureTokens: 110_000,
			contextWindow: 200_000,
		}),
	} as never;
	const config = { execute_threshold_percentage: 65 };

	test("advertised-only pricing sits below execute; learned pricing forces", () => {
		const meter = new PressureMeter(host, config);
		// 110k/200k = 55% → below the 65% execute threshold.
		expect(meter.lane("s-band")).toBe("below-execute");
		// Ledger says the route actually rejects at ~128k: the SAME pass must
		// now see 110k/128k ≈ 86% → inside the execute/force band, so folds
		// trigger BEFORE the provider wall, matching the T028 comment.
		const ledger = new OverflowLedger();
		ledger.record(
			"s-band",
			detectOverflowError(OVERFLOW_ERROR),
			200_000,
		);
		meter.setWindowOverlay((id, advertised) =>
			ledger.effectiveWindow(id, advertised),
		);
		expect(meter.lane("s-band")).toBe("force");
	});
});
