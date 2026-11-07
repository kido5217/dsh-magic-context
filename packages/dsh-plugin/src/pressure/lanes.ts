/**
 * Pressure lanes — the per-session pass at the pre-step gate (T019).
 *
 * One pre-step listener runs the whole management pass, re-reading pressure
 * from the meter on EVERY pass (band switches — model switch, window change —
 * take effect the very next step, no cached state):
 *
 * - below `force`: queued drops ride the next managed opportunity — the pass
 *   itself (T016). New auto-queues respect the core scheduler's execute/defer
 *   discipline; agent `ctx_reduce` stamps apply regardless.
 * - `force` … `refuse`: historian fold first (fold-before-enter); a session
 *   with nothing to fold still proceeds below the wall.
 * - at/over `refuse`: fold, and if nothing can fold, `reject` the step AND
 *   append a plugin-sourced user/message notice — DSH's reject carries no
 *   reason field, so the user-visible explanation is its own durable node
 *   (appended at most once per refusal episode: consecutive refusals don't
 *   spam the surface; entering an `enter` decision closes the episode).
 *
 * Fail-closed (FR-004): any management error (store busy/unavailable, closed
 * store) refuses the step with the same notice path — an unmanaged proceed is
 * never an option.
 *
 * Claim integration choice (documented): a session joins the compaction claim
 * at FIRST ATTACH (first pre-step), not at first managed change — from that
 * moment MC treats the session as managed, and a concurrent host fold racing
 * the first pass is exactly the double-provider bug the claim exists to
 * prevent.
 */

import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import {
	createScheduler,
	type Scheduler,
} from "@magic-context/core/features/magic-context/scheduler";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import type { Tagger } from "@magic-context/core/features/magic-context/tagger";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { log } from "@magic-context/core/shared/logger";
import type { CompactionClaimRegistry } from "../compaction-claim.js";
import type {
	DshHost,
	DshSession,
	PreStepDecision,
	PreStepInfo,
} from "../host.js";
import { cavemanLane } from "../lanes/caveman.js";
import { emergencyDropLane } from "../lanes/emergency.js";
import { runLanePass } from "../lanes/engine.js";
import { LaneGates, rebuildPermission } from "../lanes/gating.js";
import { dedupLane, injectionStripLane } from "../lanes/heuristics.js";
import { noteNudgeLane } from "../lanes/note-nudge.js";
import { supersessionLane } from "../lanes/reclaim.js";
import { channel2Lease, reduceNudgeLane } from "../lanes/reduce-nudge.js";
import { temporalLane } from "../lanes/temporal.js";
import { todoDelivery, todoLane } from "../lanes/todo.js";
import type { Historian } from "../sessions/historian.js";
import { indexDshSessionHistory } from "../sessions/history-index.js";
import type { SessionMapping } from "../sessions/mapping.js";
import { type McRoleRules, rulesForRole } from "../sessions/subagent-rules.js";
import { indexToolCalls } from "../sessions/tool-identity.js";
import {
	type DropApplier,
	protectedTailBudget,
	splitProtectedTail,
} from "../surface/apply-operations.js";
import { resolveDshBoundary } from "../surface/boundary.js";
import {
	type DshLogProjection,
	type DshSessionLogReader,
	isAdapterSurfaceId,
	projectDshSessionLog,
	registerDshRawHistoryProvider,
} from "../surface/dsh-session-log.js";
import type { HeadManager } from "../surface/head.js";
import type { ManagedEdits } from "../surface/managed-edits.js";
import type { PressureMeter } from "./meter.js";

const REFUSAL_NOTICE =
	"Magic Context refused this step: the next request sits at or above the context limit and there is nothing left to fold that would make it fit. Your message is still in history. Next move: let a fold pass run (older content is summarized on the next step once enough history is foldable) or run /compact, then resend.";

interface AttachedSession {
	readonly mcSession: string;
	readonly rules: McRoleRules;
	readonly unregisterProvider: () => void;
}

