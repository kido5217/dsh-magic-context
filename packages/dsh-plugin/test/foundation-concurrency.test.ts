/**
 * Foundation concurrency (T014).
 *
 * (a) Two `runManagedChange` calls on ONE session serialize: their log
 *     brackets never interleave (derived from the session log itself — the
 *     durable record of the lock discipline).
 * (b) A foreign harness's store writer (direct core-storage writes in a loop
 *     on the same shared DB) runs concurrently with adapter managed changes:
 *     both complete, no rows corrupted, no lost decisions (spec edge case,
 *     finding E3 / quickstart V7b). Runs against a REAL temp store (the
 *     preload's XDG isolation, `openDatabaseAsync`).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta-session";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	expect(db).toBeTruthy();
});

afterAll(async () => {
	await closeDatabase();
});

const tick = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

/** Bracket order observed in the durable log: ["start:c1", "end:c1", …]. */
function bracketSequence(
	log: readonly { type: string; data: Record<string, unknown> }[],
): string[] {
	return log.map(
		(entry) =>
			`${entry.type === "mc/manage-start" ? "start" : "end"}:${entry.data.changeId}`,
	);
}

function assertNoInterleaving(sequence: string[]): void {
	let open: string | undefined;
	for (const step of sequence) {
		const [phase, changeId] = step.split(":") as ["start" | "end", string];
		if (phase === "start") {
			expect(open).toBeUndefined(); // a second start before the first end ⇒ interleaved brackets
			open = changeId;
		} else {
			expect<string | undefined>(changeId).toBe(open); // end must close the bracket that is open
			open = undefined;
		}
	}
	expect(open).toBeUndefined();
}

describe("managed-change serialization", () => {
	test("two runManagedChange calls on one session never interleave brackets", async () => {
		const host = new TestDshHost();
		const handle: AdapterHandle = mountAdapter(
			host,
			MagicContextConfigSchema.parse({}),
			db,
		);
		const session = host.addSession({ id: "s-serial" }, [0, 1, 2, 3, 4]);
		handle.mapping.upsert({ id: "s-serial" });

		let releaseFirst = (): void => {};
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});

		// Launch both concurrently; the first parks inside its decision step so
		// the second MUST queue behind the lock, not slip into the bracket.
		const first = handle.managedEdits.runManagedChange(
			"drop",
			"c1",
			"s-serial",
			{
				decision: async () => {
					await firstBlocked;
					return { targets: [1, 2] as const };
				},
				effect: async (decision) => {
					const { replacementSeq } = await session.replaceSurface(
						[{ type: "text", text: "fold-1" }],
						decision.targets[0],
						decision.targets[1],
						decision.targets,
					);
					return { replacementSeq, shadowedSeqs: decision.targets };
				},
			},
		);
		await tick();
		const second = handle.managedEdits.runManagedChange(
			"fold",
			"c2",
			"s-serial",
			{
				decision: async () => ({ targets: [0, 3] as const }),
				effect: async (decision) => {
					const { replacementSeq } = await session.replaceSurface(
						[{ type: "text", text: "fold-2" }],
						decision.targets[0],
						decision.targets[1],
						decision.targets,
					);
					return { replacementSeq, shadowedSeqs: decision.targets };
				},
			},
		);
		await tick();
		releaseFirst();
		const [s1, s2] = await Promise.all([first, second]);
		expect(s1.replacementSeq).toBeDefined();
		expect(s2.replacementSeq).toBeDefined();

		// Both bracketed the log: 2 starts + 2 ends, first fully closed before
		// the second opened despite concurrent launch.
		const sequence = bracketSequence(session.log);
		expect(sequence).toEqual(["start:c1", "end:c1", "start:c2", "end:c2"]);
		assertNoInterleaving(sequence);
		expect(session.surfaceNodes().length).toBe(3); // [4] + two replacements
		expect(handle.managedEdits.pendingUnapplied()).toEqual([]);
		await handle.dispose();
	});
});

describe("cross-harness store concurrency", () => {
	test("adapter writes + foreign-harness writer complete with intact rows", async () => {
		const host = new TestDshHost();
		const handle: AdapterHandle = mountAdapter(
			host,
			MagicContextConfigSchema.parse({}),
			db,
		);
		const session = host.addSession({ id: "s-contend" }, [0, 1, 2, 3]);
		handle.mapping.upsert({ id: "s-contend" });

		// Foreign writer: another harness process writing shared-store rows in a
		// loop (same storage API the OpenCode path uses).
		const foreignId = "foreign-opencode-session";
		let foreignWrites = 0;
		const foreignWriter = (async () => {
			getOrCreateSessionMeta(db, foreignId);
			for (let i = 1; i <= 30; i += 1) {
				updateSessionMeta(db, foreignId, { lastInputTokens: i * 100 });
				foreignWrites += 1;
				await tick();
			}
		})();

		// Adapter path: managed changes whose decision steps write the store.
		const adapterChanges = Promise.all(
			["m1", "m2"].map((changeId, index) =>
				handle.managedEdits.runManagedChange("drop", changeId, "s-contend", {
					decision: async () => {
						updateSessionMeta(db, "s-contend", {
							lastInputTokens: (index + 1) * 1_000,
						});
						await tick();
						return {
							targets: index === 0 ? ([0, 1] as const) : ([2, 3] as const),
						};
					},
					effect: async (decision) => {
						const { replacementSeq } = await session.replaceSurface(
							[{ type: "text", text: `fold-${changeId}` }],
							decision.targets[0],
							decision.targets[1],
							decision.targets,
						);
						return { replacementSeq, shadowedSeqs: decision.targets };
					},
				}),
			),
		);

		await Promise.all([foreignWriter, adapterChanges]);
		expect(foreignWrites).toBe(30);

		// No corruption: both rows readable, values consistent, harness
		// attribution intact on the adapter row.
		const foreign = getOrCreateSessionMeta(db, foreignId);
		expect(foreign.lastInputTokens).toBe(3_000);
		const adapter = getOrCreateSessionMeta(db, "s-contend");
		expect(adapter.isSubagent).toBe(false);
		expect(adapter.lastInputTokens).toBe(2_000); // last managed decision won
		const row = db
			.prepare("SELECT harness FROM session_meta WHERE session_id = ?")
			.get("s-contend") as { harness: string };
		expect(row.harness).toBe("dsh");

		// No lost decisions: both brackets closed cleanly.
		const sequence = bracketSequence(session.log);
		assertNoInterleaving(sequence);
		expect(sequence.filter((s) => s.startsWith("end:")).length).toBe(2);
		expect(handle.managedEdits.pendingUnapplied()).toEqual([]);
		await handle.dispose();
	});
});
