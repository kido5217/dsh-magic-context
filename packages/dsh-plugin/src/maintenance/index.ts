/**
 * Maintenance mount (T057): the US3 wiring that turns the core dreamer into
 * DSH background work.
 *
 * Composition: the core task executor (`createDreamTaskExecutor`, prompts,
 * parsers, budgets, run records — shared with every other host) driving two
 * DSH carriers — the single-shot aux-stream transport for one-shot tasks and
 * the hidden-agent transport for tool loops — dispatched per task class from
 * the core capability table; the adapter's own `MaintenanceScheduler` for
 * the clock (boot quiet, jitter, containment); and a boot-time orphan reap.
 *
 * Model configuration: DSH reads the `dreamer.dsh` block when present and
 * otherwise falls back to `dreamer.pi` — both are "host without a visible
 * session list" semantics, which is what DSH's hidden carriers are.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { RetrospectiveRawProvider } from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import { buildDreamTaskRuntimeConfigs } from "@magic-context/core/features/magic-context/dreamer/task-config";
import { createDreamTaskExecutor } from "@magic-context/core/features/magic-context/dreamer/task-executor";
import {
	DREAM_TASK_CAPABILITIES,
	type DreamTaskName,
} from "@magic-context/core/features/magic-context/dreamer/task-registry";
import type {
	DreamTaskRuntimeConfig,
	ManualRunResult,
	TaskExecutor,
} from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import { runManualDream } from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	beginBootQuietPeriod,
	bootQuietRemainingMs,
	setBootQuietPeriodForTests,
} from "@magic-context/core/plugin/boot-quiet";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import { reapMaintenanceOrphans } from "./orphans.js";
import { MaintenanceScheduler } from "./scheduler.js";
import {
	createCordisMaintenanceAgentRuntime,
	DshHiddenAgentTransport,
} from "./transport-agent.js";
import { DshSingleShotTransport } from "./transport-single-shot.js";

const DEFAULT_MAINTENANCE_TOOLS = [
	"read",
	"grep",
	"glob",
	"edit",
	"write",
	"ctx_memory",
	"ctx_search",
];

export interface MaintenanceMountDeps {
	readonly ctx: Context;
	readonly llmStream: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
	readonly db: ContextDatabase;
	readonly config: MagicContextConfig;
	/** Project filesystem directory the maintenance drain owns. */
	readonly projectDir: string;
	readonly projectIdentity: string;
	/** DSH session-log raw providers (retrospective seed, orientation seed). */
	readonly retrospectiveRawProvider?: RetrospectiveRawProvider;
	readonly primerRawProviderFactory?: (
		sessionId: string,
	) => Promise<RawMessageProvider | null> | RawMessageProvider | null;
}

export interface MaintenanceHandle {
	readonly scheduler: MaintenanceScheduler;
	/** Manual `/ctx-dream` path: forced single task or every enabled task. */
	runManual(task?: DreamTaskName): Promise<ManualRunResult>;
	stop(): void;
}

/** DSH session root: `$DSH_HOME/sessions` (crash residue reaped at boot). */
function maintenanceSessionRoot(): string {
	const home =
		process.env["DSH_HOME"] && process.env["DSH_HOME"].length > 0
			? process.env["DSH_HOME"]
			: join(homedir(), ".dsh");
	return join(home, "sessions");
}

/**
 * Whether the maintenance lane can run on this machine: an explicit DSH-side
 * dreamer model block (`dreamer.dsh`, falling back to `dreamer.pi` — both name
 * a serverless-host completion route) and a lane that is not disabled. This is
 * the single gate shared by the mount and by every user-facing capability that
 * maintenance must service (smart notes, `/ctx-dream`); a half-configured
 * lane must neither churn failing runs nor promise evaluation it cannot do.
 */
export function maintenanceRunnable(config: {
	dreamer?: Record<string, unknown> | null;
}): boolean {
	const dreamer = config.dreamer;
	if (!dreamer) return false;
	if (dreamer["enabled"] === false) return false;
	return dreamer["dsh"] !== undefined || dreamer["pi"] !== undefined;
}

