/**
 * Head cursors (T044) — the frozen baseline state, read back from the
 * shared store.
 *
 * The cursors are the core's: `materializeM0` persists the m[0] snapshot
 * markers into the existing `session_meta.cached_m0_*` columns in the same
 * write that renders the baseline (memory watermarks, mutation watermarks,
 * compartment sequence, docs hash, profile version, `materializedAt`, the
 * upgrade identity carrying the rendered-memory-id manifest). This module
 * adds no storage of its own — it reads the persisted state back so the
 * adapter can survive a restart: the delta renders against these frozen
 * markers, and the visible-memory filter (auto-search) reads the ids from
 * the same manifest core maintains.
 */
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { readCachedM0MemoryIds } from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import {
	type M0SnapshotMarkers,
	readCurrentM0SnapshotMarkers,
} from "@magic-context/core/hooks/magic-context/inject-compartments";

export interface HeadCursors {
	/** The markers frozen with the current baseline (the delta renders against these). */
	readonly markers: M0SnapshotMarkers;
	/** The memory ids the baseline currently shows (the visible-memory filter). */
	readonly renderedMemoryIds: readonly number[];
}

export interface HeadCursorArgs {
	readonly projectPath?: string;
	readonly projectDirectory?: string;
	readonly injectDocs?: boolean;
	readonly memoryEnabled?: boolean;
}

/** True when a baseline has ever been materialized for this session. */
export function hasPersistedBaseline(
	db: ContextDatabase,
	mcSession: string,
): boolean {
	const state = getOrCreateSessionMeta(db, mcSession);
	return state.cachedM0Bytes !== null;
}

/**
 * Read the persisted cursors. Returns undefined when no baseline exists
 * yet (nothing frozen: the first render must materialize, not delta).
 */
export function readHeadCursors(
	db: ContextDatabase,
	mcSession: string,
	args: HeadCursorArgs = {},
): HeadCursors | undefined {
	const state = getOrCreateSessionMeta(db, mcSession);
	if (state.cachedM0Bytes === null) return undefined;
	const markers = readCurrentM0SnapshotMarkers({
		db,
		sessionId: mcSession,
		projectPath: args.projectPath,
		projectDirectory: args.projectDirectory,
		injectDocs: args.injectDocs,
		memoryEnabled: args.memoryEnabled,
	});
	// The rendered-id manifest rides the upgrade identity (core wrote it in
	// the baseline's decision); the legacy fallback is the retired
	// `memory_block_ids` list, filtered to the baseline's watermark.
	const legacy = readLegacyMemoryIds(db, mcSession);
	return {
		markers,
		renderedMemoryIds: readCachedM0MemoryIds(
			state.cachedM0UpgradeState,
			legacy,
			markers.maxMemoryId,
		),
	};
}

function readLegacyMemoryIds(
	db: ContextDatabase,
	mcSession: string,
): readonly number[] {
	const row = db
		.prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
		.get(mcSession) as { memory_block_ids: string | null } | null;
	if (row?.memory_block_ids === null || row?.memory_block_ids === undefined)
		return [];
	try {
		const parsed: unknown = JSON.parse(row.memory_block_ids);
		return Array.isArray(parsed) && parsed.every((id) => typeof id === "number")
			? parsed
			: [];
	} catch {
		return [];
	}
}
