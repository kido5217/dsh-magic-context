/**
 * Maintenance scheduler (T053) — the DSH clock for the shared dreamer.
 *
 * The scheduler itself belongs to the core (`runDueTasksForProject`: seeding,
 * cron windows, gates, leases, retries, run records — contract
 * `contracts/maintenance.md`). This module contributes only what a DSH
 * process must contribute: a host-managed repeating tick (a plain interval
 * whose disposer is registered as a plugin effect), the
 * boot-quiet delay (a sibling process finishes startup migrations first),
 * deterministic per-project jitter (no writer burst when several projects
 * share a machine), one tick in flight at a time, and total error
 * containment — an unhandled rejection terminates a DSH app.
 *
 * Missed windows need no special casing here: the core advances `next_due_at`
 * from the run's completion, so a window missed during downtime runs exactly
 * once on the first post-quiet tick and never replays every missed slot.
 */

import type {
	DreamTaskRuntimeConfig,
	TaskExecutor,
} from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import { runDueTasksForProject } from "@magic-context/core/features/magic-context/dreamer/task-scheduler";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";

/** The contract's tick cadence: one minute. Task timing is cron-gated, so a
 *  finer tick only bounds lateness; the cost is a couple of cheap reads. */
export const MAINTENANCE_TICK_MS = 60_000;

/** Jitter slot width: a project's first tick is offset inside the first tick
 *  window after the quiet period, deterministically by project identity. */
export const MAINTENANCE_JITTER_SLOT_MS = 60_000;

/** One project the maintenance lane serves (the adapter registers one per
 *  opened project; several worktrees may share a store). */
export interface MaintenanceProject {
	readonly projectIdentity: string;
	/** Runtime configs from `buildDreamTaskRuntimeConfigs` (shared defaults). */
	readonly tasks: readonly DreamTaskRuntimeConfig[];
	/** The transport dispatch (T054/T055/T057 mount this). */
	readonly executor: TaskExecutor;
	readonly projectMemoryEnabled?: boolean;
	readonly smartNotesEnabled?: boolean;
}

export interface MaintenanceSchedulerOptions {
	/** The shared store. */
	readonly db: ContextDatabase;
	/** Host-managed repeating timer: returns a disposer. The mount backs
	 *  this with a plain interval registered as a plugin effect (DSH exposes
	 *  no timer service; research R-Dreamer). */
	readonly setInterval: (callback: () => void, ms: number) => () => void;
	/** Remaining boot-quiet delay in ms (core `bootQuietRemainingMs`). */
	readonly bootQuietRemainingMs: () => number;
	readonly now?: () => number;
	/** Contained failures surface here (core logger at the mount). */
	readonly onError?: (where: string, error: unknown) => void;
	readonly tickIntervalMs?: number;
	readonly jitterSlotMs?: number;
}

/** Deterministic small hash (FNV-1a) — jitter must be stable across process
 *  restarts so a project keeps its slot. */
function jitterFor(projectIdentity: string, slotMs: number): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < projectIdentity.length; i += 1) {
		h ^= projectIdentity.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (Math.abs(h >>> 0) % Math.max(1, Math.floor(slotMs / 1000))) * 1000;
}

export class MaintenanceScheduler {
	private readonly options: MaintenanceSchedulerOptions;
	private readonly projects = new Map<string, MaintenanceProject>();
	/** Per-project instant after which ticking may start (quiet + jitter). */
	private readonly quietUntil = new Map<string, number>();
	private disposer: (() => void) | undefined;
	private inFlight = false;
	private started = false;

	constructor(options: MaintenanceSchedulerOptions) {
		this.options = options;
	}

	/** Register (or replace) a project. Before `start` the quiet clock is not
	 *  yet armed; `start` arms it for every registered project. */
	registerProject(project: MaintenanceProject): void {
		this.projects.set(project.projectIdentity, project);
	}

	unregisterProject(projectIdentity: string): void {
		this.projects.delete(projectIdentity);
		this.quietUntil.delete(projectIdentity);
	}

	/** Arm the interval and the per-project quiet+jitter clock. Idempotent. */
	start(): void {
		if (this.started) return;
		this.started = true;
		const now = this.now();
		const quiet = Math.max(0, this.options.bootQuietRemainingMs());
		const slot = this.options.jitterSlotMs ?? MAINTENANCE_JITTER_SLOT_MS;
		for (const identity of this.projects.keys())
			this.quietUntil.set(identity, now + quiet + jitterFor(identity, slot));
		this.disposer = this.options.setInterval(() => {
			void this.runTick("interval");
		}, this.options.tickIntervalMs ?? MAINTENANCE_TICK_MS);
	}

	stop(): void {
		this.disposer?.();
		this.disposer = undefined;
		this.started = false;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/**
	 * One tick: every registered project past its quiet instant runs its due
	 * tasks. No overlap: a tick while one is in flight is dropped (the next
	 * minute will come). No rejection escapes; no project failure stops the
	 * others. Returns the number of tasks executed (0 while quiet).
	 */
	async runTick(_origin: "interval" | "manual" = "interval"): Promise<number> {
		if (this.inFlight) return 0;
		this.inFlight = true;
		let ran = 0;
		try {
			const now = this.now();
			for (const [identity, project] of [...this.projects]) {
				try {
					let armedAt = this.quietUntil.get(identity);
					if (armedAt === undefined) {
						// Registered after start(): arm its quiet clock now.
						armedAt =
							now +
							Math.max(0, this.options.bootQuietRemainingMs()) +
							jitterFor(
								identity,
								this.options.jitterSlotMs ?? MAINTENANCE_JITTER_SLOT_MS,
							);
						this.quietUntil.set(identity, armedAt);
						continue;
					}
					if (now < armedAt) continue;
					ran += await runDueTasksForProject({
						db: this.options.db,
						projectIdentity: identity,
						tasks: project.tasks,
						executor: project.executor,
						now,
						...(project.projectMemoryEnabled !== undefined
							? { projectMemoryEnabled: project.projectMemoryEnabled }
							: {}),
						...(project.smartNotesEnabled !== undefined
							? { smartNotesEnabled: project.smartNotesEnabled }
							: {}),
					});
				} catch (error) {
					this.options.onError?.(`tick:${identity}`, error);
				}
			}
		} catch (error) {
			this.options.onError?.("tick", error);
		} finally {
			this.inFlight = false;
		}
		return ran;
	}
}
