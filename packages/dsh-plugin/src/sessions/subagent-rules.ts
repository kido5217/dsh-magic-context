/**
 * Role-driven rule sets (T020).
 *
 * Mapping role (`session_meta.is_subagent`, classified from DSH lineage in
 * sessions/mapping.ts) selects the core rule set for a managed session:
 *
 * - Own session scope: every session manages only its own durable history;
 *   the store identity is per-session anyway, and the fold/drop machinery
 *   here never crosses sessions.
 * - Summarizer writes: on the other harnesses the historian may promote
 *   session facts into project memory and collect user observations. For
 *   agent-started children that economics is wrong — a bounded single-task
 *   child polluting shared project memory costs the parent cache and gains
 *   nothing (Pi encodes the same policy; its full flag set is tangled with
 *   CLI-spawn and dashboard workarounds that are NOT core behavior, and per
 *   the parity doctrine we apply the core baseline: no memory promotion and
 *   no user-observation extraction from subagent summarizers).
 * - Shared-cache economics: unchanged for subagents. DSH prices pressure
 *   per-session through the routed-model meter, so a child's cache TTL and
 *   bands follow the same routed model as any session; Pi's subagent cache
 *   handling compensates host-shape (spawn flags) and is not replicated.
 */
import type { McSessionRole } from "./mapping.js";

export interface McRoleRules {
	readonly role: McSessionRole;
	/** Management never crosses session boundaries. */
	readonly ownSessionScope: true;
	/** Whether the summarizer may write shared project memory. */
	readonly summarizerMemoryWrites: boolean;
	/** Whether the summarizer collects user-behavior observations. */
	readonly summarizerUserObservations: boolean;
	/** Whether cache economics differ from the routed-model baseline. */
	readonly sharedCacheEconomics: true;
}

export function rulesForRole(role: McSessionRole): McRoleRules {
	return role === "subagent"
		? {
				role,
				ownSessionScope: true,
				summarizerMemoryWrites: false,
				summarizerUserObservations: false,
				sharedCacheEconomics: true,
			}
		: {
				role,
				ownSessionScope: true,
				summarizerMemoryWrites: true,
				summarizerUserObservations: true,
				sharedCacheEconomics: true,
			};
}
