/**
 * V9 budget gate (T091): the cache/perf budget on a scripted session.
 *
 * Half 1 — NO EXTRA REBUILDS. A live session runs turn 1, is resumed twice
 * with `--session-id` (turns 2–3). Between the turns the parent opens the
 * child's store and snapshots the `session_meta.cached_m0_*` cursors plus the
 * frozen baseline bytes. A baseline REBUILD re-renders m[0] and rewrites the
 * whole cursor set in one write, stamping `cached_m0_materialized_at =
 * Date.now()` (core inject-compartments; the same mutation the T043/T044
 * tests observe when a compartment/memory write legitimately re-baselines).
 * With no knowledge writes between turns, an unchanged materialized stamp,
 * unchanged cursor set and byte-identical cached bytes across resumes is
 * proof the baseline was NOT re-materialized — the only legitimate rebuild
 * is the first materialization inside run 1. On the served side the same
 * claim reads: exactly one baseline node, byte-identical across every
 * request of every run, and the head slot resumed turns carry is the
 * placeholder or a delta — never a re-sent baseline. Turn 2 additionally
 * carries a FORCED managed pass: the parent queues a drop (the ctx_reduce
 * pending-op queue) on the run-1 tool result, so the resumed child must run
 * a real management pass — apply the drop, serve the `[dropped §`
 * placeholder — and the frozen baseline still survives it untouched.
 *
 * Half 2 — THE TICK DOES NOT BLOCK A TURN. Two honest, deterministic
 * measurements plus one live overlap:
 *  (a) in-process management pass: `mountAdapter` on the host double over a
 *      realistic history (48 seeded messages with real text entropy, 4
 *      pre-baseline compartments, project memories) — the same pre-step pass
 *      the live child runs, timed directly. BOUND: the median of the five
 *      timed passes (cold, three steady, one delta-refresh) under 200 ms,
 *      and every steady/refresh pass individually under 200 ms (measured
 *      ≈130 ms, dominated by the per-pass projection + history index over
 *      the seeded history; the bound leaves headroom for CI jitter).
 *  (b) the maintenance clock's tick with no due work on the seeded store
 *      (the same MaintenanceScheduler.runTick the dreamer lane mounts).
 *      BOUND: under 200 ms per tick.
 *  (c) live: the dreamer lane (dreamer.pi → mock route) runs a dream task
 *      WHILE a turn is held open (delayMs); the dream is observed in-flight
 *      mid-turn and the full turn wall clock must stay under a generous
 *      90 s bound — a turn with the lane mounted behaves like a turn without.
 *
 * Half 3 — FAIL-CLOSED ON A STORE OUTAGE (quickstart V9 scenario, the
 * mid-session sibling of us1-fail-closed): with the session open, the shared
 * store becomes unusable (a schema_migrations row newer than this binary
 * makes the open return null — the state the fail_closed_blocking arm
 * covers). The next turn must be REFUSED: zero provider requests, the
 * refusal logged, no normal completion; after the store recovers the session
 * resumes cleanly and the case-1 frozen baseline is still intact.
 *
 * Evidence is written DURING the tests to the sidecar directory
 * (specs/002-dsh-full-parity/gate-evidence/v9-cache/): the live home wipes
 * on dispose, so nothing may be sampled afterwards.
 */

import { Database as RawSqlite } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getTaskScheduleState,
	seedTaskScheduleState,
	writeTaskScheduleState,
} from "@magic-context/core/features/magic-context/dreamer/storage-task-schedule";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import { MaintenanceScheduler } from "../src/maintenance/scheduler.js";
import { TestDshHost } from "./double.js";
import { createLiveHome, type LiveHome } from "./live-home.js";
import {
	MOCK_API_KEY_ENV,
	mockProviderEnv,
	startMockProvider,
} from "./mock-provider.js";
import { seedSession, setPressure, stepFor } from "./us1-support.js";

const provider = startMockProvider();
let home: LiveHome | undefined;
let storePath = "";
let db: ContextDatabase;
let projA = "";
let projB = "";
let identityB = "";
let memoryId = 0;
let sessionId = "";
const handles: AdapterHandle[] = [];
const DAY = 86_400_000;
/** Case-1's final frozen snapshot, re-checked after the outage case. */
let frozenMeta: MetaSnapshot | undefined;

/** Sidecar evidence dir (outside the repo tree; survives the live-home wipe). */
const evidenceDir = resolve(
	import.meta.dir,
	"..",
	"..",
	"..",
	"..",
	"specs",
	"002-dsh-full-parity",
	"gate-evidence",
	"v9-cache",
);

const evidence: Record<string, unknown> = {
	task: "T091",
	gate: "v9-cache",
	generatedAt: new Date().toISOString(),
	bunVersion: Bun.version,
	platform: `${process.platform}-${process.arch}`,
};

function writeEvidence(): void {
	writeFileSync(
		join(evidenceDir, "v9-evidence.json"),
		`${JSON.stringify(evidence, null, 2)}\n`,
	);
}

async function openStore(): Promise<ContextDatabase> {
	db = (await openDatabaseAsync({
		dbPath: storePath,
		nativeTurnDeadlines: true,
	}))!;
	return db;
}

