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
import {
	beginBootQuietPeriod,
	bootQuietRemainingMs,
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

export function startMaintenance(
	deps: MaintenanceMountDeps,
): MaintenanceHandle {
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

	const scheduler = new MaintenanceScheduler({
		db: deps.db,
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
