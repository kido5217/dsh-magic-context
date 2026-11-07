/**
 * [T067] The six user-facing commands, registered through the host command
 * registry so interactive surfaces dispatch them without reaching the model.
 * Handlers run the SAME shared services every other harness uses and return
 * result text; long maintenance returns immediately with a started report.
 */
import type { CommandDefinition } from "@deepseek-ai/dsh-commands";
import { CommandDefinitionId } from "@deepseek-ai/dsh-commands/brand";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { DreamTaskName } from "@magic-context/core/features/magic-context/dreamer/task-registry";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { executeFlush } from "@magic-context/core/hooks/magic-context/execute-flush";
import type { PressureLanes } from "../pressure/lanes.js";
import { buildStatusText } from "./status.js";

const OWNER = "cortexkit.dsh-magic-context";

export interface ManualMaintenanceHandle {
	runManual(task?: DreamTaskName): Promise<{
		ran: string[];
		skippedNoWork: string[];
		skipped?: string[];
		deferredBusy?: string[];
		failed?: string[];
	}>;
}

export interface CommandDeps {
	readonly db: ContextDatabase;
	readonly config: MagicContextConfig;
	readonly lanes: PressureLanes;
	readonly version: string;
	readonly projectDir: string;
	readonly maintenance: () => ManualMaintenanceHandle | undefined;
	register(definition: CommandDefinition): () => void;
}

function sessionIdOf(invocation: {
	agent: { session?: { id?: string } };
}): string {
	const id = invocation.agent.session?.id;
	return typeof id === "string" ? id : "";
}

function formatManualResult(result: {
	ran: string[];
	skippedNoWork: string[];
	skipped?: string[];
	deferredBusy?: string[];
	failed?: string[];
}): string {
	const parts: string[] = [];
	if (result.ran.length > 0) parts.push(`Ran: ${result.ran.join(", ")}`);
	if (result.skippedNoWork.length > 0)
		parts.push(`Skipped (no work): ${result.skippedNoWork.join(", ")}`);
	if (result.skipped !== undefined && result.skipped.length > 0)
		parts.push(`Skipped: ${result.skipped.join(", ")}`);
	if (result.deferredBusy !== undefined && result.deferredBusy.length > 0)
		parts.push(`Busy (next tick): ${result.deferredBusy.join(", ")}`);
	if (result.failed !== undefined && result.failed.length > 0)
		parts.push(`Failed: ${result.failed.join(", ")}`);
	return `## Magic Dream\n\n${parts.length > 0 ? parts.join("\n") : "Nothing to do."}`;
}

function lastDreamRunAt(
	db: ContextDatabase,
	projectDir: string,
): number | null {
	try {
		const row = db
			.prepare(
				"SELECT MAX(last_run_at) AS n FROM dream_task_schedule WHERE project_path = ?",
			)
			.get(projectDir) as { n?: number | null } | undefined;
		return typeof row?.n === "number" ? row.n : null;
	} catch {
		return null;
	}
}