/** One `session_meta.cached_m0_*` snapshot: frozen bytes + every cursor. */
interface MetaSnapshot {
	readonly cachedM0Bytes: number;
	readonly cachedM0Sha256: string | null;
	readonly cursors: Record<string, unknown>;
	readonly tokens: Record<string, number>;
	readonly systemPromptHash: string | null;
}

function snapshotMeta(atSessionId: string): MetaSnapshot {
	const state = getOrCreateSessionMeta(db, atSessionId);
	const bytes = (state.cachedM0Bytes as Buffer | null) ?? null;
	return {
		cachedM0Bytes: bytes?.length ?? 0,
		cachedM0Sha256: bytes
			? new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
			: null,
		cursors: {
			projectMemoryEpoch: state.cachedM0ProjectMemoryEpoch,
			workspaceFingerprint: state.cachedM0WorkspaceFingerprint,
			projectUserProfileVersion: state.cachedM0ProjectUserProfileVersion,
			maxCompartmentSeq: state.cachedM0MaxCompartmentSeq,
			maxMemoryId: state.cachedM0MaxMemoryId,
			maxMutationId: state.cachedM0MaxMutationId,
			maxMemoryMutationId: state.cachedM0MaxMemoryMutationId,
			projectDocsHash: state.cachedM0ProjectDocsHash,
			materializedAt: state.cachedM0MaterializedAt,
			sessionFactsVersion: state.cachedM0SessionFactsVersion,
			upgradeState: state.cachedM0UpgradeState,
			systemHash: state.cachedM0SystemHash,
			toolSetHash: state.cachedM0ToolSetHash,
			modelKey: state.cachedM0ModelKey,
			projectIdentity: state.cachedM0ProjectIdentity,
			muralHash: state.cachedM0MuralHash,
		},
		tokens: {
			systemPromptTokens: state.systemPromptTokens,
			conversationTokens: state.conversationTokens,
			toolCallTokens: state.toolCallTokens,
			lastInputTokens: state.lastInputTokens,
		},
		systemPromptHash: (state.systemPromptHash as string | null) ?? null,
	};
}

/**
 * True when a request from `from` carries the canonical drop notice: a
 * message whose content BEGINS with the `[dropped §` placeholder (the
 * baseline's guidance prose mentions the marker mid-text, so only a
 * message that starts with it is the rewritten node). DSH tags history
 * nodes as message tags, so a managed drop lands as the canonical
 * user-role reduction notice (the tool-message rewrite live-v1 asserts is
 * the tool-tag lane).
 */
function servedDropNotice(from: number): boolean {
	return provider.requests
		.slice(from)
		.some((request) =>
			((request.body["messages"] ?? []) as { content?: unknown }[]).some(
				(message) =>
					typeof message.content === "string" &&
					message.content.startsWith("[dropped §"),
			),
		);
}

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

function isBaselineText(text: string): boolean {
	return text.includes("## Magic Context") && text.includes("<project-memory>");
}

interface ServedHeads {
	readonly baseline: string;
	readonly delta: string;
	readonly baselineCopies: number;
	readonly deltaCopies: number;
}

/** The head pair the newest request from `from` on carries. */
function headsFromLatestRequest(from: number): ServedHeads {
	for (let i = provider.requests.length - 1; i >= from; i -= 1) {
		const request = provider.requests[i]!;
		if (!request.path.includes("chat/completions")) continue;
		const messages = (request.body["messages"] ?? []) as Record<
			string,
			unknown
		>[];
		let baselineCopies = 0;
		let deltaCopies = 0;
		let baseline = "";
		let delta = "";
		for (const message of messages) {
			const text = contentText(message);
			if (isBaselineText(text)) {
				baselineCopies += 1;
				baseline = text;
				continue;
			}
			// The baseline's temporal-awareness guidance names the delta tag
			// in prose; only a non-baseline message carrying the tag IS the
			// delta node.
			if (text.includes("<session-history-since>")) {
				deltaCopies += 1;
				delta = text;
			}
		}
		if (baselineCopies > 0)
			return { baseline, delta, baselineCopies, deltaCopies };
	}
	return { baseline: "", delta: "", baselineCopies: 0, deltaCopies: 0 };
}

/** Distinct served baselines across every recorded request (sha256 per copy). */
function distinctServedBaselines(): string[] {
	const seen = new Set<string>();
	for (const request of provider.requests) {
		const messages = (request.body["messages"] ?? []) as Record<
			string,
			unknown
		>[];
		for (const message of messages) {
			const text = contentText(message);
			if (isBaselineText(text))
				seen.add(
					new Bun.CryptoHasher("sha256")
						.update(text)
						.digest("hex")
						.slice(0, 16),
				);
		}
	}
	return [...seen];
}

