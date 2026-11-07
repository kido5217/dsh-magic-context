/**
 * The manual compaction fold (T072).
 *
 * `/compact` (and region compaction) arrives through `ctx.compaction`, whose
 * MC backend is `McCompactionClaim`; the claim delegates the work to this
 * callback. The fold is the SAME fold the pressure pass runs — the historian
 * core, one managed bracket, one surface replacement — with two extras the
 * host requires of an explicit compaction:
 *
 * 1. the durable lifecycle pair + summary event (`compaction/start`,
 *    `compaction/summary`, one replacement `user/message` carrying the host's
 *    checkpoint source, `compaction/end`) — emitted by the fold core, so the
 *    store publication and the surface bookkeeping cannot diverge; and
 * 2. a full `CompactionResult` naming the real event seqs.
 *
 * Serialization (T073): the one fold-in-flight slot lives on the compaction
 * claim (`beginFold/endFold/foldInFlight`). `/compact`, the command folds
 * (`/ctx-recomp`, `/ctx-wrapup`) and the pre-step pass all consult it, so a
 * manual fold and a pressure fold never overlap on one session.
 */
import { randomUUID } from "node:crypto";
import { CommandId } from "@deepseek-ai/dsh-commands/brand";
import {
	CompactionId,
	type CompactionResult,
	ManualCompactionError,
} from "@deepseek-ai/dsh-compaction";
import { SessionSeq } from "@deepseek-ai/dsh-session/types";
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import type {
	CompactionClaimRegistry,
	McFoldCallback,
} from "./compaction-claim.js";
import type { DshHost } from "./host.js";
import type { Historian } from "./sessions/historian.js";
import type { SessionMapping } from "./sessions/mapping.js";
import { rulesForRole } from "./sessions/subagent-rules.js";
import { protectedTailBudget } from "./surface/apply-operations.js";
import type { DshSessionLogReader } from "./surface/dsh-session-log.js";
import { projectDshSessionLog } from "./surface/dsh-session-log.js";

export interface McFoldDeps {
	readonly host: DshHost;
	readonly db: ContextDatabase;
	readonly config: MagicContextConfig;
	readonly claim: CompactionClaimRegistry;
	readonly mapping: SessionMapping;
	readonly historian: Historian;
	readonly readSessionLog: DshSessionLogReader;
}

/**
 * Build the claim's fold callback. `region` absent ⇒ the default foldable
 * window (everything past published coverage, protected tail kept); present ⇒
 * the requested span, revalidated against the live surface inside the fold.
 */
export function createMcFold(deps: McFoldDeps): McFoldCallback {
	return async (agent, region, signal, meta) => {
		const sessionId = agent.session.id;
		const session = deps.host.getSession(sessionId);
		if (session === undefined) {
			throw new ManualCompactionError(
				"changed",
				`session ${sessionId} is not open on this host; Magic Context cannot fold it`,
			);
		}
		if (signal?.aborted === true) {
			throw new ManualCompactionError(
				"cancelled",
				`compaction of session ${sessionId} was cancelled before it started`,
			);
		}
		// Admit as maintenance: the store row + role upsert is idempotent, and
		// the claim keeps the session claimed for the host's trigger deferral.
		const mapped = deps.mapping.upsert(session.header);
		deps.claim.attach(mapped.mcSession);
		if (!deps.claim.beginFold(sessionId)) {
			throw new ManualCompactionError(
				"busy",
				`a Magic Context fold is already in flight for session ${sessionId}`,
			);
		}
		try {
			const records = deps.readSessionLog(sessionId);
			if (records === undefined) {
				throw new ManualCompactionError(
					"persistence",
					`the durable session log for ${sessionId} is unreadable`,
				);
			}
			const projection = projectDshSessionLog(records);
			const window = deps.host.pressure(sessionId)?.contextWindow;
			const outcome = await deps.historian.fold({
				session,
				mcSession: mapped.mcSession,
				projection,
				rules: rulesForRole(mapped.role),
				subagent: mapped.role === "subagent",
				protectedTailTokens: protectedTailBudget(deps.config, window, false),
				...(region !== undefined ? { span: region } : {}),
				compaction: {
					compactionId: `mc-${randomUUID()}`,
					...(meta?.sourceCommandId !== undefined
						? { sourceCommandId: meta.sourceCommandId }
						: {}),
				},
			});
			// null ⇒ nothing foldable (or no historian route): the host maps a
			// null `compactNow` to "nothing to do" and a null region fold to
			// `changed`, both without a surface write.
			if (outcome === null || outcome.compaction === undefined) return null;
			const fold = outcome.compaction;
			return {
				compactionId: CompactionId(fold.compactionId),
				...(meta?.sourceCommandId !== undefined
					? { sourceCommandId: CommandId(meta.sourceCommandId) }
					: {}),
				startSeq: SessionSeq(fold.startSeq),
				summarySeq: SessionSeq(fold.summarySeq),
				endSeq: SessionSeq(fold.endSeq),
				summary: fold.summary,
				shadowedRange: {
					start: SessionSeq(fold.shadowedRange.start),
					end: SessionSeq(fold.shadowedRange.end),
				},
				shadowedSeqs: fold.shadowedSeqs.map((seq) => SessionSeq(seq)),
				shadowedTokenCount: fold.shadowedTokenCount,
			} satisfies CompactionResult;
		} finally {
			deps.claim.endFold(sessionId);
		}
	};
}
