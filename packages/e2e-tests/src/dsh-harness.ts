/** DshTestHarness — facade for DSH Magic Context e2e tests (T080). */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
    cleanupDshIsolatedEnv,
    createDshIsolatedEnv,
    type DshIsolatedEnv,
    type DshTurnResult,
    readDshSessionLog,
    runDshTurn,
} from "./dsh-runner/spawn";
import type {
    HostCapabilities,
    HostHarness,
    HostPromptOptions,
} from "./host-harness";
import type { CapturedRequest, MockResponse } from "./mock-provider/server";
import { MockProvider } from "./mock-provider/server";
import { assertHistorianMockRouting } from "./mock-routing";
import { prepareContextDatabase } from "./prepare-context-db";

export interface DshTestHarnessOptions {
    mockDefault?: MockResponse;
    /** Shared Magic Context settings merged into the seeded user config. */
    magicContextConfig?: Record<string, unknown>;
    /** Context window advertised on the mock route (default 200k). */
    modelContextLimit?: number;
    /** Share the cortexkit DB with another harness. */
    sharedDataDir?: string;
    /** Extra cordis.patch.yml rows for the scenario profile. */
    dshProfilePatch?: readonly Record<string, unknown>[];
    /** Bounds one headless boot (also MC_DSH_TURN_TIMEOUT_MS). */
    turnTimeoutMs?: number;
}

const DEFAULT_MOCK_RESPONSE: MockResponse = {
    text: "ok",
    usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
    },
};

const MOCK_MODEL = "mock-model";
const MOCK_MODEL_REF = `mock/${MOCK_MODEL}`;

/**
 * DSH boots one headless turn per process. A session id is therefore only
 * observable after the first turn committed the session; `createSession()`
 * hands back a pending id and the first `sendPrompt` materializes it (a boot
 * WITHOUT `--session-id`, because adoption refuses an id with no stored
 * session). Every later turn — and every `restart()` — is a fresh process
 * adopting the SAME durable session.
 */
const PENDING_PREFIX = "dsh-pending-";

export class DshTestHarness implements HostHarness {
    readonly host = "dsh" as const;
    readonly harnessId = "dsh" as const;
    readonly capabilities: HostCapabilities = {
        childSessions: false,
        // The MC bundle disables `compaction-basic`; Magic Context is the only
        // folding engine on this lane, so there is no native fold carrier.
        nativeCompact: false,
        sessionRemove: false,
        // One-shot boots have no between-turn window to steer into.
        steerDelivery: false,
    };
    readonly mock: MockProvider;
    readonly env: DshIsolatedEnv;

    private readonly expectMagicContext: boolean;
    private readonly turnTimeoutMs?: number;
    private readonly pendingToActual = new Map<string, string>();
    private nextPending = 0;
    private contextDbCached: Database | null = null;
    private turns: DshTurnResult[] = [];

    private constructor(
        mock: MockProvider,
        env: DshIsolatedEnv,
        expectMagicContext: boolean,
        turnTimeoutMs?: number,
    ) {
        this.mock = mock;
        this.env = env;
        this.expectMagicContext = expectMagicContext;
        this.turnTimeoutMs = turnTimeoutMs;
    }

