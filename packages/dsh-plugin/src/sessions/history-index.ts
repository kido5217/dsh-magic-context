/**
 * T045 — message-history indexing for DSH sessions.
 *
 * On the OpenCode host the durable-history index (message_history_index and
 * its FTS mirror) is fed by the `message.updated` event hooks reading the
 * OpenCode session DB. DSH has no such event channel: the session log IS the
 * history, projected on every pass. So the pass itself feeds the same core
 * indexer — one reconciliation per pass (cheap: the source carries a
 * revision so unchanged sessions no-op) plus an incremental index for every
 * projected message newer than the last seen ordinal.
 *
 * Keying matches the rest of the adapter's store footprint (compartments,
 * tags, session_meta): the mc session id, with projection-position ordinals
 * so the search tool's compartment-boundary cutoff applies unchanged.
 */
import {
	scheduleIncrementalIndex,
	scheduleReconciliation,
} from "@magic-context/core/features/magic-context/message-index-async";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { log } from "@magic-context/core/shared/logger";
import type { DshLogProjection } from "../surface/dsh-session-log.js";

/** Highest projected ordinal already scheduled for incremental indexing. */
const indexedWatermarks = new Map<string, number>();

/** R-05: release a closed session's index watermark (module-level so it
 * must be pruned explicitly with the rest of the session-close sweep). */
export function forgetIndexedWatermarks(mcSession: string): void {
	indexedWatermarks.delete(mcSession);
}

/** Source revision accepted by the async reconciler (append-only proxy). */
function revisionOf(projection: DshLogProjection): number {
	return projection.rawMessages.length;
}

let failureLogged = false;

/**
 * Index the session's projected history. Best effort: an indexer failure
 * must never refuse or corrupt a management pass — the history lane then
 * answers with fewer sources, matching the pre-T045 status quo.
 */
export function indexDshSessionHistory(
	db: ContextDatabase,
	mcSession: string,
	projection: DshLogProjection,
): void {
	try {
		const messages = projection.rawMessages;
		const source = Object.assign(
			() => messages.map((message) => ({ ...message })),
			{ getRevision: () => revisionOf(projection) },
		);
		scheduleReconciliation(db, mcSession, source);
		const watermark = indexedWatermarks.get(mcSession) ?? 0;
		for (const message of messages) {
			if (message.ordinal <= watermark) continue;
			scheduleIncrementalIndex(db, mcSession, message.id, { ...message });
		}
		const highest = messages.reduce(
			(max, message) => Math.max(max, message.ordinal),
			0,
		);
		if (highest > watermark) indexedWatermarks.set(mcSession, highest);
	} catch (error) {
		if (!failureLogged) {
			failureLogged = true;
			log(
				`[dsh-magic-context] history indexing failed (further failures silent): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}
