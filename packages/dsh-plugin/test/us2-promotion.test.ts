/**
 * T051 — the historian's side channels (FR-006/FR-007), driven through a real
 * fold at the force band with a protocol-shaped responder:
 *
 *  - `<facts>` promote through the core's durable promotion path into
 *    project memory (same gates as the core runner: memory enabled,
 *    auto_promote, summarizer write authority);
 *  - `<user_observations>` land as user-memory CANDIDATES (dreamer-review
 *    queue), never as active memories;
 *  - `<compartment>` rows publish tiered (p1..p4) through core storage;
 *  - with auto_promote off, the fold still publishes history but no fact
 *    becomes project memory.
 *
 * Mural coverage lives in us2-mural.test.ts (same task line).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { getCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import { TestDshHost } from "./double.js";
import { seedSession, setPressure, stepFor } from "./us1-support.js";

let db: ContextDatabase;
let projectDir: string;
let identity: string;
const handles: AdapterHandle[] = [];

const PAYLOAD = `<output><compartments>
<compartment start="5" end="6" title="Rotation epoch" episode_type="ops" importance="55">
<p1>Rotated the vault keys and verified access.</p1><p2>Keys rotated.</p2><p3>rot.</p3><p4>r.</p4>
</compartment>
</compartments>
<facts>
<PROJECT_RULES>
* Vault keys are rotated weekly.
</PROJECT_RULES>
</facts>
<user_observations>
* User asks for tables before prose.
</user_observations>
<primer_candidates>
<primer at_compartment="1">Vault module: weekly key rotation.</primer>
</primer_candidates>
</output>`;

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-promo-proj-"));
	identity = resolveProjectIdentityForSession(projectDir)!;
});

afterAll(async () => {
	for (const handle of handles) await handle.dispose();
	handles.length = 0;
	await closeDatabase();
});

describe("historian side channels (T051)", () => {
	test("a fold promotes facts, files observations as candidates, publishes tiers", async () => {
		const host = new TestDshHost();
		host.llmResponder = () => ({ text: PAYLOAD });
		const config = MagicContextConfigSchema.parse({});
		seedSession(host, "s-promote", 8);
		const handle = mountAdapter(host, config, db, {
			readSessionLog: (sessionId) =>
				host.sessions.get(sessionId)?.logRecords() ?? [],
			projectDir,
			historianRoute: { provider: "aux", model: "hist-1" },
		});
		handles.push(handle);
		setPressure(host, "s-promote", 8_700); // 87%: force band ⇒ fold first

		// The fold runs first and produces the baseline itself.
		expect(await host.firePreStep(stepFor("s-promote"))).toBe("enter");

		// Compartments published tiered through core storage.
		const compartments = getCompartments(db, "s-promote");
		expect(compartments.length).toBe(1);
		expect(compartments[0]!.title).toBe("Rotation epoch");

		// Fact promoted into PROJECT memory (durable promotion path).
		const promoted = db
			.prepare(
				"SELECT content FROM memories WHERE project_path = ? AND content LIKE '%rotated weekly%'",
			)
			.get(identity) as { content: string } | undefined;
		expect(promoted).toBeDefined();

		// Observation queued as a CANDIDATE, not an active user memory.
		const candidate = db
			.prepare(
				"SELECT content FROM user_memory_candidates WHERE content LIKE '%tables before prose%'",
			)
			.get() as { content: string } | undefined;
		expect(candidate).toBeDefined();
		const activeUser = db
			.prepare(
				"SELECT content FROM user_memories WHERE content LIKE '%tables before prose%'",
			)
			.get();
		expect(activeUser).toBeNull();

		// Primer candidate stored.
		const primer = db
			.prepare("SELECT * FROM primer_candidates LIMIT 1")
			.get() as unknown;
		expect(primer).toBeDefined();

		// The fold re-baselined the head: a fresh pair exists over the fold.
		expect(handle.head.peek("s-promote")).toBeDefined();

		await handle.dispose();
		handles.pop();
	});

	test("auto_promote off: history publishes, facts stay out of memory", async () => {
		const host = new TestDshHost();
		host.llmResponder = () => ({ text: PAYLOAD });
		const config = MagicContextConfigSchema.parse({
			memory: { auto_promote: false },
		});
		const gatePayload = PAYLOAD.replace(
			"Vault keys are rotated weekly.",
			"Access reviews close the loop monthly.",
		);
		host.llmResponder = () => ({ text: gatePayload });
		seedSession(host, "s-promote-gate", 8);
		const handle = mountAdapter(host, config, db, {
			readSessionLog: (sessionId) =>
				host.sessions.get(sessionId)?.logRecords() ?? [],
			projectDir,
			historianRoute: { provider: "aux", model: "hist-1" },
		});
		handles.push(handle);
		setPressure(host, "s-promote-gate", 8_700);
		expect(await host.firePreStep(stepFor("s-promote-gate"))).toBe("enter");

		expect(getCompartments(db, "s-promote-gate").length).toBe(1);
		const promoted = db
			.prepare(
				"SELECT content FROM memories WHERE project_path = ? AND content LIKE '%close the loop%'",
			)
			.get(identity);
		expect(promoted).toBeNull();

		await handle.dispose();
		handles.pop();
	});
});
