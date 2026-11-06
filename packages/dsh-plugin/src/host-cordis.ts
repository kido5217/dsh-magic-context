/**
 * Production host adapter (T007): `DshHost` over the real Cordis `ctx`.
 *
 * Thin on purpose — every seam is the sanctioned one (dsh-api.md):
 * - sessions: `ctx.agents.get(sessionId)` → live `Session`;
 * - surface edits: `session.append('user/message', …, { surfaceOp })` —
 *   replace shadows `startSeq…endSeq` citing every shadowed node in
 *   `sourceEventSeqs` (compaction precedent, docs/subsystems/session.md);
 * - log-only bracket bookkeeping: `appendPluginRecord(session, "plugin:magic-context/manage", {kind, …})` (declared in
 *   surface/events.ts); durability barrier: `ctx.sessions.flush`;
 * - pressure: `ctx.tokenMeter.contextPressure(session)`;
 * - aux LLM: `ctx.llm.stream` (request-only, purpose 'magic-context');
 * - tools: `ctx.tools.register` (returns the fiber-scoped disposer);
 * - pre-step: `ctx.on('agent/pre-step', …)` waterfall listener — returning
 *   `{ kind: 'reject' }` without calling `next()` short-circuits the step.
 */
import { randomUUID } from "node:crypto";
import { log } from "@magic-context/core/shared/logger";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentRegistry, ModelSelection, PreStepDecision as AgentPreStepDecision } from "@deepseek-ai/dsh-agent";
import type { SessionStore } from "@deepseek-ai/dsh-session";
import type { Session } from "@deepseek-ai/dsh-session";
import { appendPluginRecord, deriveEventMessage, isSurfaceEvent } from "@deepseek-ai/dsh-session";
import type { SessionSurfaceSnapshot } from "@deepseek-ai/dsh-session-query";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import type { SessionEventMap } from "@deepseek-ai/dsh-session/types";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { MessageId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { DshHost, DshSession, PressureReading, PreStepDecision, PreStepInfo } from "./host.js";
import type { McManageRecord, McReplacementContent } from "./surface/events.js";
import type { DshLogMessageRecord } from "./surface/dsh-session-log.js";
import type { HistorianRoute } from "./sessions/historian.js";

declare module "@deepseek-ai/dsh-llm" {
	interface MessageSourceMap {
		/** MC surface edits: bracketed notices attributed to this plugin. */
		"magic-context": {
			kind: "magic-context";
			/** Correlates the node with its mc/manage-start…end bracket. */
			changeId?: string;
		};
	}
}

function wrapSession(ctx: Context, session: Session): DshSession {
	const header = session.header;
	return {
		id: session.id,
		header: {
			id: session.id,
			...(header.origin !== undefined ? { origin: header.origin } : {}),
			...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}),
			...(header.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
			...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
		},
		surfaceNodes: () => [...session.surface.nodes],
		async replaceSurface(replacement, startSeq, endSeq, shadowedSeqs) {
			// The host's canonical surface contract requires sourceEventSeqs to
			// cite every surface node the span covers — the caller knows the
			// managed messages, the live session knows the nodes (notice and head
			// nodes between them included; replaced ranges cite their current
			// replacement node). Expand from the live node list, and never start
			// a span on the protected system-prompt node (observed 0.2.2-rc.1).
			let start = startSeq;
			let end = endSeq;
			let shadowed = [...shadowedSeqs];
			const nodes = [...session.surface.nodes] as number[];
			const first = nodes.indexOf(startSeq);
			const last = nodes.indexOf(endSeq);
			if (first >= 0 && last >= first) {
				const begin = first === 0 && last > 0 && session.eventAt(nodes[0] as SessionSeq)?.type === "system/message" ? 1 : first;
				const span = nodes.slice(begin, last + 1);
				if (span.length === 0) throw new Error("surface replace: span covers only the protected system prompt");
				start = span[0]!;
				end = span[span.length - 1]!;
				shadowed = span;
			}
			const event = session.append("user/message", {
				id: MessageId(`mc-edit-${randomUUID()}`),
				role: "user",
				content: replacement,
				source: { kind: "magic-context" },
			}, {
				surfaceOp: { op: "replace", startSeq: SessionSeq(start), endSeq: SessionSeq(end) },
				sourceEventSeqs: shadowed.map((seq) => SessionSeq(seq)),
			});
			return { replacementSeq: event.seq };
		},
		async appendNotice(content: McReplacementContent) {
			const event = session.append("user/message", {
				id: MessageId(`mc-notice-${randomUUID()}`),
				role: "user",
				content,
				source: { kind: "magic-context" },
			}, { surfaceOp: "append" });
			return { seq: event.seq };
		},
		async appendLogEvent(type, data) {
			// Plugin-owned bracket bookkeeping rides the ignorable plugin-record
			// channel: the reopen validator admits only KNOWN_SESSION_EVENT_TYPES
			// or ignorable envelopes, and out-of-repo types are outside the known
			// set by construction (observed 0.2.2-rc.1).
			const seq = appendPluginRecord(session, "plugin:magic-context/manage", { ...data, kind: type } as McManageRecord);
			return { seq };
		},
		async flush() {
			await ctx.sessions.flush(session);
		},
	};
}

/** Build the production `DshHost` over a live Cordis context. */
export interface CordisHostOptions {
	/**
	 * Durable-log snapshot source; when present, every tool execution refreshes
	 * the calling session's snapshot first (best effort), and every pre-step
	 * refreshes it BEFORE the listener (hard requirement: failure refuses the
	 * step fail-closed, FR-004).
	 */
	readonly sessionLog?: CordisSessionLogSource;
	/** Sees each step's model selection; feeds the historian route (host-owned model). */
	readonly observeModel?: (selection: ModelSelection | undefined) => void;
}

