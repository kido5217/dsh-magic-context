/**
 * US1 lane behavior (T022): fold-before-enter at force, refusal at the wall
 * (with its single user-visible notice), fail-closed on store loss, and the
 * claim/registration lifecycle.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import type { AdapterHandle } from "../src/index.js";
import { TestDshHost } from "./double.js";
import {
	clearPressure,
	seedSession,
	setPressure,
	stepFor,
	us1Mount,
} from "./us1-support.js";

let db: ContextDatabase;
let host: TestDshHost;
let handle: AdapterHandle | undefined;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
});

afterAll(async () => {
	await handle?.dispose();
	handle = undefined;
	await closeDatabase();
});

const refusalOf = (sessionId: string) =>
	host.sessions
		.get(sessionId)!
		.notices.filter((notice) =>
			notice.content.some(
				(block) =>
					typeof (block as { text?: string }).text === "string" &&
					(block as { text: string }).text.includes("Magic Context refused"),
			),
		);

describe("US1 lanes: fold-first, refusal episode, fail-closed", () => {
	test("force band calls the model BEFORE publishing (no decision without a summary)", async () => {
		host = new TestDshHost();
		handle = us1Mount(host, db);
		seedSession(host, "l-force", 8);
		let compartmentsAtCallTime = -1;
		host.llmResponder = () => {
			compartmentsAtCallTime = getCompartments(db, "l-force").length;
			return { text: "Folded." };
		};
		setPressure(host, "l-force", 8_700);
		expect(await host.firePreStep(stepFor("l-force"))).toBe("enter");
		expect(compartmentsAtCallTime).toBe(0); // the aux call precedes the publish
		expect(getCompartments(db, "l-force")).toHaveLength(1); // …and only the publish persists
		// First attach joins the compaction claim (documented integration point).
		expect(handle.compaction.isManaged("l-force")).toBe(true);
	});

	test("force band with a failing model proceeds untouched (retry next pass)", async () => {
		seedSession(host, "l-force-fail", 8);
		host.llmResponder = () => ({ fail: true });
		setPressure(host, "l-force-fail", 8_700);
		expect(await host.firePreStep(stepFor("l-force-fail"))).toBe("enter"); // below the wall ⇒ proceed
		const session = host.sessions.get("l-force-fail")!;
		expect(session.eventsOf("mc/manage-start")).toHaveLength(0); // surface untouched
		expect(session.surfaceNodes()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
		expect(session.notices).toHaveLength(0);
	});

	test("refuse band with nothing foldable rejects the step, one notice per episode", async () => {
		seedSession(host, "l-refuse", 2);
		host.llmResponder = () => ({ fail: true });
		setPressure(host, "l-refuse", 9_600);
		expect(await host.firePreStep(stepFor("l-refuse"))).toBe("reject");
		expect(refusalOf("l-refuse")).toHaveLength(1);
		// The user's messages remain in history (the refusal notice is the
		// only node appended): nothing was shadowed.
		const surface = host.sessions.get("l-refuse")!.surfaceNodes();
		expect(surface).toContain(0);
		expect(surface).toContain(1);

		expect(await host.firePreStep(stepFor("l-refuse"))).toBe("reject");
		expect(refusalOf("l-refuse")).toHaveLength(1); // same episode ⇒ no spam
	});

	test("subagent sessions map to the memory-quiet rule set", async () => {
		seedSession(host, "l-sub", 2, "subagent");
		clearPressure(host, "l-sub");
		expect(await host.firePreStep(stepFor("l-sub"))).toBe("enter");
		const mapping = handle!.mapping.get("l-sub");
		expect(mapping?.role).toBe("subagent");
	});

	test("dispose removes the pre-step listener (no brackets after unmount)", async () => {
		await handle!.dispose();
		handle = undefined;
		const session = host.sessions.get("l-force")!;
		const startsBefore = session.eventsOf("mc/manage-start").length;
		expect(await host.firePreStep(stepFor("l-force"))).toBe("enter");
		expect(session.eventsOf("mc/manage-start").length).toBe(startsBefore);
	});

	// Last: closeDatabase is process-wide, this store is unusable afterwards.
	test("store loss mid-session fails closed: refuse, never an unmanaged proceed", async () => {
		host = new TestDshHost();
		handle = us1Mount(host, db);
		seedSession(host, "l-broken", 8);
		clearPressure(host, "l-broken");
		expect(await host.firePreStep(stepFor("l-broken"))).toBe("enter"); // healthy pass (attach + tags)
		await closeDatabase();
		host.llmResponder = () => ({ fail: true });
		setPressure(host, "l-broken", 9_600); // at the wall, store gone ⇒ refuse + notice
		expect(await host.firePreStep(stepFor("l-broken"))).toBe("reject");
		expect(refusalOf("l-broken")).toHaveLength(1);
		clearPressure(host, "l-broken"); // below-force lane still refuses: no store, no unmanaged enter
		expect(await host.firePreStep(stepFor("l-broken"))).toBe("reject");
	});
});