export interface PressureLanesDeps {
	readonly host: DshHost;
	readonly db: ContextDatabase;
	readonly config: MagicContextConfig;
	readonly mapping: SessionMapping;
	readonly claim: CompactionClaimRegistry;
	readonly meter: PressureMeter;
	readonly head: HeadManager;
	readonly historian: Historian;
	readonly dropApplier: DropApplier;
	readonly managedEdits: ManagedEdits;
	/** Learned route windows from overflow recovery (T028); optional in tests. */
	readonly overflowWindows?: {
		effectiveWindow(
			sessionId: string,
			advertised: number | undefined,
		): number | undefined;
	};
	readonly readSessionLog: DshSessionLogReader;
}

export class PressureLanes {
	private readonly attachedSessions = new Map<string, AttachedSession>();
	private readonly refusalEpisode = new Set<string>();
	private readonly tagger: Tagger = createTagger();
	private readonly scheduler: Scheduler;
	private readonly gates = new LaneGates();

	constructor(private readonly deps: PressureLanesDeps) {
		this.scheduler = createScheduler({
			executeThresholdPercentage: deps.config.execute_threshold_percentage,
			...(deps.config.execute_threshold_tokens !== undefined
				? { executeThresholdTokens: deps.config.execute_threshold_tokens }
				: {}),
		});
	}

