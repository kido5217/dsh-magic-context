/**
 * Plugin entry (T007).
 *
 * Cordis function plugin: `export const name` + `export function apply(ctx,
 * config?)`. Boot order (core contract §13): setHarness("dsh") → register the
 * standalone-plugin marker → load the SHARED config (no DSH-only knobs) →
 * sqlite pragmas → open the shared store → mount. Every mounted effect is
 * registered through `ctx.effect()` so unmount unwinds it (no orphan
 * listeners/handles); the DB closes on process exit (shared handle).
 *
 * `mountAdapter(host, cfg, db)` is the testable core: production builds a real
 * host over `ctx` (host-cordis.ts); tests mount it on a double (test/double.ts)
 * against a real temp store.
 */
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { isDreamerRunnable } from "@magic-context/core/config/agent-disable";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
	setSqlitePragmaConfig,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { log } from "@magic-context/core/shared/logger";
import { createPromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import { registerStandalonePluginMarker } from "@magic-context/core/standalone-plugin-marker";
import packageMetadata from "../package.json";
import {
	CompactionClaimRegistry,
	McCompactionClaim,
	type McFoldCallback,
} from "./compaction-claim.js";
import { loadDshConfig } from "./config/index.js";
import type { DshHost } from "./host.js";
import {
	createCordisHistorianRoute,
	createCordisHost,
	createCordisSessionLogSource,
} from "./host-cordis.js";
import { PressureLanes } from "./pressure/lanes.js";
import { PressureMeter } from "./pressure/meter.js";
import { Historian, type HistorianRoute } from "./sessions/historian.js";
import { SessionMapping } from "./sessions/mapping.js";
import { DropApplier } from "./surface/apply-operations.js";
import type { DshSessionLogReader } from "./surface/dsh-session-log.js";
import { HeadManager } from "./surface/head.js";
import { ManagedEdits } from "./surface/managed-edits.js";
import { registerMagicContextToolsDsh } from "./tools/index.js";

export const name = "dsh-magic-context";

/** Cordis service injections (Loader dialect: services touched through `ctx`). */
export const inject = [
	"tools",
	"llm",
	"agents",
	"sessions",
	"sessionQuery",
	"tokenMeter",
];

export interface MountOptions {
	/**
	 * MC fold callback for claimed compaction (T011). The US1 historian folds at
	 * pressure passes; wiring the claim's manual `/compact` entry point to the
	 * historian route lands with the US3 command surface. Default: no-op.
	 */
	readonly fold?: McFoldCallback;
	/** Surface-visible message reader for a session (T015 durable-log projection). */
	readonly readSessionLog?: DshSessionLogReader;
	/** Routed model for auxiliary historian calls (T018); absent ⇒ folds defer. */
	readonly historianRoute?: HistorianRoute;
	/** Session resolver for the ctx_* tools (default: most recently attached). */
	readonly sessionId?: () => string;
	/** Workspace directory backing tool project identity. */
	readonly projectDir?: string;
	/** Model key for per-model prompt-surface epochs. */
	readonly modelKey?: string;
}

/** Handle over the mounted foundation; `dispose()` unwinds every effect. */
export interface AdapterHandle {
	readonly mapping: SessionMapping;
	readonly managedEdits: ManagedEdits;
	readonly compaction: CompactionClaimRegistry;
	readonly meter: PressureMeter;
	readonly head: HeadManager;
	readonly historian: Historian;
	readonly dropApplier: DropApplier;
	readonly lanes: PressureLanes;
	dispose(): Promise<void>;
}

/**
 * Mount the foundation layer on a host + shared store. Effects are registered
 * via `ctx.effect()` so a fiber (or the returned disposer) unwinds them in
 * reverse order.
 */
export function mountAdapter(
	host: DshHost,
	config: MagicContextConfig,
	db: ContextDatabase,
	opts: MountOptions = {},
): AdapterHandle {
	const disposables: Array<() => Promise<void>> = [];
	const registerEffect = (
		label: string,
		setup: () => () => void | Promise<void>,
	): void => {
		const disposable = host.ctx.effect(() => {
			const teardown = setup();
			return async () => {
				await teardown();
			};
		}, `dsh-magic-context:${label}`);
		disposables.push(() => Promise.resolve(disposable()));
	};

	// T008 — session mapping (idempotent store upsert + role classification).
	const mapping = new SessionMapping(db);
	registerEffect("session-mapping", () => () => mapping.detachAll());

	// T004/T016 — the assistant-body projection (owner of the plugin event type).
	// Registered before any session is read so live and restored sessions both
	// derive the rewrite; disposing the fiber drops the interpreter, and a log
	// replayed without it degrades to the original content.
	registerEffect("rewrite-projection", () => host.registerRewriteProjection());

	// T009 — managed edits (decision-before-effect, one bracket per change).
	const managedEdits = new ManagedEdits(host);
	registerEffect("managed-edits", () => () => managedEdits.close());

	// T011 — compaction claim (MC owns folding on managed sessions).
	const compaction = new CompactionClaimRegistry();
	const fold: McFoldCallback = opts.fold ?? (async () => null);
	registerEffect("compaction-claim", () => {
		new McCompactionClaim(host.ctx, compaction, fold);
		return () => {
			host.ctx.reflect.set("compaction", undefined);
		};
	});

	// T012 — pressure meter bridge.
	const meter = new PressureMeter(host, config);
	registerEffect("pressure-meter", () => () => undefined);

	// [T015 pass] transform-pass bridge (US1): durable-log projection, queued
	// drops, head management, the historian fold and the pressure lanes, all
	// mounted behind one pre-step listener. Sessions join the compaction claim
	// at first attach (lanes.ts documents the choice).
	const head = new HeadManager(
		db,
		managedEdits,
		config,
		opts.projectDir ?? process.cwd(),
	);
	const historian = new Historian(
		host,
		db,
		config,
		managedEdits,
		head,
		opts.historianRoute,
	);
	const dropApplier = new DropApplier(db, managedEdits);
	const lanes = new PressureLanes({
		host,
		db,
		config,
		mapping,
		claim: compaction,
		meter,
		head,
		historian,
		dropApplier,
		readSessionLog: opts.readSessionLog ?? (() => undefined),
	});
	registerEffect("pressure-lanes", () => {
		const offPreStep = host.onPreStep(lanes.onPreStep);
		return () => {
			offPreStep();
			lanes.detachAll();
		};
	});

	// [T031 tools] the five ctx_* tools register here via host.registerTool.
	// Same five for subagent sessions (FR-005); `sessionId()` resolves per call
	// so one registration follows session switches. Gates mirror pi's boot-time
	// registration; the core prompt surface is the sole description source.
	const promptSurfaceRuntime = createPromptSurfaceRuntime({
		harness: "dsh",
		directory: process.cwd(),
		warn: (message) => log(`[dsh-magic-context] prompt-surface: ${message}`),
	});
	registerEffect("ctx-tools", () => {
		const disposeTools = registerMagicContextToolsDsh(host, {
			db,
			// T018: tools resolve the calling agent per call; there is no
			// last-attached fallback in production. A call outside an agent turn
			// is a contract violation, not a guess.
			sessionId: () => {
				throw new Error(
					"ctx_* tool invoked outside an agent turn: no calling agent",
				);
			},
			projectDir: opts.projectDir ?? process.cwd(),
			protectedTags: config.protected_tags ?? 20,
			rerankConnectionFile: config.subc?.connection_file,
			promptSurfaceRuntime,
			promptSurface: config.prompt_surface,
			modelKey: opts.modelKey,
			smartNotesEnabled: config.smart_notes?.enabled,
			dreamerEnabled: isDreamerRunnable(config),
			memoryEnabled: config.memory?.enabled,
			expandTools: config.historian?.expand_tools,
		});
		return () => {
			disposeTools();
		};
	});

	return {
		mapping,
		managedEdits,
		compaction,
		meter,
		head,
		historian,
		dropApplier,
		lanes,
		dispose: async () => {
			for (const disposable of disposables.reverse()) {
				await disposable();
			}
		},
	};
}

/** Production boot (Cordis function plugin). */
export async function apply(
	ctx: Context,
	config?: Record<string, unknown> & { cwd?: string },
): Promise<void> {
	setHarness("dsh");
	registerStandalonePluginMarker(packageMetadata.version);
	const loaded = loadDshConfig({ cwd: config?.cwd ?? process.cwd() });
	for (const warning of loaded.warnings) log(`[dsh-magic-context] ${warning}`);
	if (loaded.loadedFromPaths.length > 0)
		log(
			`[dsh-magic-context] config loaded from ${loaded.loadedFromPaths.join(", ")}`,
		);
	if (!loaded.config.enabled) {
		log(
			"[dsh-magic-context] disabled by config (enabled: false); not mounting",
		);
		return;
	}
	const { cache_size_mb, mmap_size_mb } = loaded.config.sqlite;
	setSqlitePragmaConfig({
		cacheSizeMb: cache_size_mb,
		mmapSizeMb: mmap_size_mb,
	});
	const dbPath = join(getMagicContextStorageDir(), "context.db");
	const db = await openDatabaseAsync({ dbPath, nativeTurnDeadlines: true });
	if (!db) {
		log(
			"[dsh-magic-context] shared store unavailable; Magic Context is disabled for this run",
		);
		return;
	}
	process.once("exit", () => {
		void closeDatabase();
	});
	const cwd = config?.cwd ?? process.cwd();
	// Production pass wiring (T025): the log snapshot refreshes inside the one
	// pre-step listener (host-cordis), before the management pass runs, and
	// before every tool execution. The historian route rides the host's
	// per-step model selection. (Waterfall listeners are dispatched
	// innermost-registered-first and a decision short-circuits the chain, so
	// the adapter owns exactly one listener and sequences its steps inside it.)
	const sessionLog = createCordisSessionLogSource(ctx);
	const historian = createCordisHistorianRoute();
	const handle = mountAdapter(
		createCordisHost(ctx, { sessionLog, observeModel: historian.observe }),
		loaded.config,
		db,
		{
			readSessionLog: sessionLog.read,
			historianRoute: historian.route,
			projectDir: cwd,
		},
	);
	ctx.effect(() => handle.dispose, "dsh-magic-context");
}

export type { McFoldCallback } from "./compaction-claim.js";
export {
	CompactionClaimRegistry,
	McCompactionClaim,
} from "./compaction-claim.js";
export type {
	DshHost,
	DshSession,
	PreStepDecision,
	PreStepInfo,
	PressureReading,
} from "./host.js";
export type {
	CordisHostOptions,
	CordisSessionLogSource,
} from "./host-cordis.js";
// Re-export the seam vocabulary so downstream tasks mount through one module.
export {
	createCordisHistorianRoute,
	createCordisHost,
	createCordisSessionLogSource,
} from "./host-cordis.js";
export { PressureLanes } from "./pressure/lanes.js";
export type { PressureBands } from "./pressure/meter.js";
export {
	PressureMeter,
	resolveExecuteThresholdPercentage,
} from "./pressure/meter.js";
export type { HistorianRoute } from "./sessions/historian.js";
export { Historian } from "./sessions/historian.js";
export type { McSessionMapping, McSessionRole } from "./sessions/mapping.js";
export { classifySession, SessionMapping } from "./sessions/mapping.js";
export type { McRoleRules } from "./sessions/subagent-rules.js";
export { rulesForRole } from "./sessions/subagent-rules.js";
export {
	DropApplier,
	protectedTailBudget,
	recordTokenEstimate,
	splitProtectedTail,
} from "./surface/apply-operations.js";
export type {
	DshLogMessageRecord,
	DshLogProjection,
	DshSessionLogReader,
} from "./surface/dsh-session-log.js";
export {
	createDshRawMessageProvider,
	projectDshSessionLog,
	registerDshRawHistoryProvider,
} from "./surface/dsh-session-log.js";
export type {
	McManagedChangeKind,
	McReplacementContent,
} from "./surface/events.js";
export { HeadManager } from "./surface/head.js";
export type {
	ManagedChangeOptions,
	PendingUnapplied,
	ShadowInfo,
} from "./surface/managed-edits.js";
export {
	ManagedEdits,
	StoreBusyError,
	StoreUnavailableError,
} from "./surface/managed-edits.js";