export function startMaintenance(
	deps: MaintenanceMountDeps,
): MaintenanceHandle {
	// Live-gate seam: the fixed two-minute boot quiet is correct for real use
	// and pure latency for the V5 evidence run. Opt in explicitly.
	if (process.env["MAGIC_CONTEXT_TEST_NO_QUIET"] === "1")
		setBootQuietPeriodForTests(0);
	beginBootQuietPeriod();
	const removed = reapMaintenanceOrphans(maintenanceSessionRoot());
	if (removed.length > 0)
		log(
			`[dsh-magic-context] reaped ${String(removed.length)} crashed maintenance session(s)`,
		);

	const dreamer = (deps.config as { dreamer?: Record<string, unknown> })
		.dreamer;
	// DSH semantics match the serverless host block: `dreamer.dsh` when the
	// user wrote one, else `dreamer.pi`.
	const harnessDreamer: Record<string, unknown> = {
		...(dreamer ?? {}),
		pi:
			(dreamer?.["dsh"] as Record<string, unknown> | undefined) ??
			dreamer?.["pi"],
	};
	const language = (deps.config as { language?: string }).language;
	const smartNotesEnabled =
		(deps.config as { smart_notes?: { enabled?: boolean } }).smart_notes
			?.enabled !== false;
	const tasks = buildDreamTaskRuntimeConfigs(
		harnessDreamer,
		"pi",
		language,
		smartNotesEnabled,
	);

	const singleShot = new DshSingleShotTransport({
		llmStream: deps.llmStream,
	});
	const agentCarrier = new DshHiddenAgentTransport(
		createCordisMaintenanceAgentRuntime(deps.ctx),
		{
			toolAllowlist: DEFAULT_MAINTENANCE_TOOLS,
		},
	);
	const baseDeps = {
		sessionDirectory: deps.projectDir,
		openOpenCodeDb: () => null,
		smartNotesEnabled,
		...(deps.retrospectiveRawProvider !== undefined
			? { retrospectiveRawProvider: deps.retrospectiveRawProvider }
			: {}),
		...(deps.primerRawProviderFactory !== undefined
			? { primerRawProviderFactory: deps.primerRawProviderFactory }
			: {}),
		...(language !== undefined ? { language } : {}),
	};
	const singleShotExecutor = createDreamTaskExecutor({
		...baseDeps,
		hiddenCompletionExecutor: singleShot,
	});
	const toolLoopExecutor = createDreamTaskExecutor({
		...baseDeps,
		hiddenCompletionExecutor: agentCarrier,
	});
	const executor: TaskExecutor = (task, context) =>
		(DREAM_TASK_CAPABILITIES[task.task]?.transport === "tool-loop"
			? toolLoopExecutor
			: singleShotExecutor)(task, context);

	const manualDeps = {
		db: deps.db,
		projectIdentity: deps.projectIdentity,
		tasks,
		executor,
	};

	const tickEnv = Number(process.env["MAGIC_CONTEXT_TEST_TICK_MS"]);
	const jitterEnv = Number(process.env["MAGIC_CONTEXT_TEST_JITTER_MS"]);
	const scheduler = new MaintenanceScheduler({
		db: deps.db,
		...(Number.isFinite(tickEnv) && tickEnv > 0
			? { tickIntervalMs: tickEnv }
			: {}),
		...(Number.isFinite(jitterEnv) && jitterEnv >= 0
			? { jitterSlotMs: jitterEnv }
			: {}),
		setInterval: (callback, ms) => {
			const timer = setInterval(callback, ms);
			return () => {
				clearInterval(timer);
			};
		},
		bootQuietRemainingMs,
		onError: (where, error) => {
			sessionLog(
				"maintenance",
				`tick error (${where}):`,
				error instanceof Error ? error.message : String(error),
			);
		},
	});
	scheduler.registerProject({
		projectIdentity: deps.projectIdentity,
		tasks,
		executor,
	});
	scheduler.start();

	return {
		scheduler,
		runManual: (task?: DreamTaskName) =>
			runManualDream({ ...manualDeps, task }),
		stop: () => scheduler.stop(),
	};
}

export type { DreamTaskRuntimeConfig };
