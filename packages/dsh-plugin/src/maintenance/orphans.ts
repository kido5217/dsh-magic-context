/**
 * Maintenance orphan reaper (T056).
 *
 * A maintenance agent's session is durable only while the agent is alive:
 * transport disposal removes the session outright. If the process dies
 * mid-run, the session directory survives under the session root with the
 * `session-mc-maint-` prefix and nothing will ever resume it. At boot —
 * before the first maintenance tick — every such directory is removed.
 *
 * The scan is filesystem-level on purpose: a crashed session may be too
 * malformed for the session store to open, and the store's own lifecycle
 * does not garbage-collect sessions no live agent owns.
 */
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** Session-id prefix of every hidden maintenance agent session. */
export const MAINTENANCE_SESSION_PREFIX = "session-mc-maint-";

/**
 * N-10 age fence: a prefix match alone cannot tell a crashed orphan from a
 * maintenance agent that is ALIVE in another process sharing this
 * `$DSH_HOME/sessions` root (resident hosts, concurrent harness processes).
 * Boot may only reap what has seen no activity for a full day: live agents
 * append to their session log, an idle day means nobody owns the directory.
 * Fresh-but-alive directories simply survive until a later boot reaps them.
 */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Newest mtime within one session directory (dir + one level of entries). */
function newestActivityMs(dir: string): number {
	let newest = 0;
	try {
		newest = statSync(dir).mtimeMs;
	} catch {
		return Number.POSITIVE_INFINITY; // vanished: nothing to reap anyway
	}
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			try {
				newest = Math.max(
					newest,
					statSync(join(dir, entry.name)).mtimeMs,
				);
			} catch {
				// Raced removal of one entry: the dir-level mtime stands.
			}
		}
	} catch {
		// Unreadable listing: fall back to the directory mtime.
	}
	return newest;
}

/**
 * Delete crashed maintenance sessions under one session root
 * (`<DSH_HOME>/sessions`, whose children are workspace slugs).
 *
 * Best-effort: an unreadable root or an in-flight removal is skipped, never
 * thrown — boot must not hinge on cleanup. Returns the removed session ids.
 */
export function reapMaintenanceOrphans(sessionRoot: string): string[] {
	const removed: string[] = [];
	let workspaces: string[];
	try {
		workspaces = readdirSync(sessionRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return removed;
	}
	for (const workspace of workspaces) {
		const dir = join(sessionRoot, workspace);
		let sessions: string[];
		try {
			sessions = readdirSync(dir, { withFileTypes: true })
				.filter(
					(entry) =>
						entry.isDirectory() &&
						entry.name.startsWith(MAINTENANCE_SESSION_PREFIX),
				)
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const session of sessions) {
			const path = join(dir, session);
			if (Date.now() - newestActivityMs(path) < ORPHAN_MIN_AGE_MS) {
				// N-10: too fresh to call dead — either this very process'
				// agent (boot ordering races) or a sibling host's live agent.
				continue;
			}
			try {
				rmSync(path, { recursive: true, force: true });
				removed.push(session);
			} catch {
				// Lost the race with a concurrent cleaner; it will be gone.
			}
		}
	}
	return removed;
}