beforeAll(async () => {
	// Parent-side core writes must carry the harness the CHILD reads under.
	setHarness("dsh");
	mkdirSync(evidenceDir, { recursive: true });
	const homeRoot = `${import.meta.dir}/../tmp/live-v9`;
	// The isolation branch honours XDG_DATA_HOME when it differs from the
	// preload pin, so the parent's store opens land in the child's home
	// (same trick as live-v3/live-v5).
	process.env.XDG_DATA_HOME = join(homeRoot, "home", "data");
	home = createLiveHome({
		root: homeRoot,
		route: {
			provider: "mock",
			baseURL: provider.baseURL,
			apiKeyEnv: MOCK_API_KEY_ENV,
			models: [
				{ id: "mock-model", contextWindow: 20_000 },
				{ id: "mock-dream", contextWindow: 20_000 },
			],
		},
		defaultModel: "mock-model",
	});
	storePath = join(
		home.home,
		"data",
		"cortexkit",
		"magic-context",
		"context.db",
	);

	// Project A: the cache-budget session. No dreamer block ⇒ no background
	// writer, so any baseline change between turns would be an extra rebuild.
	projA = mkdtempSync(join(tmpdir(), "mc-v9-projA-"));
	writeFileSync(join(projA, "file.txt"), "cache budget project\n");

	// Project B: the maintenance-lane project (dreamer.pi → the mock route).
	projB = mkdtempSync(join(tmpdir(), "mc-v9-projB-"));
	writeFileSync(join(projB, "file.txt"), "maintenance project\n");
	mkdirSync(join(projB, ".cortexkit"), { recursive: true });
	writeFileSync(
		join(projB, ".cortexkit", "magic-context.jsonc"),
		JSON.stringify({
			dreamer: {
				pi: { model: "mock/mock-dream" },
				tasks: { "classify-memories": { schedule: "* * * * *" } },
			},
		}),
	);
	identityB = resolveProjectIdentityForSession(projB)!;
	const store = await openStore();
	// The baseline only materializes when it has something to say: give
	// project A one static project memory (no writer touches it between
	// turns, so any cursor movement across resumes can only be a rebuild).
	insertMemory(store, {
		projectPath: resolveProjectIdentityForSession(projA)!,
		category: "PROJECT_RULES",
		content: "The budget gate keeps the frozen baseline frozen.",
	});
	const first = insertMemory(store, {
		projectPath: identityB,
		category: "PROJECT_RULES",
		content:
			"The nightly build script must run with the archive flag, or vault exports are silently truncated.",
	});
	memoryId = Number(first.id);
	// classify-memories needs a pool of at least ten to score meaningfully.
	for (let i = 0; i < 11; i += 1)
		insertMemory(store, {
			projectPath: identityB,
			category: "PROJECT_RULES",
			content: `Project fact ${String(i)}: the archive layout numbers shard ${String(i)} and binds it to the nightly export ledger under a rotating retention window.`,
		});
	await closeDatabase();
}, 90_000);

afterAll(async () => {
	for (const handle of handles) await handle.dispose();
	// Evidence JSON was written DURING the tests (the live home wipes on
	// dispose); the sidecar README.md is authored prose, not generated.
	home?.dispose();
	provider.stop();
	await closeDatabase();
});

