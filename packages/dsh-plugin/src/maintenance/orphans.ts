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
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Session-id prefix of every hidden maintenance agent session. */
export const MAINTENANCE_SESSION_PREFIX = "session-mc-maint-";

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
			try {
				rmSync(join(dir, session), { recursive: true, force: true });
				removed.push(session);
			} catch {
				// Lost the race with a concurrent cleaner; it will be gone.
			}
		}
	}
	return removed;
}
