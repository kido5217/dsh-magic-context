/**
 * Note-nudge assistance lane (T032).
 *
 * A note the agent deferred is worth exactly one reminder at the next work
 * boundary: too early and it interrupts, never and the intention is lost. The
 * core decides everything that is policy — when a trigger is pending, the
 * cooldown, which ready notes exist, and the nudge's text — through
 * `peekNoteNudgeText`. This lane contributes the DSH delivery primitive and
 * the persisted served-state transition:
 *
 * - delivery is a TAIL notice, not a rewrite: a nudge adds context, it never
 *   edits the user's words;
 * - serving clears the persisted trigger (`clearPersistedNoteNudge`), so the
 *   next pass cannot repeat it. The core's in-memory cooldown is per-process
 *   by design; the persisted trigger is what survives a restart.
 */

import { clearPersistedNoteNudge } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { peekNoteNudgeText } from "@magic-context/core/hooks/magic-context/note-nudger";
import { log } from "@magic-context/core/shared/logger";
import type { McReplacementContent } from "../surface/events.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

/** The newest user message id — the anchor the nudge is delivered against. */
export function latestUserMessageId(context: LaneContext): string | undefined {
	for (
		let index = context.projection.records.length - 1;
		index >= 0;
		index -= 1
	) {
		const record = context.projection.records[index]!;
		if (record.role === "user") return record.messageId;
	}
	return undefined;
}

/** Pure peek: the nudge text, or null when the core says none is due. */
export function peekNoteNudge(context: LaneContext): string | null {
	const userMessageId = latestUserMessageId(context);
	try {
		return peekNoteNudgeText(
			context.db,
			context.mcSession,
			userMessageId ?? null,
		);
	} catch (error) {
		log(
			`[dsh-magic-context] note nudge peek failed for ${context.mcSession}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return null;
	}
}

export const noteNudgeLane: Lane = {
	name: "note-nudge",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const text = peekNoteNudge(context);
		if (text === null || text.trim().length === 0) return { requests: [] };
		const content: McReplacementContent = [{ type: "text", text }];
		return {
			requests: [],
			decision: async () => {
				// Serving is a persisted transition: the trigger is consumed so a
				// later pass (or a restart) cannot deliver the same nudge twice.
				clearPersistedNoteNudge(context.db, context.mcSession);
				return { delivered: true };
			},
			tail: content,
			reason: "delivered a note nudge",
		};
	},
};
