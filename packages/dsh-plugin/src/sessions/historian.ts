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
 * v1 scope: one compartment per fold, P1-tier flat content, no session-facts
 * re-normalization, no project-memory promotion from the summarizer (see the
 * scope ledger in the report; the core runner's two-pass/compressor pipeline
 * is host-agnostic work for a later phase). Subagent rule sets therefore only
 * narrow the guidance for now — `rules.summarizerMemoryWrites` is checked so
 * enabling memory promotion later can't miss the gate.
 */
import { randomUUID } from "node:crypto";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import {
	appendCompartments,
	getCompartments,
	getLastCompartmentEndMessage,
} from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { executeFlush } from "@magic-context/core/hooks/magic-context/execute-flush";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { DshHost, DshSession } from "../host.js";
import { splitProtectedTail } from "../surface/apply-operations.js";
import type { DshLogProjection } from "../surface/dsh-session-log.js";
import { isAdapterSurfaceId } from "../surface/dsh-session-log.js";
import type { HeadManager } from "../surface/head.js";
import type { ManagedEdits, ShadowInfo } from "../surface/managed-edits.js";
import type { McRoleRules } from "./subagent-rules.js";

const HISTORIAN_SYSTEM_PROMPT =
	"You are the Magic Context historian. Summarize the supplied session transcript into a terse chronological record of what happened: decisions, file changes, command outcomes, open threads. Prefer bullet lines. Keep identifiers (files, symbols, errors) exact. No preamble, no commentary on the summary itself.";

export interface HistorianRoute {
	readonly provider: string;
	readonly model: string;
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

		const summary = await this.summarize(
			eligible
				.map(
					(record) => `[${String(record.seq)}] ${record.role}: ${record.text}`,
				)
				.join("\n"),
		);
		if (summary === null) return null;

		const fromSeq = eligible[0]!.seq;
		const toSeq = eligible[eligible.length - 1]!.seq;
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
		const shadow = await this.managedEdits.runManagedChange(
			"fold",
			changeId,
			mcSession,
			{
				decision: async () => {
					appendCompartments(this.db, mcSession, [
						{
							sequence,
							startMessage: fromSeq,
							endMessage: toSeq,
							startMessageId: eligible[0]!.messageId,
							endMessageId: eligible[eligible.length - 1]!.messageId,
							title: `Session history ${String(fromSeq)}–${String(toSeq)}`,
							content: summary,
						},
					]);
					// Drops queued for messages the fold now covers are settled by
					// the fold itself: drain the queue through the core flush path.
					executeFlush(this.db, mcSession);
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

	/** Request-only aux call; null on any failure or empty completion. */
	private async summarize(transcript: string): Promise<string | null> {
		const route = this.route!;
		const options: GenerateOptions = {
			provider: route.provider,
			model: route.model,
			system: HISTORIAN_SYSTEM_PROMPT,
			messages: [
				{ role: "user", content: [{ type: "text", text: transcript }] },
			],
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
		const summary = text.trim();
		if (summary.length === 0 || !finishedCleanly) return null;
		return summary;
	}
}
