/**
 * Session mapping (T008).
 *
 * Maps a live/cold DSH session onto its shared-store identity. The store
 * identity is `(harness='dsh', dsh_session_id)`: `session_meta.session_id`
 * holds the durable DSH session id and the `harness` column is stamped from
 * `getHarness()` (set to "dsh" at boot, before the first write), so
 * `getOrCreateSessionMeta` is the idempotent upsert — INSERT-OR-IGNORE keyed
 * on the same pair, safe across restarts and resume (no duplicate rows).
 *
 * Role classification (D9): `header.origin === 'subagent'` ⇒ subagent
 * (agent-started, parent-linked from `header.parentSession`); anything else —
 * including unknown/absent lineage ⇒ primary (safe default: full management).
 * The role persists on the core schema (`session_meta.is_subagent`); the
 * parent link has no core column, so it lives in an adapter-local Map (also
 * carried in every `mc/manage-start` payload via `mcSession` attribution).
 */
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage-meta-session";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { DshSessionHeaderFacts } from "../host.js";

export type McSessionRole = "primary" | "subagent";

/** One mapped session: store identity + role + (subagent) parent lineage. */
export interface McSessionMapping {
	/** MC session key — for DSH the durable dsh session id (harness column distinguishes it). */
	readonly mcSession: string;
	readonly dshSessionId: string;
	readonly role: McSessionRole;
	readonly parentDshSessionId?: string;
}

/** Classify from lineage facts; unknown lineage ⇒ primary (D9 safe default). */
export function classifySession(header: DshSessionHeaderFacts): McSessionRole {
	return header.origin === "subagent" ? "subagent" : "primary";
}

/** Adapter-local registry of mapped sessions (attach/detach lifetime). */
export class SessionMapping {
	private readonly mappings = new Map<string, McSessionMapping>();

	constructor(private readonly db: Database) {}

	/**
	 * Idempotent upsert of the store row + role, keyed on
	 * `(harness='dsh', dsh_session_id)`; returns the mapping. Re-attaching a
	 * resumed session re-reads the same row (durable ids survive restart).
	 */
	upsert(header: DshSessionHeaderFacts): McSessionMapping {
		const role = classifySession(header);
		const meta = getOrCreateSessionMeta(this.db, header.id);
		const isSubagent = role === "subagent";
		if (meta.isSubagent !== isSubagent) {
			updateSessionMeta(this.db, header.id, { isSubagent });
		}
		const mapping: McSessionMapping = {
			mcSession: header.id,
			dshSessionId: header.id,
			role,
			...(header.parentSession !== undefined
				? { parentDshSessionId: header.parentSession }
				: {}),
		};
		this.mappings.set(header.id, mapping);
		return mapping;
	}

	get(dshSessionId: string): McSessionMapping | undefined {
		return this.mappings.get(dshSessionId);
	}

	/**
	 * DSH id of the most recently attached session — the tool registration's
	 * default `sessionId()` resolver (registrations follow the session that most
	 * recently ran a pass; production may override per agent scope).
	 */
	lastAttached(): string | undefined {
		let last: string | undefined;
		for (const id of this.mappings.keys()) last = id;
		return last;
	}

	remove(dshSessionId: string): void {
		this.mappings.delete(dshSessionId);
	}

	detachAll(): void {
		this.mappings.clear();
	}
}