    static async create(
        options: DshTestHarnessOptions = {},
    ): Promise<DshTestHarness> {
        const mock = new MockProvider();
        const { baseURL } = await mock.start();
        mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);
        const env = createDshIsolatedEnv({
            mockBaseURL: `${baseURL}/v1`,
            models: [
                {
                    id: MOCK_MODEL,
                    contextWindow: options.modelContextLimit ?? 200_000,
                    maxTokens: 8192,
                },
            ],
            defaultModel: MOCK_MODEL,
            sharedDataDir: options.sharedDataDir,
            patch: options.dshProfilePatch,
            magicContextConfig: options.magicContextConfig,
        });
        if (options.magicContextConfig?.enabled !== false) {
            try {
                prepareContextDatabase(env.dataDir);
            } catch (error) {
                await mock.stop();
                throw error;
            }
        }
        return new DshTestHarness(
            mock,
            env,
            options.magicContextConfig?.enabled !== false,
            options.turnTimeoutMs,
        );
    }

    get serverUrl(): null {
        return null;
    }

    get workdir(): string {
        return this.env.workdir;
    }

    get dataDir(): string {
        return this.env.dataDir;
    }

    /**
     * Prose ballast, mirroring TestHarness/PiTestHarness: the protected-tail
     * boundary measures TRUE-RAW content, so pressure-driving turns need real
     * content mass.
     */
    ballast(tokens: number): string {
        const words = [
            "boundary",
            "historian",
            "compartment",
            "schedule",
            "pressure",
            "tokens",
            "window",
            "publish",
            "transform",
            "session",
            "marker",
            "budget",
            "eligible",
            "protected",
            "ordinal",
            "snapshot",
            "replay",
            "decision",
            "threshold",
            "baseline",
            "measure",
            "archive",
            "deliver",
        ];
        const target = Math.max(0, Math.round(tokens * 4));
        const parts: string[] = [];
        let length = 0;
        let i = 0;
        while (length < target) {
            const w = words[i % words.length];
            parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
            length += w.length + 1;
            i += 1;
        }
        return parts.join(" ");
    }

    async createSession(): Promise<string> {
        const pending = `${PENDING_PREFIX}${++this.nextPending}`;
        this.pendingToActual.set(pending, "");
        return pending;
    }

    async removeSession(_sessionId: string): Promise<void> {
        throw new Error("dsh does not expose terminal session removal");
    }

    /** Durable session id for a harness-issued id (pending ids resolve lazily). */
    resolveSessionId(sessionId: string): string {
        return this.pendingToActual.get(sessionId) || sessionId;
    }

    async sendPrompt(
        sessionId: string,
        text: string,
        options: HostPromptOptions = {},
    ): Promise<DshTurnResult> {
        // A pending placeholder maps to "" until the first turn names the real
        // session: that boot must run WITHOUT --session-id (adoption refuses an
        // id with no stored session). Anything else adopts as given.
        const mapped = this.pendingToActual.get(sessionId);
        const launchSessionId = mapped === "" ? undefined : (mapped ?? sessionId);
        const turn = await runDshTurn(this.env, text, {
            ...(launchSessionId === undefined ? {} : { sessionId: launchSessionId }),
            timeoutMs: options.timeoutMs ?? this.turnTimeoutMs,
        });
        if (turn.exitCode !== 0) {
            throw new Error(
                `dsh headless turn failed (exit ${String(turn.exitCode)}${turn.signalCode ? `, ${turn.signalCode}` : ""}): ` +
                    `${turn.stderr.trim() || "(no stderr)"}\n--- dsh event tail ---\n` +
                    turn.events
                        .slice(-12)
                        .map((event) => JSON.stringify(event))
                        .join("\n"),
            );
        }
        if (!turn.sessionId) {
            throw new Error(
                `dsh turn reported no session id\n--- dsh stderr ---\n${turn.stderr}`,
            );
        }
        if (mapped === "") this.pendingToActual.set(sessionId, turn.sessionId);
        else {
            const expected = mapped ?? sessionId;
            if (turn.sessionId !== expected) {
                throw new Error(
                    `dsh turn ran session ${turn.sessionId}, expected ${expected}`,
                );
            }
        }
        if (this.expectMagicContext) this.assertMagicContextProcessed(sessionId);
        this.turns.push(turn);
        return turn;
    }

    assertMagicContextProcessed(sessionId: string): void {
        if (!this.expectMagicContext) return;
        const processed = this.contextDb()
            .prepare(
                "SELECT 1 FROM session_meta WHERE session_id = ? AND harness = ?",
            )
            .get(this.resolveSessionId(sessionId), this.harnessId);
        if (!processed)
            throw new Error(`dsh Magic Context did not process session ${sessionId}`);
    }

    /** Restart-on-same-session: the next turn boots a fresh process and adopts. */
    async restart(): Promise<void> {
        // Nothing to tear down: each headless boot is already a new process on
        // the same durable session, which is exactly this contract's restart.
    }

    async reloadPlugin(): Promise<void> {
        // Every boot re-reads the linked bundle, so the next turn runs reloaded.
    }

    get lastTurn(): DshTurnResult | null {
        return this.turns[this.turns.length - 1] ?? null;
    }

    /** Durable v4 session-log events for one session (zstd JSONL). */
    sessionLogEvents(sessionId: string): Array<Record<string, unknown>> {
        return readDshSessionLog(this.env, this.resolveSessionId(sessionId));
    }

    contextDbPath(): string {
        return join(this.env.dataDir, "cortexkit", "magic-context", "context.db");
    }

    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        const dbPath = this.contextDbPath();
        if (!existsSync(dbPath))
            throw new Error(`context.db not found at ${dbPath}`);
        this.contextDbCached = new Database(dbPath, { readonly: true });
        return this.contextDbCached;
    }

    private closeContextDb(): void {
        if (!this.contextDbCached) return;
        try {
            this.contextDbCached.close();
        } catch {
            // ignore close errors in test polling helpers
        }
        this.contextDbCached = null;
    }

    hasContextDb(): boolean {
        return existsSync(this.contextDbPath());
    }

    countCompartments(sessionId: string, harness = this.harnessId): number {
        try {
            const row = this.contextDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ? AND harness = ?",
                )
                .get(this.resolveSessionId(sessionId), harness) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    countTags(sessionId: string, harness = this.harnessId): number {
        try {
            const row = this.contextDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ?",
                )
                .get(this.resolveSessionId(sessionId), harness) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    countTagsByStatus(
        sessionId: string,
        status: string,
        harness = this.harnessId,
    ): number {
        try {
            const row = this.contextDb()
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ? AND status = ?",
                )
                .get(this.resolveSessionId(sessionId), harness, status) as {
                n: number;
            } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    async waitFor<T>(
        predicate: () => T | null | undefined | false,
        opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
    ): Promise<T> {
        const timeoutMs = opts.timeoutMs ?? 60_000;
        const intervalMs = opts.intervalMs ?? 100;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value as T;
            await Bun.sleep(intervalMs);
        }
        throw new Error(
            `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`,
        );
    }

    async waitForMockQuiescence(
        opts: { quietMs?: number; label?: string } = {},
    ): Promise<void> {
        const quietMs = opts.quietMs ?? 250;
        let stableRequestCount: number | null = null;
        let quietSince = 0;
        await this.waitFor(
            () => {
                const requests = this.mock.requests();
                if (
                    requests.some((request) => request.responseCompletedAt === undefined)
                ) {
                    stableRequestCount = null;
                    return false;
                }
                if (stableRequestCount !== requests.length) {
                    stableRequestCount = requests.length;
                    quietSince = Date.now();
                    return false;
                }
                return Date.now() - quietSince >= quietMs;
            },
            {
                intervalMs: Math.min(50, quietMs),
                label: opts.label ?? "mock provider quiescence",
            },
        );
    }

    requests(): CapturedRequest[] {
        return this.mock.requests();
    }

    diagnostics(): string {
        const tail = this.turns[this.turns.length - 1];
        return tail
            ? `${tail.stderr}\n--- dsh events ---\n${tail.events.map((event) => JSON.stringify(event)).join("\n")}`
            : "(no dsh turn recorded)";
    }

    assertHistorianRequestsUseMock(): void {
        if (this.expectMagicContext && this.hasContextDb()) {
            assertHistorianMockRouting(
                this.contextDb(),
                this.harnessId,
                MOCK_MODEL_REF,
                [MOCK_MODEL],
            );
        }
    }

    async dispose(): Promise<void> {
        try {
            this.assertHistorianRequestsUseMock();
        } finally {
            this.closeContextDb();
            await this.mock.stop();
            cleanupDshIsolatedEnv(this.env);
        }
    }
}
