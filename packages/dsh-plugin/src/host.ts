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
import type { McManagedChangeKind, McReplacementContent } from "./surface/events.js";

/** Auxiliary LLM purposes this adapter declares (docs/subsystems/llm-streaming.md). */
declare module "@deepseek-ai/dsh-llm/types" {
	interface LlmRequestPurposeMap {
		"magic-context": true;
	}
}

/** Lineage facts used for primary/subagent classification (D9; session header). */
export interface DshSessionHeaderFacts {
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
	replaceSurface(replacement: McReplacementContent, startSeq: number, endSeq: number, shadowedSeqs: readonly number[]): Promise<{ replacementSeq: number }>;
	/** Append a plugin-sourced `user/message` without shadowing anything (notices). */
	appendNotice(content: McReplacementContent): Promise<{ seq: number }>;
	/** Append a log-only adapter event (mc/manage-start|end bookkeeping). */
	appendLogEvent(type: "mc/manage-start" | "mc/manage-end", data: Record<string, unknown>): Promise<{ seq: number }>;
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
	onPreStep(listener: (info: PreStepInfo) => PreStepDecision | Promise<PreStepDecision>): () => void;
}
