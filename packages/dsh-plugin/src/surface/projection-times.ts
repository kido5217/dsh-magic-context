/**
 * Durable message times for the shared store (US2 data enrichment).
 *
 * Compartment dates resolve through the core time index
 * (`message_fts_rowid_map.message_time_ms`), which OpenCode hosts populate
 * with their FTS rows. DSH owns its log in the host, so the adapter
 * publishes the projection's own timestamps here: same table, same
 * semantics, `-seq` as the FTS sentinel (a DSH session has no FTS row; the
 * date lookups read only the ordinal → time mapping).
 *
 * Idempotent and cheap; called before baseline/delta renders so a new
 * compartment's boundary dates exist the moment the fold writes the
 * compartment row.
 */
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import type { DshLogProjection } from "./dsh-session-log.js";

export function syncProjectionTimes(
	db: ContextDatabase,
	mcSession: string,
	projection: DshLogProjection,
): void {
	const statement = db.prepare(
		`INSERT INTO message_fts_rowid_map
		     (session_id, message_ordinal, fts_rowid, message_time_ms)
		   VALUES (?, ?, ?, ?)
		   ON CONFLICT(session_id, message_ordinal) DO UPDATE
		     SET message_time_ms = excluded.message_time_ms`,
	);
	for (const record of projection.records) {
		if (record.createdAt === undefined) continue;
		try {
			statement.run(mcSession, record.seq, -record.seq, record.createdAt);
		} catch {
			// Time enrichment is best effort: a missing date only costs the
			// one date annotation, never the render itself.
		}
	}
}
