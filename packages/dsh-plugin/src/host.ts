/**
 * The host seam (tasks T004/T007).
 *
 * Everything the adapter needs from the DSH runtime, narrowed to exactly the
 * seams named in `contracts/dsh-plugin-surface.md`. Production wires this over
 * the real Cordis `ctx` (`host-cordis.ts`); tests mount the adapter on a double
 * implementing the same interface against a real shared store. Keeping this
 * interface honest is what keeps the adapter thin and the fail-closed paths
 * unit-provable (T013).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type {
	McManagedChangeKind,
	McReplacementContent,
} from "./surface/events.js";

/** Auxiliary LLM purposes this adapter declares (docs/subsystems/llm-streaming.md). */
declare module "@deepseek-ai/dsh-llm/types" {
	interface LlmRequestPurposeMap {
		"magic-context": true;
	}
}

/** Content of a compaction summary node (provider-neutral blocks). */
export type CompactionSummaryBlocks = McReplacementContent;

/** `compaction/start` payload: opens the durable compaction lock. */
export interface CompactionStartData {
	readonly compactionId: string;
	readonly sourceCommandId?: string;
	/** Turn owning the transaction; null for a standalone manual transaction. */
	readonly turn: number | null;
}

/** `compaction/summary` payload: the summary, its inputs and the call facts. */
export interface CompactionSummaryData {
	readonly compactionId: string;
	readonly sourceCommandId?: string;
	readonly summary: CompactionSummaryBlocks;
	readonly shadowedRange: { readonly start: number; readonly end: number };
	readonly shadowedSeqs: readonly number[];
	readonly shadowedTokenCount: number;
	readonly provider: string;
	readonly model: string;
	readonly maxTokens?: number;
	readonly usage?: {
		readonly inputTokens?: number;
		readonly outputTokens?: number;
		readonly totalTokens?: number;
	};
	readonly rawOutput?: CompactionSummaryBlocks;
	readonly llmStreamCall?: true;
}

/** One appended compaction lifecycle event (phase + its own payload shape). */
export type CompactionLifecycleEvent =
	| { readonly phase: "start"; readonly data: CompactionStartData }
	| { readonly phase: "summary"; readonly data: CompactionSummaryData }
	| { readonly phase: "end"; readonly data: CompactionEndData };

/** `compaction/end` payload: releases the lock; `error` records a failed attempt. */
export interface CompactionEndData {
	readonly compactionId: string;
	readonly sourceCommandId?: string;
	readonly turn: number | null;
	readonly error?: string;
}

/** Lineage facts used for primary/subagent classification (D9; session header). */ export interface DshSessionHeaderFacts {
	readonly id: string;
	/** Present and 'subagent' ⇒ agent-started session. */
	readonly origin?: "subagent";
	readonly parentSession?: string;
	readonly delegationDepth?: number;
	readonly cwd?: string;
}

/** A live or cold session the adapter can read and manage. */
export interface DshSession {
	readonly id: string;
	readonly header: DshSessionHeaderFacts;
	/** Current surface nodes in surface position order. */
	surfaceNodes(): readonly number[];
	/**
	 * Replace the surface nodes startSeq…endSeq (inclusive, position order) with a
	 * plugin-appended `user/message` node. `shadowedSeqs` must list every shadowed
	 * node — the compaction-precedent contract (`surfaceOp: replace`).
	 */
	replaceSurface(
		replacement: McReplacementContent,
		startSeq: number,
		endSeq: number,
		shadowedSeqs: readonly number[],
	): Promise<{ replacementSeq: number }>;
	/**
	 * Rewrite ONE current `tool/result` node's content in place (T015).
	 *
	 * The host admits a tool-result replacement only when exactly one current
	 * tool/result is shadowed and the replacement keeps every non-content field
	 * identical (`assertToolResultRewrite`). The durable event therefore reuses
	 * the original message id, `toolCallId` and turn/step: tool pairing survives
	 * and the rewrite is content-only. A second rewrite of the same seq is
	 * refused by the host (the node is no longer current), which is why node ops
	 * revalidate against the live surface first.
	 */
	rewriteToolResult(
		seq: number,
		content: McReplacementContent,
	): Promise<{ replacementSeq: number }>;
	/**
	 * Replace ONE current `user/message` node with a fresh plugin-sourced user
	 * node (T015). Role is preserved by construction; the replacement is a new
	 * durable node, so this is a true surface replacement, not a content patch.
	 */
	rewriteUserMessage(
		seq: number,
		content: McReplacementContent,
	): Promise<{ replacementSeq: number }>;
	/**
	 * Rewrite ONE current `assistant/message` body in place (T004 verdict).
	 *
	 * The host has no assistant surface replacement (an assistant node embeds
	 * its source stream and may not carry `sourceEventSeqs`), but it does have
	 * message projections: an ignorable, plugin-owned event plus a registered
	 * pure interpreter edit an existing message's content without changing node
	 * membership or identity. The rewrite is durable and replayable while the
	 * owning plugin is loaded, and degrades to the original content (never a
	 * refusal) when it is not — which is exactly the behaviour a reduction lane
	 * needs, since the store still holds the dropped tag for `ctx_expand`.
	 *
	 * Returns the seq of the append-only projection event, not a new node.
	 */
	rewriteAssistantBody(
		seq: number,
		content: McReplacementContent,
	): Promise<{ eventSeq: number }>;
	/** Append a plugin-sourced `user/message` at the surface tail (notices, head). */
	appendTail(content: McReplacementContent): Promise<{ seq: number }>;
	/** Append a log-only adapter event (mc/manage-start|end bookkeeping). */
	appendLogEvent(
		type: "mc/manage-start" | "mc/manage-end",
		data: Record<string, unknown>,
	): Promise<{ seq: number }>;
	/**
	 * Append one compaction lifecycle event. Log-only (no surface), but the
	 * start…end pair is the host's compaction lock and the summary event is the
	 * shadow-price anchor the replacement node must follow
	 * (docs/subsystems/compaction.md). Data shapes mirror the host's own
	 * `compaction/*` events; the caller supplies the full payload.
	 */
	appendCompactionEvent(
		event: CompactionLifecycleEvent,
	): Promise<{ seq: number }>;
	/** Durability barrier: returns once appended events are persisted. */
	flush(): Promise<void>;
}

