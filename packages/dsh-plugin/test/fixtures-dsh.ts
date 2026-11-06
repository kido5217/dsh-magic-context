/**
 * Shared doubles for the US3 + crash-window tests (T024, T033–T035).
 *
 * Self-contained fake `DshHost` (kept separate from ./double.ts and
 * ./double-stub.ts, which other lanes own): sessions carry a durable-style
 * mc/manage-* log; `replaceSurface` honors the shadow contract (every
 * shadowed seq must be a current surface node, is removed exactly once, and
 * the replacement is appended). The `ctx` is a REAL cordis root `Context` so
 * effect mechanics run through production classes. `openBrackets` derives
 * crash-resume evidence (start-without-end) from the log, the same way the
 * adapter's resume pass must.
 */
import { Context } from "@deepseek-ai/cordis";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DshHost, DshSession, DshSessionHeaderFacts, PressureReading, PreStepDecision, PreStepInfo } from "../src/host.js";
import type { McReplacementContent } from "../src/surface/events.js";

export interface FakeLogEntry {
	readonly type: "mc/manage-start" | "mc/manage-end";
	readonly data: Record<string, unknown>;
	readonly seq: number;
}

export class FakeMcSession implements DshSession {
	private readonly logEntries: FakeLogEntry[] = [];
	private surface: number[];
	private nextSeq: number;
	readonly id: string;
	flushCount = 0;

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

	eventsOf(type: "mc/manage-start" | "mc/manage-end"): FakeLogEntry[] {
		return this.logEntries.filter((entry) => entry.type === type);
	}

	async replaceSurface(_replacement: McReplacementContent, startSeq: number, endSeq: number, shadowedSeqs: readonly number[]): Promise<{ replacementSeq: number }> {
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
		return { replacementSeq };
	}

	async appendNotice(_content: McReplacementContent): Promise<{ seq: number }> {
		const seq = this.nextSeq++;
		this.surface.push(seq);
		return { seq };
	}

	async appendLogEvent(type: "mc/manage-start" | "mc/manage-end", data: Record<string, unknown>): Promise<{ seq: number }> {
		const seq = this.nextSeq++;
		this.logEntries.push({ type, data, seq });
		return { seq };
	}

	async flush(): Promise<void> {
		this.flushCount += 1;
	}
}

export class McHost implements DshHost {
	readonly ctx: Context;
	readonly sessions = new Map<string, FakeMcSession>();
	readonly tools = new Map<string, ToolDefinition>();
	readonly registrationOrder: string[] = [];
	private readonly preStepListeners = new Set<(info: PreStepInfo) => PreStepDecision | Promise<PreStepDecision>>();
	pressureReadings = new Map<string, PressureReading | undefined>();
	llmCalls = 0;

	constructor() {
		this.ctx = new Context();
	}

	addSession(header: DshSessionHeaderFacts, initialSurface?: readonly number[]): FakeMcSession {
		const session = new FakeMcSession(header, initialSurface);
		this.sessions.set(header.id, session);
		return session;
	}

	getSession(sessionId: string): FakeMcSession | undefined {
		return this.sessions.get(sessionId);
	}

	pressure(sessionId: string): PressureReading | undefined {
		return this.pressureReadings.get(sessionId);
	}

	llmStream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
		this.llmCalls += 1;
		return {
			[Symbol.asyncIterator]: (): AsyncIterator<StreamChunk> => ({
				next: async () => ({ done: true as const, value: undefined as unknown as StreamChunk }),
			}),
		};
	}

	registerTool(definition: ToolDefinition): () => void {
		this.tools.set(definition.name, definition);
		this.registrationOrder.push(definition.name);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.tools.delete(definition.name);
		};
	}

	onPreStep(listener: (info: PreStepInfo) => PreStepDecision | Promise<PreStepDecision>): () => void {
		this.preStepListeners.add(listener);
		return () => {
			this.preStepListeners.delete(listener);
		};
	}
}

/** Minimal tool execution context (identity + live signal, no-op deferrals). */
export function execContext(name: string, args: Record<string, unknown>): ToolRunContext {
	return {
		callId: `test-${name}-${Math.random().toString(36).slice(2, 10)}`,
		name,
		arguments: args,
		signal: new AbortController().signal,
		deferContext: () => {},
		concludeTurn: () => {},
	} as unknown as ToolRunContext;
}

/** Execute a registered tool; its canonical output must be the reply string. */
export async function callTool(host: McHost, name: string, args: Record<string, unknown>): Promise<string> {
	const definition = host.tools.get(name);
	if (!definition) throw new Error(`tool '${name}' is not registered`);
	const value = await definition.execute(args, execContext(name, args));
	if (typeof value !== "string") {
		throw new Error(`tool '${name}' returned non-string canonical value: ${String(value)}`);
	}
	return value;
}

/**
 * Crash-resume evidence from the durable log: `mc/manage-start` brackets with
 * no matching `mc/manage-end` (matched on changeId). The data model allows at
 * most one open bracket per session.
 */
export function openBrackets(session: FakeMcSession): FakeLogEntry[] {
	const ended = new Set(session.eventsOf("mc/manage-end").map((entry) => String(entry.data.changeId)));
	return session.eventsOf("mc/manage-start").filter((entry) => !ended.has(String(entry.data.changeId)));
}