describe("V9 budget", () => {
	test("resumed turns do not re-materialize the m[0] baseline", async () => {
		// Turn 1: a real tool call + answer (the first materialization lives
		// here). Pressure stays in the low band — no reclaim, no fold, so no
		// knowledge cursor may move.
		provider.script([
			{
				toolCalls: [
					{
						name: "read",
						arguments: JSON.stringify({ path: join(projA, "file.txt") }),
					},
				],
				promptTokens: 600,
			},
			{ text: "noted", promptTokens: 600 },
		]);
		const turn1Start = provider.requests.length;
		const t1 = performance.now();
		const first = await home!.runHeadlessAsync("read file.txt and note it", {
			cwd: projA,
			env: mockProviderEnv(),
		});
		const turn1WallMs = performance.now() - t1;
		expect(first.status, `child failed: ${first.stderr.slice(0, 1_200)}`).toBe(
			0,
		);
		expect(first.stderr).not.toContain("TEST BACKSTOP");
		expect(first.stderr).not.toContain("storage unavailable");
		sessionId = String(
			first.events.find((event) => event["type"] === "session")?.["sessionId"],
		);
		expect(sessionId).not.toBe("undefined");

		await openStore();
		const meta1 = snapshotMeta(sessionId);
		const heads1 = headsFromLatestRequest(turn1Start);
		await closeDatabase();
		// The legitimate (and only) rebuild: the first materialization.
		expect(
			meta1.cachedM0Sha256,
			"turn 1 materialized the baseline",
		).not.toBeNull();
		expect(meta1.cursors.materializedAt).not.toBeNull();
		expect(heads1.baseline).toContain("<project-memory>");

		// Force the MANAGED pass on the resumed turn: the parent stamps a
		// drop on the run-1 tool result through the same pending-op queue an
		// agent's ctx_reduce uses. The resumed child's management pass must
		// apply it (a real managed change mid-resume, history rewritten with
		// the canonical placeholder) — and the frozen baseline must still
		// survive it untouched.
		await openStore();
		const activeTags = db
			.prepare(
				"SELECT tag_number, message_id, type FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number ASC",
			)
			.all(sessionId) as {
			tag_number: number;
			message_id: string;
			type: string;
		}[];
		const dropTarget =
			activeTags.find((tag) => tag.type === "tool") ?? activeTags[0];
		expect(
			dropTarget,
			`run 1 tagged the tool result (tags: ${JSON.stringify(activeTags)})`,
		).toBeDefined();
		queuePendingOp(db, sessionId, dropTarget!.tag_number, "drop");
		await closeDatabase();
		expect(servedDropNotice(0)).toBe(false);

		// Turn 2: resume with a tool call (two steps ⇒ the pass runs with the
		// host head present) + the queued drop. No knowledge writes between
		// the turns, so any cursor movement can only be a rebuild.
		const turn2Start = provider.requests.length;
		provider.script([
			{
				toolCalls: [
					{
						name: "read",
						arguments: JSON.stringify({ path: join(projA, "file.txt") }),
					},
				],
				promptTokens: 600,
			},
			{ text: "second answer", promptTokens: 600 },
		]);
		const second = await home!.runHeadlessAsync(
			"read file.txt again and continue",
			{
				cwd: projA,
				args: ["--session-id", sessionId],
				env: mockProviderEnv(),
			},
		);
		expect(
			second.status,
			`child failed: ${second.stderr.slice(0, 1_200)}`,
		).toBe(0);
		// The managed pass ran on the resumed turn: the dropped history node
		// reaches the model as the canonical reduction notice (the managed
		// change actually applied, same canonical marker as the V1 live gate).
		await openStore();
		const meta2 = snapshotMeta(sessionId);
		const heads2 = headsFromLatestRequest(turn2Start);
		const tagRows = db
			.prepare(
				"SELECT tag_number AS tag, type, status FROM tags WHERE session_id = ? ORDER BY tag_number ASC",
			)
			.all(sessionId) as { tag: number; type: string; status: string }[];
		const opsRows = db.prepare("SELECT * FROM pending_ops").all() as unknown[];
		await closeDatabase();
		expect(
			servedDropNotice(turn2Start),
			`drop must be applied and served; tags=${JSON.stringify(
				tagRows,
			)} pending_ops=${JSON.stringify(opsRows)}`,
		).toBe(true);
		// Store side of the same fact: the queued op was consumed.
		expect(tagRows.some((row) => row.status === "dropped")).toBe(true);
		expect(opsRows).toHaveLength(0);

		// Turn 3: resume once more — the cache must still be cold-stable.
		const turn3Start = provider.requests.length;
		provider.script([{ text: "third answer", promptTokens: 600 }]);
		const third = await home!.runHeadlessAsync("and again", {
			cwd: projA,
			args: ["--session-id", sessionId],
			env: mockProviderEnv(),
		});
		expect(third.status, `child failed: ${third.stderr.slice(0, 1_200)}`).toBe(
			0,
		);
		await openStore();
		const meta3 = snapshotMeta(sessionId);
		const heads3 = headsFromLatestRequest(turn3Start);
		await closeDatabase();

		// --- store side: the baseline did not rebuild across resumes. ---
		expect(meta2.cachedM0Bytes).toBe(meta1.cachedM0Bytes);
		expect(meta3.cachedM0Bytes).toBe(meta1.cachedM0Bytes);
		expect(meta2.cachedM0Sha256).toBe(meta1.cachedM0Sha256);
		expect(meta3.cachedM0Sha256).toBe(meta1.cachedM0Sha256);
		// A rebuild stamps materializedAt = Date.now() in the same write that
		// re-renders m[0]; an unmoved stamp proves no re-materialization ran.
		expect(meta2.cursors.materializedAt).toBe(meta1.cursors.materializedAt);
		expect(meta3.cursors.materializedAt).toBe(meta1.cursors.materializedAt);
		expect(JSON.stringify(meta2.cursors)).toBe(JSON.stringify(meta1.cursors));
		expect(JSON.stringify(meta3.cursors)).toBe(JSON.stringify(meta1.cursors));
		// Fingerprint: baseline + identity segments frozen (the volatile delta
		// segment is free to move — it is not part of the cached baseline).
		const segments = (m: MetaSnapshot) => String(m.systemPromptHash).split("|");
		expect(segments(meta2)[0]).toBe(segments(meta1)[0]);
		expect(segments(meta3)[0]).toBe(segments(meta1)[0]);
		expect(segments(meta2)[2]).toBe(segments(meta1)[2]);
		expect(segments(meta3)[2]).toBe(segments(meta1)[2]);

		// --- served side: one baseline node, never re-sent; the resumed head
		// slot carries the placeholder or a delta, never baseline bytes. ---
		expect(heads2.baseline).toBe(heads1.baseline);
		expect(heads3.baseline).toBe(heads1.baseline);
		expect(heads2.baselineCopies).toBe(1);
		expect(heads3.baselineCopies).toBe(1);
		expect(heads1.delta).toContain("no new content"); // turn 1: empty placeholder
		for (const heads of [heads2, heads3]) {
			expect(heads.deltaCopies).toBe(1);
			expect(heads.delta.includes("<project-memory>")).toBe(false);
			expect(heads.delta.includes("## Magic Context")).toBe(false);
			expect(heads.delta.length).toBeLessThan(heads1.baseline.length);
		}
		// Whole-session view: across every request of every run exactly one
		// distinct baseline was ever served.
		expect(distinctServedBaselines()).toHaveLength(1);
		frozenMeta = meta3;

		evidence.noExtraRebuilds = {
			sessionId,
			projectIdentity: resolveProjectIdentityForSession(projA),
			turn1WallMs: Math.round(turn1WallMs),
			turns: { turn1: meta1, turn2: meta2, turn3: meta3 },
			managedPassAppliedOnResume: true, // queued drop → "[dropped §" asserted above
			served: {
				baselineBytes: heads1.baseline.length,
				baselineSha256: new Bun.CryptoHasher("sha256")
					.update(heads1.baseline)
					.digest("hex"),
				baselineIdenticalAcrossTurns:
					heads2.baseline === heads1.baseline &&
					heads3.baseline === heads1.baseline,
				baselineCopiesPerServedRequest: {
					turn2: heads2.baselineCopies,
					turn3: heads3.baselineCopies,
				},
				turn1DeltaWasPlaceholder: heads1.delta.includes("no new content"),
				resumedDeltaCarriedNoBaseline:
					!heads2.delta.includes("<project-memory>") &&
					!heads3.delta.includes("<project-memory>"),
				distinctServedBaselines: distinctServedBaselines(),
			},
		};
		writeEvidence();
	}, 180_000);

	test("a store outage is refused fail-closed — no unmanaged turn — and the session resumes clean", async () => {
		// Quickstart V9's failure-mode scenario: while a session is open, the
		// shared store becomes unusable. The doctrine (F-06, us1-fail-closed
		// in the double suite) is that Magic Context then goes silent and the
		// host refuses steps rather than serving a turn with a lying context.
		//
		// The lever: a schema_migrations row above this binary's latest
		// version makes openDatabaseAsync return null — the store-unavailable
		// state the fail-closed arm in index.ts covers. The refused step must
		// (a) keep the provider completely uncontacted, (b) log the refusal,
		// (c) leave the cached baseline untouched so the next clean boot
		// resumes with the same frozen state.
		const outageLog = join(evidenceDir, "child-fail-closed.log");
		rmSync(outageLog, { force: true });
		// Raw handle: the core opener itself must not run migrations while
		// arming the fence.
		const raw = new RawSqlite(storePath);
		raw.exec(
			"INSERT OR REPLACE INTO schema_migrations(version, description, applied_at) VALUES (9999, 'v9 fence: pretend a newer lane owns the schema', 0)",
		);
		raw.close();

		const requestsBeforeOutage = provider.requests.length;
		provider.script([{ text: "should never be asked", promptTokens: 600 }]);
		const outage = await home!.runHeadlessAsync("continue during outage", {
			cwd: projA,
			args: ["--session-id", sessionId],
			env: { ...mockProviderEnv(), MAGIC_CONTEXT_LOG_PATH: outageLog },
		});
		const outageRequests = provider.requests.length - requestsBeforeOutage;
		const outageLogText = existsSync(outageLog)
			? readFileSync(outageLog, "utf8")
			: "";
		// Strongest available assertions (mirrors us1-fail-closed): the step
		// is rejected before any provider request, and the run does not
		// complete normally.
		expect(outageRequests, "no provider request during a store outage").toBe(0);
		expect(outageLogText).toContain("fail-closed: steps are refused");
		const completed = outage.events.some(
			(event) =>
				event["type"] === "final" &&
				(event["reason"] as { kind?: string } | undefined)?.kind ===
					"completed",
		);
		expect(completed, "outage turn must not complete normally").toBe(false);

		// --- restore: drop the fence row; the next turn must be clean. ---
		const raw2 = new RawSqlite(storePath);
		raw2.exec("DELETE FROM schema_migrations WHERE version = 9999");
		raw2.close();
		const requestsBeforeRestore = provider.requests.length;
		provider.script([{ text: "after restore", promptTokens: 600 }]);
		const restored = await home!.runHeadlessAsync("continue after restore", {
			cwd: projA,
			args: ["--session-id", sessionId],
			env: mockProviderEnv(),
		});
		expect(
			restored.status,
			`child failed: ${restored.stderr.slice(0, 1_200)}`,
		).toBe(0);
		const restoredCompleted = restored.events.some(
			(event) =>
				event["type"] === "final" &&
				(event["reason"] as { kind?: string } | undefined)?.kind ===
					"completed",
		);
		expect(restoredCompleted).toBe(true);
		expect(provider.requests.length).toBeGreaterThan(requestsBeforeRestore);

		await openStore();
		const metaAfterOutage = snapshotMeta(sessionId);
		await closeDatabase();
		// The outage window changed nothing about the frozen baseline: the
		// case-1 stamps must still be identical after refusal + resumption.
		expect(frozenMeta, "case 1 ran first").toBeDefined();
		const frozen = frozenMeta!;
		expect(metaAfterOutage.cachedM0Sha256).toBe(frozen.cachedM0Sha256);
		expect(JSON.stringify(metaAfterOutage.cursors)).toBe(
			JSON.stringify(frozen.cursors),
		);

		// --- throw-path variant: a corrupt store file makes the core opener
		// THROW; the try/catch around openDatabaseAsync must route that into
		// the same fail-closed arm instead of letting the failure escape as
		// a swallowed plugin-load error (which would run the turn
		// unmanaged). Pre-fix observed behavior: turn completed unmanaged.
		const storeBytes = readFileSync(storePath);
		const garbageLog = join(evidenceDir, "child-garbage-store.log");
		rmSync(garbageLog, { force: true });
		let garbageRequests = -1;
		let garbageRefused = false;
		let garbageCompleted = true;
		try {
			writeFileSync(storePath, "v9: not a database — corrupt store bytes");
			rmSync(`${storePath}-wal`, { force: true });
			rmSync(`${storePath}-shm`, { force: true });
			const garbageRequestsBefore = provider.requests.length;
			provider.script([
				{ text: "must not be asked either", promptTokens: 600 },
			]);
			const garbage = await home!.runHeadlessAsync(
				"continue over a corrupt store",
				{
					cwd: projA,
					args: ["--session-id", sessionId],
					env: { ...mockProviderEnv(), MAGIC_CONTEXT_LOG_PATH: garbageLog },
				},
			);
			garbageRequests = provider.requests.length - garbageRequestsBefore;
			const garbageLogText = existsSync(garbageLog)
				? readFileSync(garbageLog, "utf8")
				: "";
			garbageRefused = garbageLogText.includes(
				"fail-closed: steps are refused",
			);
			garbageCompleted = garbage.events.some(
				(event) =>
					event["type"] === "final" &&
					(event["reason"] as { kind?: string } | undefined)?.kind ===
						"completed",
			);
			expect(garbageRequests, "no provider request over a corrupt store").toBe(
				0,
			);
			expect(garbageRefused, "corrupt store must log the refusal").toBe(true);
			expect(garbageCompleted, "corrupt-store turn must not complete").toBe(
				false,
			);
		} finally {
			writeFileSync(storePath, storeBytes);
		}

		evidence.failClosedRefusal = {
			method:
				"schema_migrations row v9999 (newer-than-binary) → openDatabaseAsync returns null",
			outageRefused: !completed,
			outageProviderRequests: outageRequests,
			unmanagedRequestsDuringOutage: outageRequests,
			refusalLogged: outageLogText.includes("fail-closed: steps are refused"),
			refusalLogPath: "child-fail-closed.log",
			resumedClean: restoredCompleted,
			baselineIntactAfterOutage:
				metaAfterOutage.cachedM0Sha256 === frozen.cachedM0Sha256,
			corruptStoreThrowPath: {
				refused: garbageRefused,
				providerRequests: garbageRequests,
				completed: garbageCompleted,
				logPath: "child-garbage-store.log",
			},
		};
		writeEvidence();
	}, 120_000);

	test("the dreamer lane overlaps an open turn without blocking it", async () => {
		// The maintenance lane is mounted by the child itself (dreamer.pi in
		// the project config → the mock route). The dream is forced due
		// mid-turn; its request must be seen while the turn is still open.
		let turnReplies = 0;
		provider.respond((request) => {
			const body = request as Record<string, unknown>;
			if (body["model"] === "mock-dream") {
				// The manifest must cover the asked pool exactly: echo the
				// real ids back out of the prompt (pool rows are
				// `[id] CATEGORY (current: …)`, JSON-escaped newlines).
				const ids = new Set<string>();
				for (const m of JSON.stringify(body).matchAll(
					/\\n\[(\d+)\] \w+ \(current:/g,
				))
					ids.add(m[1]!);
				const entries = [...ids]
					.map(
						(id) =>
							`<memory id="${id}" importance="70" scope="project" shareable="true"/>`,
					)
					.join("");
				return { text: `<classify>${entries}</classify>` };
			}
			turnReplies += 1;
			if (turnReplies === 1)
				return {
					toolCalls: [
						{
							name: "read",
							arguments: JSON.stringify({ path: join(projB, "file.txt") }),
						},
					],
				};
			// Keep the turn open while the background dream runs alongside it.
			return { text: "noted", delayMs: 6_000 };
		});

		const t0 = Date.now();
		let childDone = false;
		const running = home!
			.runHeadlessAsync("read file.txt and note it", {
				cwd: projB,
				env: {
					...mockProviderEnv(),
					MAGIC_CONTEXT_TEST_NO_QUIET: "1",
					MAGIC_CONTEXT_TEST_TICK_MS: "500",
					MAGIC_CONTEXT_TEST_JITTER_MS: "0",
					MAGIC_CONTEXT_LOG_PATH: join(evidenceDir, "child-tick.log"),
				},
			})
			.then((result) => {
				childDone = true;
				return result;
			});

		// Force classify-memories due while the child is inside its turn.
		await openStore();
		let state = getTaskScheduleState(db, identityB, "classify-memories");
		const seededAt = Date.now();
		while (state === null && Date.now() - seededAt < 20_000) {
			await Bun.sleep(100);
			state = getTaskScheduleState(db, identityB, "classify-memories");
		}
		expect(state, "the dreamer lane seeded the task schedule").not.toBeNull();
		writeTaskScheduleState(db, { ...state!, nextDueAt: Date.now() - 1_000 });
		await closeDatabase();

		const dreamAt = Date.now();
		const dreamRequest = () =>
			provider.requests.find(
				(request) => request.body["model"] === "mock-dream",
			);
		while (dreamRequest() === undefined && Date.now() - dreamAt < 20_000)
			await Bun.sleep(100);
		const sawDream = dreamRequest() !== undefined;
		const dreamOverlappedTurn = sawDream && !childDone;
		const dreamElapsedMs = sawDream ? Date.now() - t0 : -1;

		const result = await running;
		const turnWallMs = Date.now() - t0;
		expect(result.status, `child failed: ${result.stderr.slice(0, 800)}`).toBe(
			0,
		);
		expect(result.stderr).not.toContain("TEST BACKSTOP");
		expect(sawDream, "the dream model was asked").toBe(true);
		expect(
			dreamOverlappedTurn,
			"the dream ran while the turn was still open",
		).toBe(true);

		// The overlap had a real effect: the classification landed.
		await openStore();
		const importance = Number(
			(
				db
					.prepare("SELECT importance FROM memories WHERE id = ?")
					.get(memoryId) as { importance: number } | null
			)?.importance ?? 0,
		);
		const schedule = getTaskScheduleState(db, identityB, "classify-memories");
		await closeDatabase();
		expect(importance).toBe(70);

		// Generous bound: the whole turn (boot + provider + an overlapping
		// dream run) stays far below a minute. With the lane absent the same
		// shape of turn costs the same order (turn 1 above: no lane mounted).
		expect(turnWallMs, `live turn took ${String(turnWallMs)} ms`).toBeLessThan(
			90_000,
		);

		evidence.maintenanceLane = {
			turnWallMs,
			dreamElapsedMs,
			dreamOverlappedTurn,
			boundMs: 90_000,
			scheduleAfterRun: {
				lastStatus: schedule?.lastStatus,
				nextDueAt: schedule?.nextDueAt,
			},
			classifiedMemoryImportance: importance,
		};
		writeEvidence();
	}, 120_000);

	test("the management pass + scheduler tick stay under the 200 ms budget", async () => {
		// Deterministic in-process measurement of the exact work a turn pays
		// for: the pre-step management pass (mountAdapter on the host double,
		// realistic seeded history) and the maintenance clock's tick.
		// BOUND: 200 ms per steady pass / refresh pass / tick. Measured here:
		// steady passes ≈ 130 ms dominated by the per-pass log projection +
		// history index over the 48-message session; the bound leaves ~40%
		// headroom on this machine and is still orders of magnitude below
		// any turn's latency budget.
		await openStore();
		const host = new TestDshHost();
		const handle = mountAdapter(host, MagicContextConfigSchema.parse({}), db, {
			readSessionLog: (id) => host.sessions.get(id)?.logRecords() ?? [],
			historianRoute: { provider: "aux", model: "hist-1" },
			projectDir: projB,
		});
		handles.push(handle);
		const session = seedSession(host, "s-budget", 48);
		// A realistic knowledge state so the first materialization renders
		// real blocks; those compartments are pre-baseline by construction.
		appendCompartments(db, "s-budget", [
			{
				sequence: 1,
				startMessage: 0,
				endMessage: 11,
				startMessageId: "m0",
				endMessageId: "m11",
				title: "Ingest epoch",
				content: "Ingested the archive layout across twelve exchanges.",
				p1: "Ingested the archive layout across twelve exchanges.",
				p2: "Ingested the archive layout.",
				p3: "Ingest epoch.",
				p4: "archive.",
				importance: 40,
				episodeType: "infra",
			},
			{
				sequence: 2,
				startMessage: 12,
				endMessage: 23,
				startMessageId: "m12",
				endMessageId: "m23",
				title: "Vault epoch",
				content: "Wired the vault module and its audit hooks.",
				p1: "Wired the vault module and its audit hooks.",
				p2: "Wired the vault module.",
				p3: "Vault wiring.",
				p4: "vault.",
				importance: 55,
				episodeType: "feature",
			},
			{
				sequence: 3,
				startMessage: 24,
				endMessage: 35,
				startMessageId: "m24",
				endMessageId: "m35",
				title: "Export epoch",
				content: "Bound the nightly export ledger to shard numbers.",
				p1: "Bound the nightly export ledger to shard numbers.",
				p2: "Bound the export ledger.",
				p3: "Export binding.",
				p4: "export.",
				importance: 50,
				episodeType: "feature",
			},
			{
				sequence: 4,
				startMessage: 36,
				endMessage: 45,
				startMessageId: "m36",
				endMessageId: "m45",
				title: "Retention epoch",
				content: "Rolled the retention window policy into config.",
				p1: "Rolled the retention window policy into config.",
				p2: "Rolled retention into config.",
				p3: "Retention policy.",
				p4: "retention.",
				importance: 35,
				episodeType: "infra",
			},
		]);
		db.exec(`UPDATE compartments SET created_at = created_at - ${String(DAY)}`);
		insertMemory(db, {
			projectPath: identityB,
			category: "PROJECT_RULES",
			content: "Budget passes must stay under 200 ms on a long session.",
		});
		// 6% of the window: low band — no reclaim, no fold; the pass does the
		// real bookkeeping (projection, tag sync, history index) and a head
		// refresh, nothing more.
		setPressure(host, "s-budget", 1_200, 20_000);

		const coldStart = performance.now();
		expect(await host.firePreStep(stepFor("s-budget"))).toBe("enter");
		const coldMs = performance.now() - coldStart;
		expect(handle.head.peek("s-budget"), "the head pair exists").toBeDefined();

		// Steady-state passes over identical state: the byte-stable cache must
		// open zero new managed-change brackets and stay inside the budget.
		const startsBefore = session.eventsOf("mc/manage-start").length;
		const steadyMs: number[] = [];
		for (let i = 0; i < 3; i += 1) {
			const t = performance.now();
			expect(await host.firePreStep(stepFor("s-budget"))).toBe("enter");
			steadyMs.push(performance.now() - t);
		}
		expect(session.eventsOf("mc/manage-start").length).toBe(startsBefore);

		// A delta-changing pass: a post-baseline compartment re-renders the
		// DELTA node only (T043 pair semantics) — still inside the budget.
		appendCompartments(db, "s-budget", [
			{
				sequence: 5,
				startMessage: 46,
				endMessage: 47,
				startMessageId: "m46",
				endMessageId: "m47",
				title: "Budget epoch",
				content:
					"Post-baseline compartment lands in the delta, not the baseline.",
				p1: "Post-baseline compartment lands in the delta.",
				p2: "Post-baseline delta entry.",
				p3: "Budget delta.",
				p4: "delta.",
				importance: 45,
				episodeType: "feature",
			},
		]);
		const refreshStart = performance.now();
		expect(await host.firePreStep(stepFor("s-budget"))).toBe("enter");
		const deltaRefreshMs = performance.now() - refreshStart;
		const head = handle.head.peek("s-budget")!;
		expect(head.deltaSeq, "the pair carries a delta node").toBeDefined();

		// The maintenance clock: a tick with no due work on the seeded store
		// (the same runTick the dreamer lane mounts; the lease/scheduler
		// mechanics are covered by maintenance-scheduler.test.ts).
		const scheduler = new MaintenanceScheduler({
			db,
			setInterval: () => () => {},
			bootQuietRemainingMs: () => 0,
			now: () => Date.now(),
			jitterSlotMs: 0,
			onError: () => {},
		});
		scheduler.registerProject({
			projectIdentity: identityB,
			tasks: [
				{
					task: "classify-memories",
					schedule: "* * * * *",
					timeoutMinutes: 10,
				},
			],
			executor: async () => ({ status: "completed" }),
		});
		scheduler.start();
		const scheduleState = getTaskScheduleState(
			db,
			identityB,
			"classify-memories",
		);
		if (scheduleState === null)
			seedTaskScheduleState(
				db,
				identityB,
				"classify-memories",
				Date.now() + 3_600_000,
				null,
				"* * * * *",
			);
		else
			writeTaskScheduleState(db, {
				...scheduleState,
				nextDueAt: Date.now() + 3_600_000,
			});
		expect(await scheduler.runTick()).toBe(0); // arms the project's quiet clock
		const tickMs: number[] = [];
		for (let i = 0; i < 5; i += 1) {
			const t = performance.now();
			expect(await scheduler.runTick()).toBe(0);
			tickMs.push(performance.now() - t);
		}
		scheduler.stop();

		const worstSteady = Math.max(...steadyMs);
		const worstTick = Math.max(...tickMs);
		// The brief's bound: median of N=5 timed management passes (cold
		// first materialization, three steady-state, one delta-refresh)
		// under 200 ms. Deterministic-ish: the corpus is fixed (48 seeded
		// messages, no wall-clock-derived behavior), the store is a local
		// file on the same host, and no network is involved — run-to-run
		// variance is GC and scheduler jitter only. The median additionally
		// absorbs any single cold-start outlier (first-statement prepare,
		// extension warm-up), which is why the cold pass is a legitimate
		// sample even though it includes the one-time materialization.
		const allPasses = [coldMs, ...steadyMs, deltaRefreshMs];
		const medianMs = [...allPasses].sort((a, b) => a - b)[
			Math.floor(allPasses.length / 2)
		]!;
		expect(
			medianMs,
			`median of ${allPasses.map((ms) => ms.toFixed(1)).join(", ")} ms`,
		).toBeLessThan(200);
		expect(
			worstSteady,
			`steady management passes: ${steadyMs.map((ms) => ms.toFixed(1)).join(", ")} ms`,
		).toBeLessThan(200);
		expect(
			deltaRefreshMs,
			`delta-refresh pass: ${deltaRefreshMs.toFixed(1)} ms`,
		).toBeLessThan(200);
		expect(
			worstTick,
			`scheduler ticks: ${tickMs.map((ms) => ms.toFixed(1)).join(", ")} ms`,
		).toBeLessThan(200);

		evidence.tickBounded = {
			seededMessages: 48,
			boundMs: 200,
			managementPass: {
				coldPassMs: Number(coldMs.toFixed(2)),
				steadyPassMs: steadyMs.map((ms) => Number(ms.toFixed(2))),
				worstSteadyMs: Number(worstSteady.toFixed(2)),
				deltaRefreshMs: Number(deltaRefreshMs.toFixed(2)),
				medianOfFivePassesMs: Number(medianMs.toFixed(2)),
				// Exactly one bracket: the delta-refresh pass (the compartment
				// delta changed). Steady-state passes opened zero (asserted).
				managedBracketsAfterAllPasses:
					session.eventsOf("mc/manage-start").length - startsBefore,
			},
			schedulerTick: {
				noDueWorkMs: tickMs.map((ms) => Number(ms.toFixed(2))),
				worstTickMs: Number(worstTick.toFixed(2)),
			},
		};
		writeEvidence();
	}, 90_000);
});
