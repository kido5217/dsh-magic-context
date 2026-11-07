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
