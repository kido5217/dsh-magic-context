/**
 * Manual compaction (T073): `/compact` performs a real MC fold.
 *
 * The durable shape is the host's contract (docs/subsystems/compaction.md,
 * @deepseek-ai/dsh-compaction/types): `compaction/start` → managed bracket →
 * `compaction/summary` immediately followed by ONE replacing `user/message`
 * carrying the checkpoint source → `compaction/end`, and a `CompactionResult`
 * naming the real event seqs. These tests pin exactly one replacement, real
 * seqs, a silent no-op for an empty window, and the shared busy guard that
 * serializes `/compact` against the command folds and the pre-step pass.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { ManualCompactAgentContext } from "@deepseek-ai/dsh-compaction";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { McCompactionClaim } from "../src/compaction-claim.js";
import { TestDshHost } from "./double.js";
import { seedSession, stepFor, us1Mount } from "./us1-support.js";

let db: ContextDatabase;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
});

afterAll(async () => {
	await closeDatabase();
});

/** One macrotask turn: Cordis services publish on their async init. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function agentFor(sessionId: string): ManualCompactAgentContext {
	return {
		session: { id: sessionId },
		options: {},
		runMaintenance: async (
			task: (signal: AbortSignal) => Promise<unknown>,
		): Promise<unknown> => task(new AbortController().signal),
	} as unknown as ManualCompactAgentContext;
}

function rejection(promise: Promise<unknown>): Promise<ManualCompactionError> {
	return promise.then(
		() => {
			throw new Error("expected a ManualCompactionError rejection");
		},
		(error: unknown) => error as ManualCompactionError,
	);
}

describe("manual compaction fold (T072/T073)", () => {
	test("a full fold writes the lifecycle pair, ONE checkpoint replacement, and real seqs", async () => {
		const host = new TestDshHost();
		const fake = seedSession(host, "s-compact-full", 10);
		const handle = us1Mount(host, db);
		await settle();
		const engine = host.ctx.reflect.get("compaction") as McCompactionClaim;
		expect(engine).toBeInstanceOf(McCompactionClaim);
		// Managed pass: attach + head pair materialize (appends, no replaces).
		await host.firePreStep(stepFor("s-compact-full"));
		const replacementsBefore = fake.replacements.length;
		expect(replacementsBefore).toBe(0);
		host.pressureReadings.set("s-compact-full", {
			pressureTokens: 5_000,
			contextWindow: 10_000,
		});
		host.llmResponder = () => ({ text: "folded history summary body" });
		const result = await engine.compactNow(
			agentFor("s-compact-full"),
			new AbortController().signal,
			"cmd-compact-1",
		);
		expect(result).not.toBeNull();
		const fold = result!;
		expect(String(fold.compactionId)).toMatch(/^mc-/);
		expect(String(fold.sourceCommandId)).toBe("cmd-compact-1");

		// Lifecycle: start → summary → end, in order, carrying the seqs the
		// result reports — real durable seqs, not synthesized ones.
		const phases = fake.compactionEvents.map((event) => event.phase);
		expect(phases).toEqual(["start", "summary", "end"]);
		expect(Number(fold.startSeq)).toBe(fake.compactionEvents[0]!.seq);
		expect(Number(fold.summarySeq)).toBe(fake.compactionEvents[1]!.seq);
		expect(Number(fold.endSeq)).toBe(fake.compactionEvents[2]!.seq);
		expect(
			fake.compactionEvents.every(
				(event) => event.data["compactionId"] === fold.compactionId,
			),
		).toBe(true);
		const summary = fake.compactionEvents[1]!.data;
		expect(summary["provider"]).toBe("aux");
		expect(summary["model"]).toBe("hist-1");
		expect(
			(summary["shadowedSeqs"] as readonly number[]).length,
		).toBeGreaterThan(0);
		expect(summary["shadowedTokenCount"]).toBeGreaterThan(0);

		// Exactly ONE surface replacement for the fold, stamped with the
		// host's checkpoint source correlated with the transaction id.
		expect(fake.replacements.length).toBe(replacementsBefore + 1);
		const edit = fake.replacements[fake.replacements.length - 1]!;
		expect(edit.checkpoint).toBeDefined();
		expect(edit.checkpoint!.compactionId).toBe(String(fold.compactionId));
		expect(edit.checkpoint!.sourceCommandId).toBe("cmd-compact-1");
		// The replacement node is the new head baseline (it carries the fold).
		expect(JSON.stringify(edit.content)).toContain("session-history");

		// Shadow accounting matches the applied edit; the range names its
		// surface edges.
		expect(fold.shadowedSeqs.map((seq) => Number(seq))).toEqual([
			...edit.shadowedSeqs,
		]);
		expect(Number(fold.shadowedRange.start)).toBe(edit.shadowedSeqs[0]!);
		expect(Number(fold.shadowedRange.end)).toBe(
			edit.shadowedSeqs[edit.shadowedSeqs.length - 1]!,
		);

		// The folded messages left the surface (the protected tail stays);
		// the store gained coverage holding the historian's summary.
		for (const seq of [0, 1, 2, 3, 4, 5, 6, 7])
			expect(fake.surfaceNodes()).not.toContain(seq);
		const compartments = getCompartments(db, "s-compact-full");
		expect(compartments.length).toBe(1);
		expect(compartments[0]!.content).toContain("folded history summary body");

		// Summary blocks ride the result for the command renderer.
		expect(JSON.stringify(fold.summary)).toContain("folded history summary");

		// Coverage moved: a second immediate fold finds an empty window and
		// stays silent (no further lifecycle events).
		const again = await engine.compactNow(
			agentFor("s-compact-full"),
			new AbortController().signal,
		);
		expect(again).toBeNull();
		expect(fake.compactionEvents.length).toBe(3);
		await handle.dispose();
	});

	test("an empty foldable window returns null and writes NOTHING to the log", async () => {
		const host = new TestDshHost();
		const fake = seedSession(host, "s-compact-empty", 1);
		const handle = us1Mount(host, db);
		await settle();
		const engine = host.ctx.reflect.get("compaction") as McCompactionClaim;
		await host.firePreStep(stepFor("s-compact-empty"));
		const eventsBefore = fake.compactionEvents.length;
		const logBefore = fake.log.length;
		const noticesBefore = fake.notices.length;
		const replacementsBefore = fake.replacements.length;
		const surfaceBefore = [...fake.surfaceNodes()];
		const llmBefore = host.llmCalls;
		host.llmResponder = () => ({ text: "must not be called" });
		const result = await engine.compactNow(
			agentFor("s-compact-empty"),
			new AbortController().signal,
		);
		expect(result).toBeNull();
		expect(fake.compactionEvents.length).toBe(eventsBefore);
		expect(fake.log.length).toBe(logBefore);
		expect(fake.notices.length).toBe(noticesBefore);
		expect(fake.replacements.length).toBe(replacementsBefore);
		expect(fake.surfaceNodes()).toEqual(surfaceBefore);
		expect(host.llmCalls).toBe(llmBefore);
		await handle.dispose();
	});

	test("a second fold while one is in flight is rejected busy; the guard is shared", async () => {
		const host = new TestDshHost();
		const fake = seedSession(host, "s-compact-busy", 10);
		const handle = us1Mount(host, db);
		await settle();
		const engine = host.ctx.reflect.get("compaction") as McCompactionClaim;
		await host.firePreStep(stepFor("s-compact-busy"));
		host.llmResponder = () => ({ text: "first fold wins the slot" });
		// Both fired synchronously: the first holds the slot while its aux
		// call is in flight, so the second must bounce with `busy`.
		const first = engine.compactNow(
			agentFor("s-compact-busy"),
			new AbortController().signal,
		);
		const second = engine.compactNow(
			agentFor("s-compact-busy"),
			new AbortController().signal,
		);
		const rejected = await rejection(second);
		expect(rejected).toBeInstanceOf(ManualCompactionError);
		expect(rejected.code).toBe("busy");
		const result = await first;
		expect(result).not.toBeNull();
		expect(handle.compaction.foldInFlight("s-compact-busy")).toBe(false);

		// One guard, every entry point: with the slot held (by whichever
		// path), the command fold declines.
		expect(handle.compaction.beginFold("s-compact-busy")).toBe(true);
		const declined = await handle.lanes.manualFold("s-compact-busy");
		expect(declined).toContain("already running");
		expect(fake.replacements.length).toBeGreaterThanOrEqual(1);
		handle.compaction.endFold("s-compact-busy");
		await handle.dispose();
	});

	test("an unmanaged session still gets the not-managed refusal", async () => {
		const host = new TestDshHost();
		host.addSession({ id: "s-compact-unmanaged" }, [0, 1]);
		const handle = us1Mount(host, db);
		await settle();
		const engine = host.ctx.reflect.get("compaction") as McCompactionClaim;
		// compactNow: the documented no-op for unmanaged sessions.
		expect(
			await engine.compactNow(
				agentFor("s-compact-unmanaged"),
				new AbortController().signal,
			),
		).toBeNull();
		// compactRegion: an actionable refusal, not a silent null.
		const rejected = await rejection(
			engine.compactRegion(
				0,
				1,
				agentFor("s-compact-unmanaged"),
				new AbortController().signal,
			),
		);
		expect(rejected).toBeInstanceOf(ManualCompactionError);
		expect(rejected.code).toBe("changed");
		expect(rejected.message).toContain("not Magic-Context-managed");
		await handle.dispose();
	});

	test("a region fold revalidates the span and folds inside it", async () => {
		const host = new TestDshHost();
		const fake = seedSession(host, "s-compact-region", 10);
		const handle = us1Mount(host, db);
		await settle();
		const engine = host.ctx.reflect.get("compaction") as McCompactionClaim;
		await host.firePreStep(stepFor("s-compact-region"));
		const replacementsBefore = fake.replacements.length;
		host.pressureReadings.set("s-compact-region", {
			pressureTokens: 5_000,
			contextWindow: 10_000,
		});
		host.llmResponder = () => ({ text: "region summary" });
		const result = await engine.compactRegion(
			2,
			4,
			agentFor("s-compact-region"),
			new AbortController().signal,
		);
		// The fold stayed inside 2..4: the region head folded, its tail is
		// the protected tail of the selection, everything outside survives.
		expect(Number(result.shadowedRange.start)).toBe(2);
		const shadowed = result.shadowedSeqs.map((seq) => Number(seq));
		expect(shadowed).toContain(2);
		expect(shadowed).toContain(3);
		expect(shadowed).not.toContain(4);
		for (const seq of result.shadowedSeqs.map((seq) => Number(seq)))
			expect(seq <= 4 || seq >= 10).toBe(true);
		expect(fake.replacements.length).toBe(replacementsBefore + 1);
		expect(fake.replacements[replacementsBefore]!.checkpoint).toBeDefined();
		// Window budget keeps the region's last message as the protected
		// tail; everything outside the selection survives untouched.
		for (const seq of [0, 1, 4, 5, 6, 7, 8, 9])
			expect(fake.surfaceNodes()).toContain(seq);
		expect(fake.surfaceNodes()).not.toContain(2);
		// Span edges gone from the surface ⇒ `changed`, no surface write.
		const rejected = await rejection(
			engine.compactRegion(
				100,
				101,
				agentFor("s-compact-region"),
				new AbortController().signal,
			),
		);
		expect(rejected.code).toBe("changed");
		await handle.dispose();
	});
});