export function createCordisHost(ctx: Context, options: CordisHostOptions = {}): DshHost {
	const { observeModel } = options;
	const source = options.sessionLog;
	const prefetch = source
		? async (sessionId: string): Promise<void> => {
				try {
					await source.prefetch(sessionId);
				} catch {
					/* stale snapshot retained; the next read refreshes */
				}
			}
		: undefined;
	const getSession = (sessionId: string): DshSession | undefined => {
		const agent = ctx.agents.get(SessionId(sessionId));
		return agent ? wrapSession(ctx, agent.session) : undefined;
	};
	return {
		ctx,
		getSession,
		pressure(sessionId: string): PressureReading | undefined {
			const agent = ctx.agents.get(SessionId(sessionId));
			if (!agent) return undefined;
			const meter: TokenMeter | undefined = (ctx as { tokenMeter?: TokenMeter }).tokenMeter;
			if (!meter) return undefined;
			const projection = meter.contextPressure(agent.session);
			return {
				...(projection.pressureTokens !== undefined ? { pressureTokens: projection.pressureTokens } : {}),
				...(projection.contextWindow !== undefined ? { contextWindow: projection.contextWindow } : {}),
			};
		},
		llmStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
			return ctx.llm.stream(options);
		},
		registerTool(definition: ToolDefinition): () => void {
			if (prefetch === undefined) return ctx.tools.register(definition);
			const wrapped: ToolDefinition = {
				...definition,
				async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
					const sessionId = exec.agent?.session.id;
					if (sessionId !== undefined) await prefetch(sessionId);
					return definition.execute(args, exec);
				},
			};
			return ctx.tools.register(wrapped);
		},
		onPreStep(listener: (info: PreStepInfo) => PreStepDecision | Promise<PreStepDecision>): () => void {
			return ctx.on("agent/pre-step", (payload, next) =>
				(async (): Promise<AgentPreStepDecision> => {
					const sessionId = payload.agent.session.id;
					observeModel?.(payload.modelSelection);
					if (source !== undefined) {
						// The pass bridge reads the snapshot synchronously; refresh
						// it here, the one async moment before every listener. A
						// failed read means an unverifiable history ⇒ fail closed
						// (FR-004): refuse with a visible notice, never run unmanaged.
						try {
							await source.prefetch(sessionId);
						} catch (error) {
							log(`[dsh-magic-context] session-log prefetch failed for ${sessionId}; refusing step fail-closed: ${error instanceof Error ? error.message : String(error)}`);
							try {
								getSession(sessionId)?.appendNotice([
									{
										type: "text",
										text: "Magic Context could not read the session log before this step and refused it (fail-closed): the pass never runs on an unverifiable history.",
									},
								]);
							} catch {
								// Notice loss must not change the refusal.
							}
							return { kind: "reject" };
						}
					}
					const decision = await listener({ sessionId, turn: payload.turn, step: payload.step });
					return decision === "reject" ? { kind: "reject" } : next();
				})());
		},
	};
}

/** Re-exported for typing clarity where the registry key matters. */
export type { AgentRegistry };

/**
 * Durable-log snapshot source (T025 production wiring): the pass bridge reads
 * synchronously, so the snapshot is refreshed at well-defined async moments —
 * before every pre-step listener (apply() registers the prefetch listener
 * first) and before every tool execution (see `registerTool` above). Reads go
 * through `ctx.sessionQuery.readSurface` — live-preferred, replay-validated,
 * model-history order — and messages come from the canonical
 * `deriveEventMessage` projection, so the adapter projects exactly what the
 * model would see.
 */
export interface CordisSessionLogSource {
	readonly read: (dshSessionId: string) => readonly DshLogMessageRecord[] | undefined;
	prefetch(dshSessionId: string): Promise<void>;
}

export function createCordisSessionLogSource(ctx: Context): CordisSessionLogSource {
	const cache = new Map<string, readonly DshLogMessageRecord[]>();
	return {
		read: (dshSessionId) => cache.get(dshSessionId),
		async prefetch(dshSessionId: string): Promise<void> {
			const snapshot: SessionSurfaceSnapshot = await ctx.sessionQuery.readSurface(SessionId(dshSessionId));
			const records: DshLogMessageRecord[] = [];
			for (const event of snapshot.events) {
				if (!isSurfaceEvent(event)) continue;
				// The host's rendered system prompt is surface node 0, protected
				// from plugin rewrites, and later `system/message` notes are
				// host-managed prompt content — not conversation history MC may
				// tag, drop, or fold (observed 0.2.2-rc.1: a span covering node 0
				// is admitted only as a system/message over exactly that node).
				if (event.type === "system/message") continue;
				const message = deriveEventMessage(event);
				if (message === null) continue;
				const text = message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
				records.push({
					seq: Number(event.seq),
					messageId: String(message.id),
					role: message.role,
					text,
					createdAt: event.time,
				});
			}
			cache.set(dshSessionId, records);
		},
	};
}

/**
 * Historian route following the live session's model selection (host fact:
 * route selection is DSH-owned per step; MC rides it, configures nothing).
 * The getters re-read on every fold call, so a model switch takes effect on
 * the next fold without remounting.
 */
export function createCordisHistorianRoute(): {
	readonly observe: (selection: ModelSelection | undefined) => void;
	readonly route: HistorianRoute;
} {
	let current: ModelSelection | undefined;
	return {
		observe: (selection) => {
			if (selection !== undefined) current = selection;
		},
		route: {
			get provider(): string {
				return current?.provider ?? "";
			},
			get model(): string {
				return current?.model ?? "";
			},
		},
	};
}
