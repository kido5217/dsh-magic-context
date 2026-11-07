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
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
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
import { registerCommands } from "./commands/index.js";
import {
	CompactionClaimRegistry,
	McCompactionClaim,
	type McFoldCallback,
} from "./compaction-claim.js";
import { createMcFold } from "./compaction-fold.js";
import { loadDshConfig } from "./config/index.js";
import type { DshHost } from "./host.js";
import {
	createCordisHistorianRoute,
	createCordisHost,
	createCordisSessionLogSource,
} from "./host-cordis.js";
import { rebuildPermission } from "./lanes/gating.js";
import {
	detectOverflowError,
	OverflowLedger,
	OverflowRecoveryGate,
	recoverOverflow,
} from "./lanes/overflow.js";
import { Channel1Tracker, decideChannel1For } from "./lanes/reduce-nudge.js";
import {
	type MaintenanceHandle,
	maintenanceRunnable,
	startMaintenance,
} from "./maintenance/index.js";
import {
	createCordisSessionHistorySource,
	createDshPrimerRawProviderFactory,
	createDshRetrospectiveRawProvider,
} from "./maintenance/raw-session.js";
import { PressureLanes } from "./pressure/lanes.js";
import { PressureMeter } from "./pressure/meter.js";
import { Historian, type HistorianRoute } from "./sessions/historian.js";
import { SessionMapping } from "./sessions/mapping.js";
import { rulesForRole } from "./sessions/subagent-rules.js";
import {
	DropApplier,
	protectedTailBudget,
} from "./surface/apply-operations.js";
import type { DshSessionLogReader } from "./surface/dsh-session-log.js";
import { projectDshSessionLog } from "./surface/dsh-session-log.js";
import { HeadManager, type MuralAttachments } from "./surface/head.js";
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
	"attachments",
	"commands",
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
	/**
	 * Host attachment store; the mural image (T047) commits through it.
	 * Absent ⇒ murals stay text-only.
	 */
	readonly attachments?: MuralAttachments;
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

	// T033 channel 1 — the post-execute `ctx_reduce` nudge. It rides the tool
	// result the agent just produced, which is exactly where the decision about
	// that output is made; the core's state machine decides when and the core's
	// copy is what the model reads.
	const channel1 = new Channel1Tracker();
	registerEffect("reduce-nudge-channel1", () =>
		host.onPostToolExecute((info) => {
			const session = host.getSession(info.sessionId);
			if (session === undefined) return undefined;
			const mapped = mapping.upsert(session.header);
			if (info.toolName === "ctx_reduce") {
				channel1.noteReduce(mapped.mcSession);
				return undefined;
			}
			const verdict = decideChannel1For(
				{
					session,
					mcSession: mapped.mcSession,
					projection: projectDshSessionLog(
						opts.readSessionLog?.(info.sessionId) ?? [],
					),
					rules: rulesForRole(mapped.role),
					band: meter.lane(info.sessionId),
					permission: rebuildPermission({
						schedulerAllows: false,
						band: meter.lane(info.sessionId),
					}),
					config,
					db,
					protectedMessageIds: new Set<string>(),
					projectDir: opts.projectDir ?? process.cwd(),
				},
				channel1,
				false,
			);
			if (!verdict.fire || verdict.text === undefined) return undefined;
			return { additionalContext: [{ type: "text", text: verdict.text }] };
		}),
	);
	registerEffect(
		"reduce-nudge-channel1-tracker",
		() => () => channel1.detachAll(),
	);

	// T028 — overflow recovery: learn the route's real window, fold, retry once.
	const overflowLedger = new OverflowLedger();
	const overflowGate = new OverflowRecoveryGate();
	registerEffect("overflow-recovery", () =>
		host.onRequestError(async (info) => {
			const detection = detectOverflowError(info.failure);
			if (!detection.isOverflow) return false;
			const session = host.getSession(info.sessionId);
			if (session === undefined) return false;
			const mapped = mapping.upsert(session.header);
			return await recoverOverflow({
				sessionId: info.sessionId,
				detection,
				ledger: overflowLedger,
				gate: overflowGate,
				...(host.pressure(info.sessionId)?.contextWindow !== undefined
					? { advertisedWindow: host.pressure(info.sessionId)?.contextWindow }
					: {}),
				fold: () =>
					historian.fold({
						session,
						mcSession: mapped.mcSession,
						projection: projectDshSessionLog(
							opts.readSessionLog?.(info.sessionId) ?? [],
						),
						rules: rulesForRole(mapped.role),
						subagent: mapped.role === "subagent",
						protectedTailTokens: protectedTailBudget(
							config,
							host.pressure(info.sessionId)?.contextWindow,
							false,
						),
					}),
			});
		}),
	);
	registerEffect("overflow-ledger", () => () => {
		overflowLedger.detachAll();
		overflowGate.detachAll();
	});

	// T004/T016 — the assistant-body projection (owner of the plugin event type).
	// Registered before any session is read so live and restored sessions both
	// derive the rewrite; disposing the fiber drops the interpreter, and a log
	// replayed without it degrades to the original content.
	registerEffect("rewrite-projection", () => host.registerRewriteProjection());

	// T009 — managed edits (decision-before-effect, one bracket per change).
	const managedEdits = new ManagedEdits(host);
	registerEffect("managed-edits", () => () => managedEdits.close());

	// T011 — compaction claim (MC owns folding on managed sessions).
	// T072 — the claim's manual entry is the real historian fold (compaction
	// lifecycle + checkpoint + full CompactionResult), built below once the
	// historian exists; the wrapper resolves the late binding at call time.
	const compaction = new CompactionClaimRegistry();
	let mcFold: McFoldCallback | undefined = opts.fold;
	const fold: McFoldCallback = (agent, region, signal, meta) =>
		mcFold === undefined
			? Promise.resolve(null)
			: mcFold(agent, region, signal, meta);
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
	const promptSurfaceRuntime = createPromptSurfaceRuntime({
		harness: "dsh",
		directory: process.cwd(),
		warn: (message) => log(`[dsh-magic-context] prompt-surface: ${message}`),
	});

	const head = new HeadManager(
		db,
		managedEdits,
		config,
		opts.projectDir ?? process.cwd(),
		opts.historianRoute,
		opts.attachments,
		opts.modelKey,
		promptSurfaceRuntime,
	);
	const historian = new Historian(
		host,
		db,
		config,
		managedEdits,
		head,
		opts.historianRoute,
		opts.projectDir ?? process.cwd(),
	);
	// T072 — `/compact` folds for real: same fold core, host lifecycle
	// events, and the shared busy slot on the claim (a pre-step pass and a
	// manual fold never overlap on one session).
	mcFold ??= createMcFold({
		host,
		db,
		config,
		claim: compaction,
		mapping,
		historian,
		readSessionLog: opts.readSessionLog ?? (() => undefined),
	});
	const dropApplier = new DropApplier(db, managedEdits);
	const lanes = new PressureLanes({
		host,
		db,
		config,
		mapping,
		overflowWindows: overflowLedger,
		claim: compaction,
		meter,
		head,
		historian,
		dropApplier,
		managedEdits,
		projectDir: opts.projectDir ?? process.cwd(),
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
			dreamerEnabled: maintenanceRunnable(config),
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
/** The live maintenance handle (US4 `/ctx-dream` runs through it). */
export let activeMaintenance: MaintenanceHandle | undefined;

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
	const cordisHost = createCordisHost(ctx, {
		sessionLog,
		observeModel: historian.observe,
	});
	const handle = mountAdapter(cordisHost, loaded.config, db, {
		readSessionLog: sessionLog.read,
		historianRoute: historian.route,
		projectDir: cwd,
		attachments: ctx.attachments,
	});
	ctx.effect(() => handle.dispose, "dsh-magic-context");
	// [T067 commands] the six ctx-* slash commands, dispatched by interactive
	// surfaces against the agent that received them.
	const disposeCommands = registerCommands({
		db,
		config: loaded.config,
		lanes: handle.lanes,
		version: packageMetadata.version,
		projectDir: cwd,
		maintenance: () => activeMaintenance,
		register: (definition) => ctx.commands.register(definition),
	});
	ctx.effect(() => disposeCommands, "dsh-magic-context-commands");
	// V6 registration proof: interactive surfaces list these; headless proves
	// the mount reached the command registry (dispatch is surface-side).
	process.stderr.write(
		"[dsh-magic-context] commands registered: ctx-status, ctx-flush, ctx-embed, ctx-recomp, ctx-wrapup, ctx-dream\n",
	);
	// [T057 maintenance] the background dreamer: one adapter clock, two hidden
	// carriers, core task logic. Gated on an explicit dreamer model block —
	// a machine with no configured dreamer model must not churn failing runs.
	const maintenanceModel = maintenanceRunnable(loaded.config);
	if (maintenanceModel) {
		const identity = resolveProjectIdentityForSession(cwd);
		if (identity !== undefined) {
			const historySource = createCordisSessionHistorySource(ctx);
			let maintenance: MaintenanceHandle;
			try {
				maintenance = startMaintenance({
					retrospectiveRawProvider: createDshRetrospectiveRawProvider(
						historySource,
						cwd,
					),
					primerRawProviderFactory:
						createDshPrimerRawProviderFactory(historySource),
					ctx,
					llmStream: (options) => cordisHost.llmStream(options),
					db,
					config: loaded.config,
					projectDir: cwd,
					projectIdentity: identity,
				});
			} catch (error) {
				console.error(
					`[dsh-magic-context] maintenance mount failed: ${String(error)}`,
				);
				return;
			}
			ctx.effect(() => maintenance.stop, "dsh-magic-context-maintenance");
			activeMaintenance = maintenance;
		}
	}
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