/** Pre-step gate: the adapter answers 'enter' or 'reject' for a proposed step. */
export type PreStepDecision = "enter" | "reject";
export interface PreStepInfo {
	readonly sessionId: string;
	readonly turn: number;
	readonly step: number;
}

/** Pressure reading for one session, from the host token meter (D6). */
export interface PressureReading {
	/** Tokens the next provider request would carry (authoritative when present). */
	readonly pressureTokens?: number;
	/** Routed model's context window; absent when the route advertises none. */
	readonly contextWindow?: number;
}

/** One failed model request, as the host normalized it (T028). */
export interface RequestErrorInfo {
	readonly sessionId: string;
	readonly turn: number;
	readonly step: number;
	readonly provider: string;
	/** The provider's failure payload; `detectOverflow` reads its message. */
	readonly failure: unknown;
}

/** One dispatched tool result, before it reaches the model (T008). */
export interface PostToolInfo {
	readonly sessionId: string;
	readonly toolName: string;
	readonly toolCallId?: string;
	/** Flattened text of the result's content blocks. */
	readonly text: string;
}

/**
 * A listener's verdict on a dispatched tool result. Both channels are durable:
 * `content` becomes the persisted result (the `tools/post-execute` decision
 * replaces it before materialization), `additionalContext` is admitted as a
 * user message for the next request. Returning undefined accepts unchanged.
 */
export interface PostToolVerdict {
	readonly content?: McReplacementContent;
	readonly additionalContext?: McReplacementContent;
}

/** The complete host surface the adapter consumes. */
export interface DshHost {
	/** The underlying Cordis context (production only; doubles may stub it). */
	readonly ctx: Context;
	getSession(sessionId: string): DshSession | undefined;
	/** Pressure for the routed model; `undefined` ⇒ meter unavailable (fail-safe, D6). */
	pressure(sessionId: string): PressureReading | undefined;
	/** Auxiliary LLM call (historian/dreamer; request-only, no durable identity). */
	llmStream(options: GenerateOptions): AsyncIterable<StreamChunk>;
	/** Register an agent-facing tool as a fiber-scoped effect; returns the disposer. */
	registerTool(definition: ToolDefinition): () => void;
	/** Observe proposed agent steps; return "reject" to refuse the step (no model call). */
	onPreStep(
		listener: (info: PreStepInfo) => PreStepDecision | Promise<PreStepDecision>,
	): () => void;
	/**
	 * Observe a failed model request. Returning true asks the host to RETRY the
	 * request (the waterfall's `retry` action); returning false/undefined lets
	 * the failure stand. Used by overflow recovery (T028).
	 */
	onRequestError(
		listener: (info: RequestErrorInfo) => boolean | Promise<boolean>,
	): () => void;
	/** Observe dispatched tool results; a verdict may rewrite or accompany them. */
	onPostToolExecute(
		listener: (
			info: PostToolInfo,
		) => PostToolVerdict | undefined | Promise<PostToolVerdict | undefined>,
	): () => void;
	/**
	 * Register the message projection that applies assistant-body rewrites for
	 * this plugin's event type. Production registers it on `ctx.sessions`
	 * (fiber-scoped); a double applies its own bookkeeping and returns a no-op
	 * disposer. Returns the disposer.
	 */
	registerRewriteProjection(): () => void;
}
