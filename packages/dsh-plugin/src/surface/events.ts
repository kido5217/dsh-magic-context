/**
 * Adapter event vocabulary (tasks T010).
 *
 * Magic Context's durable management edits on DSH follow the compaction
 * precedent: the *decision* lives in the shared store; the *effect* is a
 * durable Session-log change. Every managed change is bracketed by the two
 * log-only events declared here — the bracket is the per-session lock
 * (an unmatched `mc/manage-start` is busy/orphan evidence, same discipline as
 * `compaction/start…end`, docs/subsystems/compaction.md) and the link from a
 * surface replacement back to the store decision that justified it
 * (observability: any reduction or fold is traceable to its justification).
 *
 * `ignorable: true` is deliberate: these records are log-only bookkeeping.
 * The surface effect is carried by the `user/message` replacement node itself,
 * so reconstruction never depends on them (unknown types without `ignorable`
 * would refuse reconstruction — docs/subsystems/session.md).
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";

/** Kinds of managed change the adapter can apply (contracts/dsh-plugin-surface.md). */
export type McManagedChangeKind = "drop" | "fold" | "head-refresh" | "head-rebaseline" | "recover";

export interface McManageStart {
	/** Correlates to the shared-store decision record for this change. */
	readonly changeId: string;
	readonly kind: McManagedChangeKind;
	/** MC session key (the store-side identity; `(harness='dsh', dsh_session_id)`). */
	readonly mcSession: string;
	/** The DSH session's durable id (mirrors the store attribution). */
	readonly dshSessionId: string;
	readonly ignorable: true;
}

export interface McManageEnd {
	readonly changeId: string;
	readonly kind: McManagedChangeKind;
	/** Surface seqs shadowed by this change's replacement, when one was applied. */
	readonly shadowedSeqs?: readonly number[];
	/** Replacement node seq, when a surface edit landed. */
	readonly replacementSeq?: number;
	/** Present iff the change did not complete; the decision stays unapplied and replays. */
	readonly error?: string;
	readonly ignorable: true;
}

declare module "@deepseek-ai/dsh-session/types" {
	/**
	 * Bracket bookkeeping rides the host's plugin-record channel, not the
	 * released event vocabulary: `KNOWN_SESSION_EVENT_TYPES` excludes
	 * out-of-repo plugin types by construction (observed 0.2.2-rc.1 — a log
	 * with an undeclared non-ignorable type refuses to reopen), and ignorable
	 * records are retained-and-skipped by any build. One declared record name
	 * carries both bracket ends via `kind` (the catalog keeps one declaration
	 * per owner; dynamic discriminators live in the payload).
	 */
	interface PluginRecordMap {
		"plugin:magic-context/manage": McManageRecord;
	}
}

/** Payload of the single MC plugin record: one bracket end plus its bookkeeping. */
export interface McManageRecord {
	readonly kind: "mc/manage-start" | "mc/manage-end";
	readonly changeId: string;
	readonly [key: string]: unknown;
}

/** Content of the surface-replacing node for a managed change (a bracketed notice). */
export type McReplacementContent = ContentBlock[];
