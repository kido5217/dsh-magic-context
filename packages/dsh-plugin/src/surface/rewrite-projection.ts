/**
 * Assistant-body rewrite projection (T004 verdict, R4 replacement).
 *
 * DSH forbids a plugin from replacing an `assistant/message` node: an
 * assistant event embeds its source stream, cannot carry `sourceEventSeqs`,
 * and the surface fold rejects any attempt (`assertSourceEventReferences`).
 * What the host DOES offer is a message projection — a pure interpreter bound
 * to a plugin-owned, ignorable log event (`ctx.sessions.registerMessageProjection`).
 * The fold applies it to the history it is rebuilding, so an assistant body can
 * be reduced durably without touching node membership, message identity or
 * tool pairing.
 *
 * Contract this file pins (proved in `test/projection.test.ts`):
 * - the event is `ignorable: true`, so a build without this plugin keeps the
 *   log open and simply sees the original content (graceful degradation, never
 *   a refusal);
 * - the interpreter preserves `id`, `role` and every non-content field;
 * - the target must be a current message at replay time, else the projection
 *   refuses — a rewrite may never invent history.
 *
 * Lanes must treat the assistant body rewrite as *recoverable*: `ctx_expand`
 * reads the store's tag, not the surface, so a degraded replay still returns
 * the original text verbatim.
 */

import type { ContentBlock, Message } from "@deepseek-ai/dsh-llm";
import { deriveEventMessage } from "@deepseek-ai/dsh-session";
import type { SessionMessageProjection } from "@deepseek-ai/dsh-session/surface";
import { SessionSeq } from "@deepseek-ai/dsh-session/types";

/** The plugin-owned event type; must match the `plugin:` record grammar. */
export const MC_REWRITE_EVENT_TYPE = "plugin:magic-context/rewrite";

declare module "@deepseek-ai/dsh-session/types" {
	interface PluginRecordMap {
		/** One assistant-body rewrite decision (log-only, projection-applied). */
		"plugin:magic-context/rewrite": McRewriteRecord;
	}
}

/** Payload of one assistant-body rewrite decision. */
export interface McRewriteRecord {
	/** Durable seq of the assistant node being rewritten. */
	readonly targetSeq: number;
	/** Durable message id the rewrite was decided for (identity assertion). */
	readonly messageId: string;
	/** Replacement content blocks. */
	readonly content: ContentBlock[];
	/** Tag number(s) the reduction refers to, for log-only traceability. */
	readonly tagNumbers?: readonly number[];
	readonly ignorable: true;
}

/**
 * The projection. Identity-preserving by construction: the derived message is
 * spread from the original and only `content` is replaced.
 */
export const mcRewriteProjection: SessionMessageProjection = {
	type: MC_REWRITE_EVENT_TYPE as SessionMessageProjection["type"],
	project(candidate, context) {
		const data = (candidate as unknown as { data: McRewriteRecord }).data;
		const targetSeq = SessionSeq(data.targetSeq);
		const targetEvent =
			context.events[data.targetSeq - Number(context.baseSeq)];
		if (targetEvent === undefined)
			throw new Error(
				`rewrite target seq ${String(data.targetSeq)} is outside the committed log`,
			);
		const original = deriveEventMessage(targetEvent);
		if (original === null)
			throw new Error(
				`rewrite target seq ${String(data.targetSeq)} is not a message`,
			);
		if (String(original.id) !== data.messageId) {
			throw new Error(
				`rewrite target seq ${String(data.targetSeq)} now holds ${String(original.id)}, not ${data.messageId}`,
			);
		}
		const projected: Message = { ...original, content: data.content };
		return new Map([[targetSeq, projected]]);
	},
};
