/**
 * V3 live gate (T052): head knowledge parity on a real child session.
 *
 * A project with ARCHITECTURE.md, an active user profile, seeded project
 * memories and aged compartments drives a real `dsh` headless turn. Evidence:
 *  - the served baseline carries docs, profile, tiered history and memory
 *    blocks — and the knowledge payload is byte-identical to what the core
 *    renderer produces for ANY harness from the same store (cross-harness
 *    reference below: the DSH adapter contributes no knowledge of its own);
 *  - a background memory write between turns shows up in the volatile delta
 *    while the baseline bytes do not move (FR-017).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { insertUserMemory } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { materializeM0 } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { setHarness } from "@magic-context/core/shared/harness";
import { createLiveHome, type LiveHome } from "./live-home.js";
import {
	MOCK_API_KEY_ENV,
	mockProviderEnv,
	startMockProvider,
} from "./mock-provider.js";

const provider = startMockProvider();
let home: LiveHome | undefined;
let db: ContextDatabase;
let projectDir: string;
let evidenceDir: string;
let sessionId = "";
const DAY = 86_400_000;

function contentText(message: Record<string, unknown>): string {
	const content = message["content"];
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) =>
				typeof part === "object" && part !== null && "text" in part
					? String((part as { text?: string }).text ?? "")
					: "",
			)
			.join("\n");
	return "";
}

function servedHead(): { baseline: string; delta: string } {
	let baseline = "";
	let delta = "";
	for (const request of provider.requests) {
		const messages = (request.body["messages"] ?? []) as Record<
			string,
			unknown
		>[];
		for (const message of messages) {
			const text = contentText(message);
			if (
				text.includes("## Magic Context") &&
				text.includes("<project-memory>")
			)
				baseline = text;
			if (text.includes("<session-history-since>")) delta = text;
		}
	}
	return { baseline, delta };
}

function meta(): { hash: string[]; cachedM0: Buffer | null } {
	const state = getOrCreateSessionMeta(db, sessionId);
	return {
		hash: (state.systemPromptHash ?? "").split("|"),
		cachedM0: (state.cachedM0Bytes as Buffer | null) ?? null,
	};
}

beforeAll(async () => {
	// Parent-side core writes must carry the harness the CHILD reads under.
	setHarness("dsh");
	evidenceDir = `${import.meta.dir}/../tmp/gate-evidence/v3-head`;
	mkdirSync(evidenceDir, { recursive: true });
	const homeRoot = `${import.meta.dir}/../tmp/live-v3`;
	// Under `bun test` the core pins storage to a throwaway dir (test
	// isolation). The isolation branch honours XDG_DATA_HOME when it differs
	// from the pin, so aim the PARENT's core store at the child's home too:
	// parent-side seeding then lands in the child's real store.
	process.env.XDG_DATA_HOME = join(homeRoot, "home", "data");
	home = createLiveHome({
		root: homeRoot,
		route: {
			provider: "mock",
			baseURL: provider.baseURL,
			apiKeyEnv: MOCK_API_KEY_ENV,
			models: [{ id: "mock-model", contextWindow: 20_000 }],
		},
		defaultModel: "mock-model",
	});
	db = (await openDatabaseAsync({
		dbPath: join(home.home, "data", "cortexkit", "magic-context", "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-v3-proj-"));
	writeFileSync(
		join(projectDir, "ARCHITECTURE.md"),
		"The system has a vault module and a nightly build script.\n",
	);
	const identity = resolveProjectIdentityForSession(projectDir)!;
	insertMemory(db, {
		projectPath: identity,
		category: "PROJECT_RULES",
		content: "Vault access is audited.",
	});
	insertUserMemory(db, "User prefers examples over explanations.", []);
	await closeDatabase();
});

/** Aged session history, seeded once the child's session id is known. */
function seedAgedCompartments(): void {
	appendCompartments(db, sessionId, [
		{
			sequence: 1,
			startMessage: 1,
			endMessage: 2,
			startMessageId: "seed-old-a",
			endMessageId: "seed-old-b",
			title: "Ancient scaffolding epoch",
			content: "Scaffolded the repository layout.",
			p1: "Scaffolded the repository layout.",
			p2: "Scaffolded the layout.",
			p3: "Scaffolding.",
			p4: "repo.",
			importance: 30,
			episodeType: "infra",
		},
		{
			sequence: 2,
			startMessage: 3,
			endMessage: 4,
			startMessageId: "seed-old-c",
			endMessageId: "seed-old-d",
			title: "Vault bootstrap epoch",
			content: "Bootstrapped the vault module keys.",
			p1: "Bootstrapped the vault module keys.",
			p2: "Bootstrapped vault keys.",
			p3: "Vault bootstrap.",
			p4: "vault.",
			importance: 60,
			episodeType: "feature",
		},
	]);
	// Aged: the compartments are a year old, so decay has real work to do.
	db.exec(
		`UPDATE compartments SET created_at = created_at - ${String(365 * DAY)}`,
	);
}

