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
	type CompartmentInput,
	getCompartments,
	getSessionFacts,
	replaceAllCompartmentState,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
	createScheduler,
	type Scheduler,
} from "@magic-context/core/features/magic-context/scheduler";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta-session";
import type { Tagger } from "@magic-context/core/features/magic-context/tagger";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { maybeAutoEmbedSessionBackfill } from "@magic-context/core/hooks/magic-context/auto-embed-session";
import { log } from "@magic-context/core/shared/logger";
import type { CompactionClaimRegistry } from "../compaction-claim.js";
import type {
	DshHost,
	DshSession,
	PreStepDecision,
	PreStepInfo,
} from "../host.js";
import { autoSearchLane } from "../lanes/auto-search.js";
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
import type {
	FoldOutcome,
	Historian,
} from "../sessions/historian.js";
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
	/** Workspace directory backing project identity (auto-search). */
	readonly projectDir: string;
	/** Learned route windows from overflow recovery (T028); optional in tests. */
	/** Learned-overflow recovery gate (N-02): a pass runs only after the
	 *  previous provider request completed, which proves any recovery fold
	 *  served successfully — release the one-shot claim so the next overflow
	 *  is a new episode, not a dead session. */
	readonly overflowGate?: {
		reset(sessionId: string): void;
	};
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
		const state = this.attachedSessions.get(sessionId);
		state?.unregisterProvider();
		this.attachedSessions.delete(sessionId);
		this.gates.detach(sessionId);
		// N-06: the refusal episode is session state too.
		this.refusalEpisode.delete(sessionId);
		if (state !== undefined) todoDelivery.forget(state.mcSession);
	}

	detachAll(): void {
		for (const state of this.attachedSessions.values())
			state.unregisterProvider();
		this.attachedSessions.clear();
		this.refusalEpisode.clear();
		this.gates.detachAll();
		// The module-level delivery ledger is per-mount process state.
		todoDelivery.detachAll();
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

	/**
	 * Kick the shared embedding backfill for this session (T031).
	 *
	 * The index is what makes auto-search hints and semantic `ctx_search` exist at
	 * all; the core runs it off-thread and coalesces per session. Only REMOTE
	 * backends are triggered: the local runtime (onnx + a worker process) is not
	 * shipped in this bundle, so calling it there would fail on every pass
	 * instead of doing useful work. That packaging gap is declared in PARITY 19.
	 */
	/**
	 * [T069] `/ctx-embed start`: kick the shared embedding backfill for this
	 * session (same gate as the per-pass backfill — remote runtime only).
	 */
	requestEmbedBackfill(sessionId: string): string {
		const provider = this.deps.config.embedding?.provider;
		if (provider === "local" || provider === "off" || provider === undefined) {
			return 'Embeddings are off for this project. This host ships the remote embedding runtime only — set embedding.provider to "remote" and restart.';
		}
		this.maybeBackfillEmbeddings(sessionId);
		return "Backfill requested for this session; semantic ctx_search fills in as chunks embed.";
	}

	private maybeBackfillEmbeddings(mcSession: string): void {
		const provider = this.deps.config.embedding.provider;
		if (provider === "local" || provider === "off") return;
		try {
			const projectIdentity = this.deps.projectDir;
			maybeAutoEmbedSessionBackfill(
				{
					db: this.deps.db,
					projectIdentity,
					ensureRegistered: () => Promise.resolve(),
				},
				mcSession,
			);
		} catch (error) {
			log(
				`[dsh-magic-context] embedding backfill unavailable for ${mcSession}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
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
		// A manual fold owns this session right now (T070/T072: one shared
		// busy set on the compaction claim, consulted by every fold entry
		// point). The managed pass stays out of the way; the next step runs
		// it as usual.
		if (this.deps.claim.foldInFlight(session.id)) return "enter";
		// Reaching a pre-step means the previous request completed (N-02):
		// any recovery fold that served is done; the claim releases and the
		// next overflow gets its own one-shot retry.
		this.deps.overflowGate?.reset(session.id);
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
		this.persistStatusMeta(session.id, reading);
		this.tagProjectedMessages(state.mcSession, projection);
		indexDshSessionHistory(this.deps.db, state.mcSession, projection);
		this.maybeBackfillEmbeddings(state.mcSession);
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
					projectDir: this.deps.projectDir,
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
			// A new pressure episode re-arms the once-per-episode nudges — for
			// THIS session only (N-15: detachAll here re-armed every other
			// session's todo delivery too).
			channel2Lease.reset(state.mcSession);
			todoDelivery.forget(state.mcSession);
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
			projectDir: this.deps.projectDir,
			lanes: [
				autoSearchLane,
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

	/**
	 * [T068] Persist the metered reading every managed pass, so `/ctx-status`
	 * (and any store reader) sees the same numbers the lanes act on: tokens in,
	 * percentage of the effective window, and the idle clock for cache TTL.
	 * Pre-step runs directly after the previous response was served, which is
	 * exactly the semantics `last_response_time` carries on every host.
	 */
	private persistStatusMeta(
		sessionId: string,
		reading: { pressureTokens?: number; contextWindow?: number } | undefined,
	): void {
		if (reading === undefined) return;
		const limit = reading.contextWindow ?? 0;
		const tokens = reading.pressureTokens ?? 0;
		const bands = this.deps.meter.read(sessionId);
		const percentage =
			bands.percentage ?? (limit > 0 ? (tokens / limit) * 100 : 0);
		updateSessionMeta(this.deps.db, sessionId, {
			lastInputTokens: tokens,
			lastContextPercentage: percentage,
			lastResponseTime: Date.now(),
		});
	}

	/**
	 * [T070] Manual fold entry: `/ctx-wrapup` folds the live raw tail keeping
	 * the newest N raw messages; `/ctx-recomp` (`fullRebuild`) first wipes the
	 * published compartments so the fold rebuilds coverage from message one.
	 * The pre-step pass steps around a running manual fold (see `runPass`),
	 * and the busy slot is the compaction claim's (T072) — a `/compact` in
	 * flight and a command fold serialize on the same guard.
	 */
	async manualFold(
		dshSessionId: string,
		opts: {
			readonly fullRebuild?: boolean;
			readonly keepMessages?: number;
		} = {},
	): Promise<string> {
		const state = this.attachedSessions.get(dshSessionId);
		const session = this.deps.host.getSession(dshSessionId);
		if (state === undefined || session === undefined) {
			return "Magic Context does not manage this session yet (no managed pass has run in it).";
		}
		if (!this.deps.claim.beginFold(dshSessionId)) {
			return "A manual fold is already running for this session.";
		}
		try {
			const projection = projectDshSessionLog(this.readRecords(dshSessionId));
			// N-11: a full rebuild wipes the published compartments so the fold
			// rebuilds coverage from message one — but if the fold then produces
			// no replacement (no route, aux error, truncated reply: null or a
			// throw), other hosts roll the wipe back rather than silently losing
			// history until pressure re-folds everything. Snapshot the published
			// state so the wipe is conditional on the fold succeeding.
			let rebuild:
				| {
						compartments: CompartmentInput[];
						facts: Array<{ category: string; content: string }>;
				  }
				| undefined;
			if (opts.fullRebuild === true) {
				const published = getCompartments(this.deps.db, state.mcSession);
				if (published.length === 0) {
					return "Nothing to rebuild: this session has no published compartments.";
				}
				rebuild = {
					compartments: published.map((compartment) => ({
						sequence: compartment.sequence,
						startMessage: compartment.startMessage,
						endMessage: compartment.endMessage,
						startMessageId: compartment.startMessageId,
						endMessageId: compartment.endMessageId,
						startBlockIndex: compartment.startBlockIndex,
						endBlockIndex: compartment.endBlockIndex,
						title: compartment.title,
						content: compartment.content,
						p1: compartment.p1,
						p2: compartment.p2,
						p3: compartment.p3,
						p4: compartment.p4,
						importance: compartment.importance,
						episodeType: compartment.episodeType,
					})),
					facts: getSessionFacts(this.deps.db, state.mcSession).map(
						(fact) => ({
							category: fact.category,
							content: fact.content,
						}),
					),
				};
				replaceAllCompartmentState(this.deps.db, state.mcSession, [], []);
			}
			const restoreRebuild = (): void => {
				if (rebuild === undefined) return;
				replaceAllCompartmentState(
					this.deps.db,
					state.mcSession,
					rebuild.compartments,
					rebuild.facts,
				);
			};
			const window = this.deps.host.pressure(dshSessionId)?.contextWindow;
			const protectedTailTokens =
				opts.keepMessages !== undefined
					? projection.records
							.filter((record) => !isAdapterSurfaceId(record.messageId))
							.slice(-opts.keepMessages)
							.reduce(
								(total, record) =>
									total + Math.ceil((record.text?.length ?? 0) / 4),
								0,
							)
					: protectedTailBudget(this.deps.config, window, true);
			let fold: FoldOutcome | null;
			try {
				fold = await this.deps.historian.fold({
					session,
					mcSession: state.mcSession,
					projection,
					rules: state.rules,
					subagent: state.rules.role === "subagent",
					protectedTailTokens,
				});
			} catch (error) {
				// N-11: the fold threw after the wipe — put the published history
				// back and refresh the head to the restored state before
				// rethrowing, so a failed rebuild is not a knowledge gap.
				restoreRebuild();
				await this.deps.head.refresh(session, {
					mcSession: state.mcSession,
					subagent: state.rules.role === "subagent",
					projection,
					managedChangeLanded: true,
				});
				throw error;
			}
			if (fold === null) restoreRebuild();
			await this.deps.head.refresh(session, {
				mcSession: state.mcSession,
				subagent: state.rules.role === "subagent",
				projection,
				managedChangeLanded: true,
			});
			if (fold === null) {
				return "Nothing to fold: the eligible window is empty or no historian route is configured.";
			}
			return `Folded messages ${fold.fromOrdinal}-${fold.toOrdinal} into a compartment. The new history lands on the next step.`;
		} finally {
			this.deps.claim.endFold(dshSessionId);
		}
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