export function registerCommands(deps: CommandDeps): () => void {
	const disposers: Array<() => void> = [];
	const add = (
		name: string,
		description: string,
		handler: CommandDefinition["handler"],
		input?: CommandDefinition["input"],
	): void => {
		disposers.push(
			deps.register({
				definitionId: CommandDefinitionId(`${OWNER}.${name}`),
				name,
				description,
				...(input !== undefined ? { input } : {}),
				handler,
			}),
		);
	};

	add(
		"ctx-status",
		"Show Magic Context pressure, history and maintenance state.",
		(invocation) => {
			const session = sessionIdOf(invocation);
			if (session === "")
				return { kind: "error", text: "No session for this command." };
			const maintenance = deps.maintenance();
			return {
				kind: "success",
				text: buildStatusText(deps.db, session, deps.config, {
					version: deps.version,
					dreamer:
						maintenance === undefined
							? undefined
							: {
									lastRunAt: lastDreamRunAt(deps.db, deps.projectDir),
									unsupportedTasks: ["promote-primers"],
								},
				}),
			};
		},
	);

	add(
		"ctx-flush",
		"Apply pending context operations (drops, pins) now.",
		(invocation) => {
			const session = sessionIdOf(invocation);
			if (session === "")
				return { kind: "error", text: "No session for this command." };
			return { kind: "success", text: executeFlush(deps.db, session) };
		},
	);

	add(
		"ctx-embed",
		"Embedding backfill: /ctx-embed start | status.",
		(invocation) => {
			const session = sessionIdOf(invocation);
			if (session === "")
				return { kind: "error", text: "No session for this command." };
			const verb =
				invocation.rawInput.trim().split(/\s+/)[0]?.toLowerCase() ?? "status";
			if (verb !== "start") {
				return {
					kind: "success",
					text: "## Magic Embed\n\nUsage: /ctx-embed start — backfill this session's compartment embeddings.",
				};
			}
			return {
				kind: "success",
				text: deps.lanes.requestEmbedBackfill(session),
			};
		},
		{ hint: "[messages to keep, default 10]" },
	);

	add(
		"ctx-recomp",
		"Rebuild the compressed history from the raw session log.",
		async (invocation) => {
			const session = sessionIdOf(invocation);
			if (session === "")
				return { kind: "error", text: "No session for this command." };
			const text = await deps.lanes.manualFold(session, { fullRebuild: true });
			return { kind: "success", text: `## Magic Recomp\n\n${text}` };
		},
	);

	add(
		"ctx-wrapup",
		"Fold the conversation now, keeping the newest messages raw (default 10).",
		async (invocation) => {
			const session = sessionIdOf(invocation);
			if (session === "")
				return { kind: "error", text: "No session for this command." };
			const parsed = Number.parseInt(invocation.rawInput.trim(), 10);
			const keepMessages =
				Number.isFinite(parsed) && parsed >= 0 && parsed <= 500 ? parsed : 10;
			const text = await deps.lanes.manualFold(session, { keepMessages });
			return { kind: "success", text: `## Magic Wrapup\n\n${text}` };
		},
		{ hint: "[messages to keep, default 10]" },
	);

	add(
		"ctx-dream",
		"Run maintenance tasks now. Optional argument: one task name.",
		async (invocation) => {
			const maintenance = deps.maintenance();
			if (maintenance === undefined) {
				return {
					kind: "error",
					text: "Maintenance is not running for this project (no dreamer model configured — see dreamer.pi / dreamer.dsh).",
				};
			}
			const argument = invocation.rawInput.trim();
			if (argument !== "") {
				const known = argument.split(",")[0]?.trim() ?? "";
				const result = await maintenance.runManual(known as DreamTaskName);
				return {
					kind:
						result.ran.length > 0 || (result.failed?.length ?? 0) === 0
							? "success"
							: "error",
					text: formatManualResult(result),
				};
			}
			const result = await maintenance.runManual();
			return { kind: "success", text: formatManualResult(result) };
		},
		{ hint: "[task name]" },
	);

	add(
		"ctx-dream",
		"Run maintenance tasks now. Optional argument: one task name.",
		async (invocation) => {
			const maintenance = deps.maintenance();
			if (maintenance === undefined) {
				return {
					kind: "error",
					text: "Maintenance is not running for this project (no dreamer model configured — see dreamer.pi / dreamer.dsh).",
				};
			}
			const argument = invocation.rawInput.trim();
			if (argument !== "") {
				const known = argument.split(",")[0]?.trim() ?? "";
				const result = await maintenance.runManual(known as DreamTaskName);
				return {
					kind:
						result.ran.length > 0 || (result.failed?.length ?? 0) === 0
							? "success"
							: "error",
					text: formatManualResult(result),
				};
			}
			const result = await maintenance.runManual();
			return { kind: "success", text: formatManualResult(result) };
		},
		{ hint: "[task name]" },
	);

	return () => {
		for (const dispose of disposers) dispose();
		disposers.length = 0;
	};
}
