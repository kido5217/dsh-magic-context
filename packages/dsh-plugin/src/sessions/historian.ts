/**
 * Historian pass (T018) — the summarized-history fold at the DSH seam.
 *
 * Shape (contract row "Auxiliary LLM calls"): the model call runs OUTSIDE any
 * managed bracket, request-only through `host.llmStream` with purpose
 * `'magic-context'` — no durable identity, and a failed call touches nothing:
 * the next pass simply retries. Only a completed summary opens a bracket:
 * one `runManagedChange("fold")` whose decision writes the compartment
 * through the core compartment storage (`appendCompartments`, the same
 * publish path the core compartment runner uses) and drains the drop queue
 * (`executeFlush`), and whose effect is the head re-baseline collapsing the
 * covered seq range into a fresh head node.
 *
 * Coverage bookkeeping doubles as the resume guard: a fold always starts
 * after `getLastCompartmentEndMessage`, so a restart re-reads the store, sees
 * the covered range, and never re-summarizes folded history.
 *
 * Side channels (T045): the response is parsed with the core compartment
 * parser, so a protocol-shaped reply yields multiple tiered compartments plus
 * `<facts>` / `<user_observations>` / `<events>` / `<primer_candidates>` side
 * blocks. Everything the pass extracts is written inside ONE `BEGIN IMMEDIATE`
 * decision transaction — compartments, fact promotion through the core's
 * durable promotion path (gated on `memory.enabled` + `memory.auto_promote` +
 * the project's subagent rule set, exactly as the core runner gates it),
 * user-memory candidate inserts (gated on the dreamer's observation
 * collection), event storage, and at most one primer candidate — so a crash
 * can never advance the coverage floor past facts that never became project
 * memories. A plain-text reply (no protocol tags) degrades to the v1 flat
 * single compartment. Deferred: seed examples / session references / project
 * memory dedup blocks in the prompt, and the two-pass editor pipeline
 * (host-agnostic core-runner work; the ledger tracks it).
 */