afterAll(async () => {
	home?.dispose();
	provider.stop();
	await closeDatabase();
});

describe("V3 live", () => {
	test("the served head carries every knowledge block and survives a background write", async () => {
		// A fresh session defers managed writes to step 2 (the first step's
		// pre-step fires before any surface node exists), so the first turn
		// must carry a tool call: the second step is where the pair lands.
		provider.script([
			{
				toolCalls: [
					{
						name: "read",
						arguments: JSON.stringify({
							path: join(projectDir, "ARCHITECTURE.md"),
						}),
					},
				],
				promptTokens: 600,
			},
			{ text: "noted", promptTokens: 600 },
			{
				toolCalls: [
					{
						name: "read",
						arguments: JSON.stringify({
							path: join(projectDir, "ARCHITECTURE.md"),
						}),
					},
				],
				promptTokens: 600,
			},
			{ text: "noted again", promptTokens: 600 },
		]);
		const first = await home!.runHeadlessAsync("remember the vault rule", {
			cwd: projectDir,
			env: mockProviderEnv(),
		});
		expect(first.status, `child failed: ${first.stderr.slice(0, 1_200)}`).toBe(
			0,
		);
		expect(first.stderr).not.toContain("TEST BACKSTOP");
		writeFileSync(join(evidenceDir, "stderr-run1.txt"), first.stderr);
		sessionId = String(
			first.events.find((event) => event["type"] === "session")?.["sessionId"],
		);
		expect(sessionId).not.toBe("undefined");
		// Session-keyed history can only be seeded once the id exists.
		db = (await openDatabaseAsync({
			dbPath: join(
				home!.home,
				"data",
				"cortexkit",
				"magic-context",
				"context.db",
			),
			nativeTurnDeadlines: true,
		}))!;
		const head1 = servedHead();
		const meta1 = meta();
		writeFileSync(join(evidenceDir, "baseline-run1.txt"), head1.baseline);
		writeFileSync(join(evidenceDir, "delta-run1.txt"), head1.delta);
		expect(
			head1.baseline,
			`stderr=${first.stderr.slice(0, 600)}\nmeta=${JSON.stringify(meta()).slice(0, 300)}`,
		).not.toBe("");
		// Every knowledge block, from the shared renderer:
		expect(head1.baseline).toContain("<project-docs>");
		expect(head1.baseline).toContain("vault module");
		expect(head1.baseline).toContain("<user-profile>");
		expect(head1.baseline).toContain("<project-memory>");
		expect(head1.baseline).toContain("Vault access is audited.");
		expect(meta1.hash.length).toBe(3); // baseline | delta | identity
		expect(meta1.cachedM0).not.toBeNull();

		// Cross-harness reference: the SAME core renderer, driven straight
		// from this store, yields a knowledge payload the served baseline
		// contains byte-for-byte — the adapter adds guidance, never knowledge.
		const reference = materializeM0({
			db,
			sessionId,
			state: getOrCreateSessionMeta(db, sessionId),
			projectPath: resolveProjectIdentityForSession(projectDir),
			projectDirectory: projectDir,
			injectDocs: true,
			memoryEnabled: true,
		});
		writeFileSync(join(evidenceDir, "reference-m0.txt"), reference.m0Text);
		expect(head1.baseline.includes(reference.m0Text)).toBe(true);

		// The parent must not hold the store while the child runs.
		await closeDatabase();

		// Background writes between the TURNS of the second run: the child
		// starts (restart rediscovery freezes the pre-seed cursors), then the
		// parent seeds mid-run — the step-2 pass must surface the writes in
		// the volatile delta while the baseline bytes hold still.
		// Give the second run its own held-open turn: the tool reply's
		// delay keeps the child inside turn 1 while the parent seeds, so
		// the step-2 rebuild deterministically sees the mid-run writes.
		provider.script([
			{
				toolCalls: [
					{
						name: "read",
						arguments: JSON.stringify({
							path: join(projectDir, "ARCHITECTURE.md"),
						}),
					},
				],
				promptTokens: 600,
				delayMs: 3_000,
			},
			{ text: "noted", promptTokens: 600 },
		]);
		const seen = provider.requests.length;
		const secondPromise = home!.runHeadlessAsync("continue", {
			cwd: projectDir,
			args: ["--session-id", sessionId],
			env: mockProviderEnv(),
		});
		while (provider.requests.length === seen) await Bun.sleep(25);
		db = (await openDatabaseAsync({
			dbPath: join(
				home!.home,
				"data",
				"cortexkit",
				"magic-context",
				"context.db",
			),
			nativeTurnDeadlines: true,
		}))!;
		seedAgedCompartments();
		insertMemory(db, {
			projectPath: resolveProjectIdentityForSession(projectDir)!,
			category: "PROJECT_RULES",
			content: "Nightly build runs from scripts/nightly.sh.",
		});
		await closeDatabase();
		const second = await secondPromise;
		expect(
			second.status,
			`child failed: ${second.stderr.slice(0, 1_200)}`,
		).toBe(0);

		db = (await openDatabaseAsync({
			dbPath: join(
				home!.home,
				"data",
				"cortexkit",
				"magic-context",
				"context.db",
			),
			nativeTurnDeadlines: true,
		}))!;
		writeFileSync(join(evidenceDir, "stderr-run2.txt"), second.stderr);
		const head2 = servedHead();
		const meta2 = meta();
		writeFileSync(join(evidenceDir, "baseline-run2.txt"), head2.baseline);
		writeFileSync(join(evidenceDir, "delta-run2.txt"), head2.delta);
		expect(head2.baseline).toBe(head1.baseline);
		expect(meta2.cachedM0?.equals(meta1.cachedM0!)).toBe(true);
		expect(meta2.hash[0]).toBe(meta1.hash[0]);
		expect(meta2.hash[2]).toBe(meta1.hash[2]);
		// …the background writes surface in the volatile delta before any
		// fold: the aged compartments and the new memory both appear…
		expect(head2.delta).toContain("scripts/nightly.sh");
		expect(head2.delta).toContain("Ancient scaffolding epoch");
		expect(head2.delta).toContain("Vault bootstrap epoch");
		// …and the first delta was the empty placeholder…
		expect(head1.delta).toContain("no new content");
		expect(head2.delta).not.toBe(head1.delta);
		// …and only the delta segment of the fingerprint moved.
		expect(meta2.hash[1]).not.toBe(meta1.hash[1]);

		writeFileSync(join(evidenceDir, "baseline-run1.txt"), head1.baseline);
		writeFileSync(join(evidenceDir, "delta-run1.txt"), head1.delta);
		writeFileSync(join(evidenceDir, "baseline-run2.txt"), head2.baseline);
		writeFileSync(join(evidenceDir, "delta-run2.txt"), head2.delta);
		writeFileSync(join(evidenceDir, "reference-m0.txt"), reference.m0Text);
		writeFileSync(
			join(evidenceDir, "session-meta.json"),
			JSON.stringify(
				{
					sessionId,
					run1: {
						hash: meta1.hash,
						cachedM0Bytes: meta1.cachedM0?.length ?? 0,
					},
					run2: {
						hash: meta2.hash,
						cachedM0Bytes: meta2.cachedM0?.length ?? 0,
					},
					baselineIdentical: head1.baseline === head2.baseline,
				},
				null,
				2,
			),
		);
	}, 300_000);
});
