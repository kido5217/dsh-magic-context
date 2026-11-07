/**
 * In-memory DshHost double (T013).
 *
 * Honors the seam semantics loosely but honestly: `replaceSurface` removes
 * every shadowed seq from `surfaceNodes` and appends the replacement seq;
 * log events append to the session log; pre-step, pressure and tool
 * registrations are controllable stubs; every registration returns a disposer
 * that decrements the live-handle counters the orphan assertions check.
 * The `ctx` is a REAL cordis root `Context` so effects/Service registration
 * run through genuine production mechanics.
 */
import { Context } from "@deepseek-ai/cordis";
import type { FinishReason, GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type {
	DshHost,
	DshSession,
	DshSessionHeaderFacts,
	CompactionLifecycleEvent,
	PostToolInfo,
	PostToolVerdict,
	PressureReading,
	PreStepDecision,
	PreStepInfo,
	RequestErrorInfo,
	TodoState,
} from "../src/host.js";
import type { McReplacementContent } from "../src/surface/events.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";

export interface FakeLogEntry {
	readonly type: "mc/manage-start" | "mc/manage-end";
	readonly data: Record<string, unknown>;
	readonly seq: number;
}

export interface FakeSurfaceEdit {
	readonly replacementSeq: number;
	readonly startSeq: number;
	readonly endSeq: number;
	readonly shadowedSeqs: readonly number[];
	readonly content: McReplacementContent;
}

/** Plain text of replacement/notice content blocks (text blocks joined). */
export function fakeContentText(content: McReplacementContent): string {
	return content
		.map((block) => (typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
		.join("");
}

export class FakeSession implements DshSession {
	private readonly logEntries: FakeLogEntry[] = [];
	private readonly records = new Map<number, DshLogMessageRecord>();
	private surface: number[];
	private nextSeq: number;
	readonly id: string;
	flushCount = 0;
	/** Surface replacements applied via replaceSurface, in apply order. */
	readonly replacements: FakeSurfaceEdit[] = [];
	/** Tail appends (notices, head) in apply order. */
	readonly notices: Array<{ seq: number; content: McReplacementContent }> = [];
	/** Tool-result rewrites applied, in order (T017). */
	readonly rewrittenToolResults: Array<{ seq: number; replacementSeq: number; content: McReplacementContent }> = [];
	/** Assistant-body rewrites applied, in order (T004/T017). */
	readonly rewrittenAssistantBodies: Array<{ seq: number; content: McReplacementContent }> = [];
	/** User-node rewrites applied, in order (T017). */
	readonly rewrittenUserMessages: Array<{ seq: number; replacementSeq: number; content: McReplacementContent }> = [];
	/** Compaction lifecycle events appended, in order (T072). */
	readonly compactionEvents: Array<{ phase: string; data: Record<string, unknown>; seq: number }> = [];

	constructor(
		readonly header: DshSessionHeaderFacts,
		initialSurface: readonly number[] = [0, 1, 2, 3],
	) {
		this.id = header.id;
		this.surface = [...initialSurface];
		this.nextSeq = initialSurface.length > 0 ? Math.max(...initialSurface) + 1 : 0;
	}

	surfaceNodes(): readonly number[] {
		return [...this.surface];
	}

	get log(): readonly FakeLogEntry[] {
		return this.logEntries;
	}

	/** Seed durable content for a surface seq (durable-log projection source). */
	seedMessage(seq: number, messageId: string, text: string, role = "user", extra?: Partial<DshLogMessageRecord>): void {
		this.records.set(seq, { seq, messageId, role, text, createdAt: seq, ...extra });
	}

	/** Append a new durable user/assistant turn (simulates a new host turn). */
	async appendMessage(messageId: string, text: string, role = "user"): Promise<number> {
		const seq = this.nextSeq++;
		this.surface.push(seq);
		this.records.set(seq, { seq, messageId, role, text, createdAt: seq });
		return seq;
	}

	/** Surface-visible message records in surface position order (T015 reader). */
	logRecords(): DshLogMessageRecord[] {
		const out: DshLogMessageRecord[] = [];
		for (const seq of this.surface) {
			const record = this.records.get(seq);
			if (record !== undefined) out.push(record);
		}
		return out;
	}

	eventsOf(type: "mc/manage-start" | "mc/manage-end"): FakeLogEntry[] {
		return this.logEntries.filter((entry) => entry.type === type);
	}

	async replaceSurface(replacement: McReplacementContent, startSeq: number, endSeq: number, shadowedSeqs: readonly number[]): Promise<{ replacementSeq: number }> {
		if (shadowedSeqs.length === 0) throw new Error("replace requires at least one shadowed node");
		for (const seq of shadowedSeqs) {
			if (!this.surface.includes(seq)) throw new Error(`shadowed seq ${seq} is not a current surface node`);
		}
		if (!this.surface.includes(startSeq) || !this.surface.includes(endSeq)) {
			throw new Error("replacement endpoints must be current surface nodes");
		}
		const shadowed = new Set(shadowedSeqs);
		this.surface = this.surface.filter((seq) => !shadowed.has(seq));
		const replacementSeq = this.nextSeq++;
		this.surface.push(replacementSeq);
		this.records.set(replacementSeq, { seq: replacementSeq, messageId: `mc-repl-${String(replacementSeq)}`, role: "user", text: fakeContentText(replacement), createdAt: replacementSeq });
		this.replacements.push({ replacementSeq, startSeq, endSeq, shadowedSeqs, content: replacement });
		return { replacementSeq };
	}

	/** Content-only rewrite of one current tool/result node (host contract). */
	async rewriteToolResult(seq: number, content: McReplacementContent): Promise<{ replacementSeq: number }> {
		const record = this.records.get(seq);
		if (record === undefined || record.role !== "tool") throw new Error(`tool-result rewrite refused: seq ${seq} is not a tool result`);
		if (!this.surface.includes(seq)) throw new Error(`tool-result rewrite refused: seq ${seq} is not a current surface node`);
		const replacementSeq = this.nextSeq++;
		this.surface = this.surface.map((node) => (node === seq ? replacementSeq : node));
		this.records.set(replacementSeq, { ...record, seq: replacementSeq, text: fakeContentText(content) });
		this.replacements.push({ replacementSeq, startSeq: seq, endSeq: seq, shadowedSeqs: [seq], content });
		this.rewrittenToolResults.push({ seq, replacementSeq, content });
		return { replacementSeq };
	}

	/** Whole-node replacement of one current user/message node. */
	async rewriteUserMessage(seq: number, content: McReplacementContent): Promise<{ replacementSeq: number }> {
		const record = this.records.get(seq);
		if (record === undefined || record.role !== "user") throw new Error(`user rewrite refused: seq ${seq} is not a user message`);
		if (!this.surface.includes(seq)) throw new Error(`user rewrite refused: seq ${seq} is not a current surface node`);
		const replacementSeq = this.nextSeq++;
		this.surface = this.surface.map((node) => (node === seq ? replacementSeq : node));
		this.records.set(replacementSeq, { seq: replacementSeq, messageId: `mc-edit-${String(replacementSeq)}`, role: "user", text: fakeContentText(content), createdAt: replacementSeq, blocks: content });
		this.replacements.push({ replacementSeq, startSeq: seq, endSeq: seq, shadowedSeqs: [seq], content });
		this.rewrittenUserMessages.push({ seq, replacementSeq, content });
		return { replacementSeq };
	}

	/** Assistant-body rewrite: the double applies the projection immediately. */
	async rewriteAssistantBody(seq: number, content: McReplacementContent): Promise<{ eventSeq: number }> {
		const record = this.records.get(seq);
		if (record === undefined || record.role !== "assistant") throw new Error(`assistant rewrite refused: seq ${seq} is not an assistant message`);
		if (!this.surface.includes(seq)) throw new Error(`assistant rewrite refused: seq ${seq} is not a current surface node`);
		this.records.set(seq, { ...record, text: fakeContentText(content), blocks: content });
		this.rewrittenAssistantBodies.push({ seq, content });
		const eventSeq = this.nextSeq++;
		return { eventSeq };
	}

	async appendTail(content: McReplacementContent): Promise<{ seq: number }> {
		const seq = this.nextSeq++;
		this.surface.push(seq);
		this.records.set(seq, { seq, messageId: `mc-notice-${String(seq)}`, role: "user", text: fakeContentText(content), createdAt: seq });
		this.notices.push({ seq, content });
		return { seq };
	}

	async appendLogEvent(type: "mc/manage-start" | "mc/manage-end", data: Record<string, unknown>): Promise<{ seq: number }> {
		const seq = this.nextSeq++;
		this.logEntries.push({ type, data, seq });
		return { seq };
	}

	async appendCompactionEvent(event: CompactionLifecycleEvent): Promise<{ seq: number }> {
		const seq = this.nextSeq++;
		this.compactionEvents.push({ phase: event.phase, data: event.data as unknown as Record<string, unknown>, seq });
		return { seq };
	}

	async flush(): Promise<void> {
		this.flushCount += 1;
	}
}

export class TestDshHost implements DshHost {
	readonly ctx: Context;
	readonly sessions = new Map<string, FakeSession>();
	readonly preStepListeners = new Set<(info: PreStepInfo) => PreStepDecision | Promise<PreStepDecision>>();
	readonly registeredTools: string[] = [];
	private toolRegistrations = 0;
	pressureReadings = new Map<string, PressureReading | undefined>();
	llmCalls = 0;
	/** Aux-call script: per call, reply with text (finish stop) or fail (finish error). */
	llmResponder: ((options: GenerateOptions, callIndex: number) => { text?: string; fail?: boolean }) | undefined;
	readonly llmOptions: GenerateOptions[] = [];

	constructor() {
		// A real root context: effects, service registration and disposal run
		// through genuine cordis mechanics (no stubbed lifecycle).
		this.ctx = new Context();
	}

	addSession(header: DshSessionHeaderFacts, initialSurface?: readonly number[]): FakeSession {
		const session = new FakeSession(header, initialSurface);
		this.sessions.set(header.id, session);
		return session;
	}

	getSession(sessionId: string): DshSession | undefined {
		return this.sessions.get(sessionId);
	}

	pressure(sessionId: string): PressureReading | undefined {
		return this.pressureReadings.get(sessionId);
	}

	llmStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
		this.llmCalls += 1;
		this.llmOptions.push(options);
		const outcome = this.llmResponder?.(options, this.llmCalls - 1) ?? {};
		const chunks: StreamChunk[] = [];
		if (typeof outcome.text === "string" && outcome.text.length > 0) chunks.push({ type: "text-delta", index: 0, text: outcome.text });
		chunks.push({ type: "finish", reason: (outcome.fail ? { kind: "error" } : { kind: "stop" }) as unknown as FinishReason });
		let cursor = 0;
		return {
			[Symbol.asyncIterator]: (): AsyncIterator<StreamChunk> => ({
				next: async () => (cursor < chunks.length ? { done: false as const, value: chunks[cursor++]! } : { done: true as const, value: undefined as unknown as StreamChunk }),
			}),
		};
	}

	registerTool(definition: ToolDefinition): () => void {
		this.registeredTools.push(definition.name);
		this.toolRegistrations += 1;
		return () => {
			this.toolRegistrations -= 1;
			const index = this.registeredTools.indexOf(definition.name);
			if (index >= 0) this.registeredTools.splice(index, 1);
		};
	}

	onPreStep(listener: (info: PreStepInfo) => PreStepDecision | Promise<PreStepDecision>): () => void {
		this.preStepListeners.add(listener);
		return () => {
			this.preStepListeners.delete(listener);
		};
	}

	readonly postToolListeners = new Set<(info: PostToolInfo) => PostToolVerdict | undefined | Promise<PostToolVerdict | undefined>>();

	todoState(sessionId: string): TodoState | undefined {
		return this.todoStates.get(sessionId);
	}

	/** Set a session's latest todo state (T034 fixtures). */
	readonly todoStates = new Map<string, TodoState>();

	onRequestError(_listener: (info: RequestErrorInfo) => boolean | Promise<boolean>): () => void {
		return () => {};
	}

	registerRewriteProjection(): () => void {
		return () => {};
	}

	onPostToolExecute(listener: (info: PostToolInfo) => PostToolVerdict | undefined | Promise<PostToolVerdict | undefined>): () => void {
		this.postToolListeners.add(listener);
		return () => {
			this.postToolListeners.delete(listener);
		};
	}

	/** Fire the post-execute waterfall; the last non-undefined verdict wins. */
	async firePostTool(info: PostToolInfo): Promise<PostToolVerdict | undefined> {
		let verdict: PostToolVerdict | undefined;
		for (const listener of this.postToolListeners) {
			verdict = (await listener(info)) ?? verdict;
		}
		return verdict;
	}

	/** Live host handles (pre-step + post-execute listeners + tool registrations). */
	liveHandleCount(): number {
		return this.preStepListeners.size + this.postToolListeners.size + this.toolRegistrations;
	}

	/** Fire the pre-step waterfall the way the host would; last decision wins. */
	async firePreStep(info: PreStepInfo): Promise<PreStepDecision> {
		let decision: PreStepDecision = "enter";
		for (const listener of this.preStepListeners) {
			decision = await listener(info);
		}
		return decision;
	}
}