	/** The pre-step listener mounted on the host. */
	readonly onPreStep = async (info: PreStepInfo): Promise<PreStepDecision> => {
		const session = this.deps.host.getSession(info.sessionId);
		if (session === undefined) return "enter";
		let state = this.attachedSessions.get(info.sessionId);
		try {
			if (state === undefined) state = this.attach(session);
			return await this.runPass(session, state, info);
		} catch (error) {
			// FR-004: management failed (store busy/unavailable/closed) ⇒ refuse.
			// Never send an unmanaged request.
			log(
				`[dsh-magic-context] management pass failed for ${info.sessionId}; refusing step fail-closed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return await this.refuse(
				session,
				info.sessionId,
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	detach(sessionId: string): void {
		this.attachedSessions.get(sessionId)?.unregisterProvider();
		this.attachedSessions.delete(sessionId);
		this.gates.detach(sessionId);
	}

	detachAll(): void {
		for (const state of this.attachedSessions.values())
			state.unregisterProvider();
		this.attachedSessions.clear();
		this.refusalEpisode.clear();
		this.gates.detachAll();
	}

	private attach(session: DshSession): AttachedSession {
		const mapping = this.deps.mapping.upsert(session.header);
		this.deps.claim.attach(session.id);
		const unregisterProvider = registerDshRawHistoryProvider(session.id, () =>
			projectDshSessionLog(this.readRecords(session.id)),
		);
		const state: AttachedSession = {
			mcSession: mapping.mcSession,
			rules: rulesForRole(mapping.role),
			unregisterProvider,
		};
		this.attachedSessions.set(session.id, state);
		return state;
	}

	private readRecords(dshSessionId: string) {
		return this.deps.readSessionLog(dshSessionId) ?? [];
	}

	/**
	 * Durable ids of the verbatim protected tail (T029).
	 *
	 * The core boundary is authoritative when it resolves: it fences tool-call
	 * arcs and honours the compartment anchor, which a pure token budget cannot.
	 * The budget stays as the fallback for the cases the resolver cannot price
	 * (no window, no raw provider, a store hiccup) — never as the primary rule.
	 */
	private protectedMessageIds(
		mcSession: string,
		session: DshSession,
		projection: DshLogProjection,
		reading: { pressureTokens?: number; contextWindow?: number } | undefined,
		budget: number,
		emergency: boolean,
	): ReadonlySet<string> {
		const boundary = resolveDshBoundary({
			db: this.deps.db,
			config: this.deps.config,
			mcSession,
			projection,
			contextWindow: reading?.contextWindow,
			percentage: (() => {
				const value = this.deps.meter.read(session.id).percentage;
				return value === null ? undefined : value;
			})(),
			pressureTokens: reading?.pressureTokens,
			emergency,
		});
		if (boundary !== undefined) return boundary.protectedMessageIds;
		const tail = splitProtectedTail(
			projection.records.filter(
				(record) => !isAdapterSurfaceId(record.messageId),
			),
			budget,
		).protectedTail;
		return new Set(tail.map((record) => record.messageId));
	}

	private async runPass(
		session: DshSession,
		state: AttachedSession,
		info: PreStepInfo,
	): Promise<PreStepDecision> {
		const lane = this.deps.meter.lane(session.id); // fresh EVERY pass
		const measured = this.deps.host.pressure(session.id);
		// A route that already rejected one request is priced against what it
		// actually accepts, not what it advertises (T028).
		const learnedWindow = this.deps.overflowWindows?.effectiveWindow(
			session.id,
			measured?.contextWindow,
		);
		const reading =
			measured === undefined
				? undefined
				: {
						...measured,
						...(learnedWindow !== undefined
							? { contextWindow: learnedWindow }
							: {}),
					};
		const projection = projectDshSessionLog(this.readRecords(session.id));
		this.tagProjectedMessages(state.mcSession, projection);
		indexDshSessionHistory(this.deps.db, state.mcSession, projection);
		// Host fact (0.2.2-rc.1, observed live): on the very first step of a fresh
		// session the pre-step fires before the host appends the first
		// system/message, so a plugin surface append here would sit above the
		// protected first surface head and the reopen validator would reject the
		// log ("system/message requires a protected first surface head"). Bookkeeping
		// (tags, history index) above is not surface-visible and stays; every managed
		// write defers to the next step, where the host head exists.
		if (
			info.turn === 1 &&
			info.step === 1 &&
			session.surfaceNodes().length === 0
		)
			return "enter";
		const budget = protectedTailBudget(
			this.deps.config,
			reading?.contextWindow,
			lane === "force" || lane === "refuse",
		);
		const headContext = {
			mcSession: state.mcSession,
			subagent: state.rules.role === "subagent",
			projection,
		};

		if (lane === "force" || lane === "refuse") {
			// Subagent emergency fold (T035): a child at the wall tries every open
			// reclaim lane FIRST (it may still have droppable tool output), and
			// only when none can act does it take the DSH-imposed divergence —
			// one historian fold, which summarizes rather than deletes. On a
			// primary the fold stays first: its own history is the valuable one
			// and summarizing it early protects the prefix.
			if (lane === "refuse" && state.rules.role === "subagent") {
				const emergencyPass = await runLanePass(this.deps.managedEdits, {
					session,
					mcSession: state.mcSession,
					projection,
					rules: state.rules,
					band: lane,
					permission: rebuildPermission({ schedulerAllows: false, band: lane }),
					config: this.deps.config,
					db: this.deps.db,
					protectedMessageIds: this.protectedMessageIds(
						state.mcSession,
						session,
						projection,
						reading,
						budget,
						true,
					),
					lanes: [emergencyDropLane, supersessionLane],
					gates: this.gates,
				});
				if (emergencyPass.changed) {
					this.refusalEpisode.delete(session.id);
					return "enter";
				}
			}
			const fold = await this.deps.historian.fold({
				session,
				mcSession: state.mcSession,
				projection,
				rules: state.rules,
				subagent: headContext.subagent,
				protectedTailTokens: budget,
			});
			if (fold !== null) {
				this.refusalEpisode.delete(session.id);
				return "enter";
			}
			if (lane === "refuse") return await this.refuse(session, session.id);
			// Force band with nothing foldable: below the wall, proceed.
			this.refusalEpisode.delete(session.id);
			return "enter";
		}

		// Below the execute band a new pressure episode begins: routine lanes
		// re-arm (contract: episode state resets when pressure falls below
		// execute). Nothing below the band may apply new edits anyway.
		if (lane === "below-execute") {
			this.gates.resetEpisode(session.id);
			// A new pressure episode re-arms the once-per-episode nudges.
			channel2Lease.reset(state.mcSession);
			todoDelivery.detachAll();
		}
		let changed = false;
		const autoQueue =
			lane === "execute" && this.schedulerAllows(session.id, reading);
		const drop = await this.deps.dropApplier.applyQueuedDrops({
			session,
			mcSession: state.mcSession,
			projection,
			autoQueue,
			protectedTailTokens: budget,
		});
		if (drop !== null) changed = true;
		// Routine lanes (T022/T023/T024): the engine owns gating, selection and
		// one bracket per lane; a lane failure stays contained to its own edit.
		const permission = rebuildPermission({
			schedulerAllows: autoQueue,
			band: lane,
			managedChangeLanded: changed,
		});
		const lanePass = await runLanePass(this.deps.managedEdits, {
			session,
			mcSession: state.mcSession,
			projection,
			rules: state.rules,
			band: lane,
			permission,
			config: this.deps.config,
			db: this.deps.db,
			protectedMessageIds: new Set(
				splitProtectedTail(
					projection.records.filter(
						(record) => !isAdapterSurfaceId(record.messageId),
					),
					budget,
				).protectedTail.map((record) => record.messageId),
			),
			pressure: {
				...(reading?.pressureTokens !== undefined
					? { pressureTokens: reading.pressureTokens }
					: {}),
				...(reading?.contextWindow !== undefined
					? { contextWindow: reading.contextWindow }
					: {}),
				...(() => {
					const percentage = this.deps.meter.read(session.id).percentage;
					return percentage !== null ? { percentage } : {};
				})(),
			},
			lanes: [
				dedupLane,
				injectionStripLane,
				temporalLane,
				supersessionLane,
				cavemanLane,
				noteNudgeLane,
			],
			gates: this.gates,
		});
		if (lanePass.changed) changed = true;
		await this.deps.head.refresh(session, {
			...headContext,
			managedChangeLanded: changed,
		});
		this.refusalEpisode.delete(session.id);
		return "enter";
	}

	/** Core scheduler execute/defer for NEW auto-queues (cache-TTL discipline). */
	private schedulerAllows(
		sessionId: string,
		reading: { pressureTokens?: number; contextWindow?: number } | undefined,
	): boolean {
		const bands = this.deps.meter.read(sessionId);
		if (bands.percentage === null) return false;
		return (
			this.scheduler.shouldExecute(
				getOrCreateSessionMeta(this.deps.db, sessionId),
				{
					percentage: bands.percentage,
					inputTokens: reading?.pressureTokens ?? 0,
				},
				undefined,
				sessionId,
				undefined,
				reading?.contextWindow,
			) === "execute"
		);
	}

	private tagProjectedMessages(
		mcSession: string,
		projection: DshLogProjection,
	): void {
		for (const message of projection.rawMessages) {
			if (isAdapterSurfaceId(message.id)) continue;
			if (this.tagger.getTag(mcSession, message.id, "message") !== undefined)
				continue;
			const placed = projection.byMessageId.get(message.id);
			this.tagger.assignTag(
				mcSession,
				message.id,
				"message",
				placed?.bytes ?? 0,
				this.deps.db,
			);
		}
	}

	private async refuse(
		session: DshSession,
		sessionId: string,
		cause?: string,
	): Promise<PreStepDecision> {
		const episodeOpen = this.refusalEpisode.has(sessionId);
		this.refusalEpisode.add(sessionId);
		const band = this.deps.host.pressure(sessionId);
		log(
			`[dsh-magic-context] refusing step for ${sessionId}: band ${band?.pressureTokens ?? "?"}/${band?.contextWindow ?? "?"}${cause !== undefined ? ` (management error: ${cause})` : ""}`,
		);
		if (!episodeOpen) {
			const text =
				cause === undefined
					? REFUSAL_NOTICE
					: `${REFUSAL_NOTICE}\n\nThis refusal was fail-closed after a management error (${cause}); the context band itself may be lower than described above. See the magic-context log for detail.`;
			try {
				// Empty surface ⇒ the host's first system/message is not logged yet
				// (first step of a fresh session); a notice now would precede the
				// protected first surface head and corrupt the log on reopen.
				if (session.surfaceNodes().length > 0)
					await session.appendTail([{ type: "text", text }]);
			} catch (error) {
				log(
					`[dsh-magic-context] refusal notice could not be appended for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return "reject";
	}
}
