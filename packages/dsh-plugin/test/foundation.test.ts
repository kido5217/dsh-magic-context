/**
 * Foundation mount/unmount + fail-closed unit proof (T013).
 *
 * Mounts the real adapter (mountAdapter) on the host double against a REAL
 * temp store (openDatabaseAsync under the preload's XDG isolation) and
 * asserts: (a) unmount leaves no orphan handles or services; (b) a store-busy
 * decision writes start+end(error), mutates no surface, and rejects with
 * StoreUnavailableError — the T009 wrapper, unit-proven (FR-004).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { closeDatabase, openDatabaseAsync, type ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { getHarness, setHarness } from "@magic-context/core/shared/harness";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { mountAdapter, StoreBusyError, StoreUnavailableError, type AdapterHandle } from "../src/index.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let host: TestDshHost;
let handle: AdapterHandle | undefined;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({ dbPath: join(getMagicContextStorageDir(), "context.db"), nativeTurnDeadlines: true }))!;
	expect(db).toBeTruthy();
});

// Fresh root context per test: service (re-)provisioning must not leak
// across mounts.
function freshHost(): TestDshHost {
	host = new TestDshHost();
	return host;
}

afterAll(async () => {
	await handle?.dispose();
	handle = undefined;
	await closeDatabase();
});

describe("mount / unmount", () => {
	test("mount registers the compaction claim; unmount unwinds every handle", async () => {
		freshHost();
		const config = MagicContextConfigSchema.parse({});
		handle = mountAdapter(host, config, db);

		// The claim service is live while mounted.
		expect(host.ctx.reflect.get("compaction")).toBeTruthy();

		// What T015/T031 will attach through the host seam must unwind too:
		// simulate a tool + pre-step registration owned by the mount. (The
		// count is relative to the mount's own registrations — the T015 pass
		// bridge attaches a pre-step listener of its own.)
		const mounted = host.liveHandleCount();
		const unregisterTool = host.registerTool({
			name: "ctx_probe",
			description: "probe",
			parameters: { type: "object" },
			output: { schema: { type: "string" }, render: () => [] },
			execute: async () => "ok",
		} as never);
		const offPreStep = host.onPreStep(() => "enter");
		expect(host.liveHandleCount()).toBe(mounted + 2);

		await handle.dispose();
		handle = undefined;

		unregisterTool();
		offPreStep();
		expect(host.liveHandleCount()).toBe(0);
		expect(host.ctx.reflect.get("compaction")).toBeUndefined();
	});

	test("mount stamps harness='dsh' on mapped rows and classifies roles (T008)", async () => {
		freshHost();
		const config = MagicContextConfigSchema.parse({});
		handle = mountAdapter(host, config, db);
		host.addSession({ id: "s-primary" });
		host.addSession({ id: "s-sub", origin: "subagent", parentSession: "s-primary", delegationDepth: 1 });
		host.addSession({ id: "s-unknown" });

		const primary = handle.mapping.upsert({ id: "s-primary" });
		const sub = handle.mapping.upsert({ id: "s-sub", origin: "subagent", parentSession: "s-primary", delegationDepth: 1 });
		const unknown = handle.mapping.upsert({ id: "s-unknown", origin: undefined });
		expect(primary.role).toBe("primary");
		expect(sub.role).toBe("subagent");
		expect(sub.parentDshSessionId).toBe("s-primary");
		// Unknown lineage ⇒ primary (safe default, D9).
		expect(unknown.role).toBe("primary");

		expect(getHarness()).toBe("dsh");
		expect(getOrCreateSessionMeta(db, "s-sub").isSubagent).toBe(true);
		expect(getOrCreateSessionMeta(db, "s-primary").isSubagent).toBe(false);
		const row = db.prepare("SELECT harness FROM session_meta WHERE session_id = ?").get("s-sub") as { harness: string };
		expect(row.harness).toBe("dsh");

		// Idempotent: re-upsert keeps one row and the same role.
		handle.mapping.upsert({ id: "s-sub", origin: "subagent", parentSession: "s-primary", delegationDepth: 1 });
		const count = db.prepare("SELECT COUNT(*) AS n FROM session_meta WHERE session_id = ?").get("s-sub") as { n: number };
		expect(count.n).toBe(1);

		await handle.dispose();
		handle = undefined;
	});
});

describe("managed edits fail-closed (T009)", () => {
	test("store-busy decision ⇒ start+end(error), no surface mutation, StoreUnavailableError", async () => {
		freshHost();
		handle = mountAdapter(host, MagicContextConfigSchema.parse({}), db);
		const session = host.addSession({ id: "s-busy" });
		handle.mapping.upsert({ id: "s-busy" });
		const surfaceBefore = session.surfaceNodes();

		const run = handle.managedEdits.runManagedChange("drop", "chg-busy", "s-busy", {
			decision: async () => {
				throw new StoreBusyError("database is locked (SQLITE_BUSY)");
			},
			effect: async () => {
				throw new Error("effect must not run after a failed decision");
			},
		});
		await expect(run).rejects.toBeInstanceOf(StoreUnavailableError);

		const starts = session.eventsOf("mc/manage-start");
		const ends = session.eventsOf("mc/manage-end");
		expect(starts.length).toBe(1);
		expect(ends.length).toBe(1);
		expect(starts[0].data).toMatchObject({ changeId: "chg-busy", kind: "drop", mcSession: "s-busy", dshSessionId: "s-busy", ignorable: true });
		expect(String(ends[0].data.error)).toContain("StoreBusyError");
		expect(ends[0].data.replacementSeq).toBeUndefined();
		// Fail-closed: the surface was never touched.
		expect(session.surfaceNodes()).toEqual(surfaceBefore);
		// The bracket was error-closed ⇒ nothing pending for crash-resume.
		expect(handle.managedEdits.pendingUnapplied()).toEqual([]);

		await handle.dispose();
		handle = undefined;
	});

	test("success path: decision then effect then end-with-shadow", async () => {
		freshHost();
		handle = mountAdapter(host, MagicContextConfigSchema.parse({}), db);
		const session = host.addSession({ id: "s-ok" }, [0, 1, 2, 3]);
		handle.mapping.upsert({ id: "s-ok" });

		const shadow = await handle.managedEdits.runManagedChange("drop", "chg-ok", "s-ok", {
			decision: async () => ({ targets: [1, 2] as const }),
			effect: async (decision) => {
				const [startSeq, endSeq] = decision.targets;
				const { replacementSeq } = await session.replaceSurface([{ type: "text", text: "folded" }], startSeq, endSeq, decision.targets);
				return { replacementSeq, shadowedSeqs: decision.targets };
			},
		});

		expect(shadow.replacementSeq).toBeTypeOf("number");
		const ends = session.eventsOf("mc/manage-end");
		expect(ends.length).toBe(1);
		expect(ends[0].data).toMatchObject({ changeId: "chg-ok", kind: "drop", shadowedSeqs: [1, 2] });
		expect(session.surfaceNodes()).toEqual([0, 3, shadow.replacementSeq!]);
		expect(handle.managedEdits.pendingUnapplied()).toEqual([]);

		await handle.dispose();
		handle = undefined;
	});
});

describe("pressure meter bridge (T012)", () => {
	test("meter unavailable ⇒ below execute; readings map to core bands", async () => {
		freshHost();
		handle = mountAdapter(host, MagicContextConfigSchema.parse({}), db);
		host.addSession({ id: "s-pressure" });

		// No reading yet ⇒ conservative (D6).
		expect(handle.meter.read("s-pressure").percentage).toBeNull();
		expect(handle.meter.lane("s-pressure")).toBe("below-execute");

		host.pressureReadings.set("s-pressure", { pressureTokens: 7_000, contextWindow: 10_000 });
		const bands = handle.meter.read("s-pressure");
		// Shared config default threshold 65 ⇒ execute 65, force 85, refuse 95
		// (core shared/escalation-bands.ts).
		expect(bands).toMatchObject({ percentage: 70, execute: 65, force: 85, refuse: 95 });
		expect(handle.meter.lane("s-pressure")).toBe("execute");

		host.pressureReadings.set("s-pressure", { pressureTokens: 9_600, contextWindow: 10_000 });
		expect(handle.meter.lane("s-pressure")).toBe("refuse");

		await handle.dispose();
		handle = undefined;
	});
});

describe("compaction claim (T011)", () => {
	test("managed sessions: automatic folding suppressed, explicit folds delegate", async () => {
		freshHost();
		let foldCalls = 0;
		handle = mountAdapter(host, MagicContextConfigSchema.parse({}), db, {
			fold: async () => {
				foldCalls += 1;
				return null;
			},
		});
		host.addSession({ id: "s-claim" });
		handle.compaction.attach("s-claim");
		expect(handle.compaction.isManaged("s-claim")).toBe(true);

		const engine = host.ctx.reflect.get("compaction") as {
			compactIfNeeded: (agent: { session: { id: string } }, trigger: string, signal: AbortSignal) => Promise<unknown>;
			compactNow: (agent: { session: { id: string } }, signal: AbortSignal) => Promise<unknown>;
		};
		const agent = { session: { id: "s-claim" } };
		expect(await engine.compactIfNeeded(agent, "pressure", new AbortController().signal)).toBeNull();
		expect(foldCalls).toBe(0);
		expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull();
		expect(foldCalls).toBe(1); // delegated to the MC fold callback

		handle.compaction.detach("s-claim");
		expect(handle.compaction.isManaged("s-claim")).toBe(false);
		expect(await engine.compactIfNeeded(agent, "pressure", new AbortController().signal)).toBeNull();
		expect(await engine.compactNow(agent, new AbortController().signal)).toBeNull();
		expect(foldCalls).toBe(1); // non-managed ⇒ no-op

		await handle.dispose();
		handle = undefined;
	});
});