import { randomUUID } from "node:crypto";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import { insertCompartmentEvents } from "@magic-context/core/features/magic-context/compartment-events";
import {
	appendCompartments,
	type CompartmentInput,
	getCompartments,
	getLastCompartmentEndMessage,
	type SessionFact,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { userObservationCollectionEnabled } from "@magic-context/core/features/magic-context/dreamer/task-config";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { promoteSessionFactsDurable } from "@magic-context/core/features/magic-context/memory/promotion";
import { ModuleMemoryAuthorityError } from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { insertPrimerCandidates } from "@magic-context/core/features/magic-context/storage-primers";
import { insertUserMemoryCandidates } from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	type ParsedCompartmentOutput,
	parseCompartmentOutput,
} from "@magic-context/core/hooks/magic-context/compartment-parser";
import {
	buildCompartmentAgentPrompt,
	COMPARTMENT_AGENT_SYSTEM_PROMPT,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { executeFlush } from "@magic-context/core/hooks/magic-context/execute-flush";
import { getHarness } from "@magic-context/core/shared/harness";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { DshHost, DshSession } from "../host.js";
import { splitProtectedTail } from "../surface/apply-operations.js";
import type { DshLogProjection } from "../surface/dsh-session-log.js";
import { isAdapterSurfaceId } from "../surface/dsh-session-log.js";
import type { HeadManager } from "../surface/head.js";
import type { ManagedEdits, ShadowInfo } from "../surface/managed-edits.js";
import type { McRoleRules } from "./subagent-rules.js";

export interface HistorianRoute {
	readonly provider: string;
	readonly model: string;
	/**
	 * Routed model advertises `image` input (updated by the host's step
	 * observer). Unknown ⇒ absent/false: murals and every other image payload
	 * stay text-only (FR-006).
	 */
	readonly imageInput?: boolean;
}

export interface FoldRequest {
	readonly session: DshSession;
	readonly mcSession: string;
	readonly projection: DshLogProjection;
	readonly rules: McRoleRules;
	readonly subagent: boolean;
	/** Protected-tail budget in tokens (already band-adjusted by the caller). */
	readonly protectedTailTokens: number;
}

export interface FoldOutcome {
	readonly shadow: ShadowInfo;
	readonly fromOrdinal: number;
	readonly toOrdinal: number;
}

export class Historian {
	private loggedMissingRoute = false;

	constructor(
		private readonly host: DshHost,
		private readonly db: ContextDatabase,
		private readonly config: MagicContextConfig,
		private readonly managedEdits: ManagedEdits,
		private readonly head: HeadManager,
		private readonly route: HistorianRoute | undefined,
		private readonly projectDir: string,
	) {}

	/**
	 * One fold pass. Returns null (surface untouched, retry later) when the
	 * window holds nothing foldable, no aux route is configured, or the model
	 * call fails.
	 *
	 * Coverage coordinates: compartment `startMessage`/`endMessage` hold DSH
	 * durable surface SEQs (the coordinate that survives shadowing and
	 * replacement — projection positions do not). `getLastCompartmentEndMessage`
	 * returns -1 for a fresh session, so "foldable" is exactly the records
	 * whose seq exceeds the covered boundary.
	 */
	async fold(request: FoldRequest): Promise<FoldOutcome | null> {
		const { session, mcSession, projection } = request;
		const coveredThrough = getLastCompartmentEndMessage(this.db, mcSession);
		// Real conversation folds; adapter nodes ([dropped §N§] clusters, the
		// head) are derived artifacts: never summarized again, but subsumed by
		// the fold once coverage passes them (the store holds their truth).
		const candidates = projection.records.filter(
			(record) =>
				record.seq > coveredThrough && !isAdapterSurfaceId(record.messageId),
		);
		const adapterSeqs = projection.records
			.filter((record) => isAdapterSurfaceId(record.messageId))
			.map((record) => record.seq);
		const { eligible } = splitProtectedTail(
			candidates,
			request.protectedTailTokens,
		);
		if (eligible.length === 0) return null;
		if (this.route === undefined) {
			if (!this.loggedMissingRoute) {
				this.loggedMissingRoute = true;
				log(
					"[dsh-magic-context] no historian route configured; folds deferred (pressure will keep refusing at the wall)",
				);
			}
			return null;
		}

		const fromSeq = eligible[0]!.seq;
		const toSeq = eligible[eligible.length - 1]!.seq;
		const memoryEnabled = this.config.memory?.enabled !== false;
		const observationsRequested = userObservationCollectionEnabled(
			this.config.dreamer,
		);
		const pass = await this.runPass(
			`Messages ${String(fromSeq)}-${String(toSeq)}:\n\n${eligible
				.map(
					(record) => `[${String(record.seq)}] ${record.role}: ${record.text}`,
				)
				.join("\n")}`,
			memoryEnabled,
			observationsRequested,
		);
		if (pass === null) return null;
		const { output: parsed, raw } = pass;
		const head = this.head.peek(mcSession);
		const coveredSet = new Set<number>([
			...eligible.map((record) => record.seq),
			...adapterSeqs,
			// The fold consumes BOTH head nodes: the new baseline replaces them
			// (the delta is the fold's own output position for new bytes).
			...(head !== undefined
				? head.deltaSeq === undefined
					? [head.seq]
					: [head.seq, head.deltaSeq]
				: []),
		]);
		const coveredSeqs = projection.records
			.filter((record) => coveredSet.has(record.seq))
			.map((record) => record.seq);
		const changeId = `mc-fold-${randomUUID()}`;
		const sequence = getCompartments(this.db, mcSession).length + 1;
		const rows = this.compartmentRows(
			parsed,
			raw,
			eligible,
			fromSeq,
			toSeq,
			sequence,
		);
		const projectIdentity =
			resolveProjectIdentityForSession(this.projectDir) ?? "";
		// Same gate stack as the core runner (Issue #44 parity), narrowed by the
		// project's subagent rule set for this session's role.
		const promotionActive =
			projectIdentity !== "" &&
			memoryEnabled &&
			this.config.memory?.auto_promote !== false &&
			request.rules.summarizerMemoryWrites;
		const shadow = await this.managedEdits.runManagedChange(
			"fold",
			changeId,
			mcSession,
			{
				decision: async () => {
					// One write-locked transaction: compartments, queued-drop flush,
					// and every side channel commit or roll back together, so the
					// coverage floor can never advance past facts that failed to
					// become project memories.
					this.db.exec("BEGIN IMMEDIATE");
					try {
						appendCompartments(this.db, mcSession, rows);
						// Drops queued for messages the fold now covers are settled by
						// the fold itself: drain the queue through the core flush path.
						executeFlush(this.db, mcSession);
						if (promotionActive && parsed.facts.length > 0) {
							const now = Date.now();
							const facts: SessionFact[] = parsed.facts.map((fact) => ({
								id: 0,
								sessionId: mcSession,
								category: fact.category,
								content: fact.content,
								createdAt: now,
								updatedAt: now,
							}));
							try {
								const promotion = promoteSessionFactsDurable(
									this.db,
									mcSession,
									projectIdentity,
									facts,
								);
								if (promotion.factsPromoted > 0) {
									sessionLog(
										mcSession,
										`fact promotion: ${String(promotion.factsPromoted)} fact(s) -> project memory`,
									);
								}
							} catch (error) {
								if (error instanceof ModuleMemoryAuthorityError) {
									// Fact promotion is a side channel: a module-managed
									// project must not block history compaction.
									sessionLog(
										mcSession,
										"fact promotion skipped: project memory is module-managed; compartments publish without facts",
									);
								} else {
									throw error;
								}
							}
						}
						if (observationsRequested && parsed.userObservations.length > 0) {
							// Privacy gate lives in `observationsRequested` (dreamer
							// not runnable => candidates would never be reviewed).
							try {
								insertUserMemoryCandidates(
									this.db,
									parsed.userObservations.map((content) => ({
										content,
										sessionId: mcSession,
										sourceCompartmentStart: fromSeq,
										sourceCompartmentEnd: toSeq,
									})),
								);
							} catch (error) {
								sessionLog(
									mcSession,
									"failed to store user memory candidates:",
									error,
								);
							}
						}
						if (parsed.events.length > 0) {
							// Events are stored, not rendered: independent of memory
							// flags, best-effort, re-derivable.
							try {
								const persistedIds = getCompartments(this.db, mcSession)
									.slice(-rows.length)
									.map((c) => c.id);
								insertCompartmentEvents(
									this.db,
									mcSession,
									parsed.events,
									persistedIds,
								);
							} catch (error) {
								sessionLog(
									mcSession,
									"failed to store compartment events:",
									error,
								);
							}
						}
						// Core stores at most one primer occurrence per published
						// chunk; recall-only side table (dashboard + ctx_search).
						const [primer] = parsed.primerCandidates;
						if (projectIdentity !== "" && primer !== undefined) {
							try {
								insertPrimerCandidates(this.db, [
									{
										projectPath: projectIdentity,
										harness: getHarness(),
										sessionId: mcSession,
										question: primer.question,
										sourceCompartmentStart: fromSeq,
										sourceCompartmentEnd: toSeq,
										sourceStartMessageId: eligible[0]!.messageId,
										sourceEndMessageId:
											eligible[eligible.length - 1]!.messageId,
										sourceMessageTime: Date.now(),
									},
								]);
							} catch (error) {
								sessionLog(
									mcSession,
									"failed to store primer candidate:",
									error,
								);
							}
						}
						this.db.exec("COMMIT");
					} catch (error) {
						try {
							this.db.exec("ROLLBACK");
						} catch {
							// Transaction already unwound by the driver.
						}
						throw error;
					}
					return { fromSeq, toSeq };
				},
				effect: () =>
					this.head.foldRebaselineEffect(
						session,
						{
							mcSession,
							subagent: request.subagent,
							projection: request.projection,
						},
						coveredSeqs,
					),
			},
		);
		return { shadow, fromOrdinal: fromSeq, toOrdinal: toSeq };
	}

	/**
	 * Turn one parsed pass into durable compartment rows. Protocol-shaped
	 * replies produce one row per `<compartment>` element (start/end attrs are
	 * the seq tags printed in the transcript, clamped to the fold window);
	 * a tag-less reply degrades to the v1 flat single compartment holding the
	 * raw text.
	 */
	private compartmentRows(
		parsed: ParsedCompartmentOutput,
		raw: string,
		eligible: DshLogProjection["records"],
		fromSeq: number,
		toSeq: number,
		baseSequence: number,
	): CompartmentInput[] {
		const bySeq = new Map(eligible.map((record) => [record.seq, record]));
		const first = eligible[0]!;
		const last = eligible[eligible.length - 1]!;
		const clamp = (value: number, lo: number, hi: number): number =>
			Number.isFinite(value)
				? Math.min(Math.max(Math.trunc(value), lo), hi)
				: lo;
		const rows: CompartmentInput[] = parsed.compartments.map((c, i) => {
			const start = clamp(c.startMessage, fromSeq, toSeq);
			const end = clamp(c.endMessage, start, toSeq);
			return {
				sequence: baseSequence + i,
				startMessage: start,
				endMessage: end,
				startMessageId: bySeq.get(start)?.messageId ?? first.messageId,
				endMessageId: bySeq.get(end)?.messageId ?? last.messageId,
				title: c.title,
				content: c.content,
				...(c.p1 !== undefined ? { p1: c.p1 } : {}),
				...(c.p2 !== undefined ? { p2: c.p2 } : {}),
				...(c.p3 !== undefined ? { p3: c.p3 } : {}),
				...(c.p4 !== undefined ? { p4: c.p4 } : {}),
				...(c.importance !== undefined ? { importance: c.importance } : {}),
				...(c.episodeType !== undefined ? { episodeType: c.episodeType } : {}),
			};
		});
		if (rows.length === 0) {
			rows.push({
				sequence: baseSequence,
				startMessage: fromSeq,
				endMessage: toSeq,
				startMessageId: first.messageId,
				endMessageId: last.messageId,
				title: `Session history ${String(fromSeq)}–${String(toSeq)}`,
				content: raw,
			});
		}
		return rows;
	}

	/** Request-only aux call; null on any failure or empty completion. */
	private async runPass(
		inputSource: string,
		memoryEnabled: boolean,
		userObservationsRequested: boolean,
	): Promise<{ output: ParsedCompartmentOutput; raw: string } | null> {
		const route = this.route!;
		const prompt = buildCompartmentAgentPrompt({
			seedExamples: "",
			sessionReferences: "",
			projectMemory: "",
			inputSource,
			memoryEnabled,
			userObservationsRequested,
		});
		const options: GenerateOptions = {
			provider: route.provider,
			model: route.model,
			system: COMPARTMENT_AGENT_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
			purpose: "magic-context",
			...(this.config.historian?.maxTokens !== undefined
				? { maxTokens: this.config.historian.maxTokens }
				: {}),
		};
		let text = "";
		let finishedCleanly = false;
		try {
			for await (const chunk of this.host.llmStream(
				options,
			) as AsyncIterable<StreamChunk>) {
				if (chunk.type === "text-delta") text += chunk.text;
				else if (chunk.type === "finish")
					finishedCleanly = chunk.reason.kind === "stop";
			}
		} catch (error) {
			sessionLog("historian", "aux summary failed:", error);
			return null;
		}
		const raw = text.trim();
		if (raw.length === 0 || !finishedCleanly) return null;
		return { output: parseCompartmentOutput(raw), raw };
	}
}
