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
import type { Context } from "@deepseek-ai/cordis";
import type {
	PreStepDecision as AgentPreStepDecision,
	AgentRegistry,
	ModelSelection,
} from "@deepseek-ai/dsh-agent";
import { CommandId } from "@deepseek-ai/dsh-commands/brand";
import {
	CompactionId,
	compactCheckpointSource,
} from "@deepseek-ai/dsh-compaction";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import { MessageId } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { Session, SessionStore } from "@deepseek-ai/dsh-session";
import {
	appendPluginRecord,
	deriveEventMessage,
	isSurfaceEvent,
} from "@deepseek-ai/dsh-session";
import type { SessionEventMap } from "@deepseek-ai/dsh-session/types";
import { SessionId, SessionSeq } from "@deepseek-ai/dsh-session/types";
import type { SessionSurfaceSnapshot } from "@deepseek-ai/dsh-session-query";
import type { TokenMeter } from "@deepseek-ai/dsh-token-meter";
import type {
	PostToolDecision,
	ToolDefinition,
	ToolExecutionResult,
	ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { log } from "@magic-context/core/shared/logger";
import type {
	CompactionEndData,
	CompactionLifecycleEvent,
	CompactionStartData,
	CompactionSummaryData,
	DshHost,
	DshSession,
	McCheckpointSource,
	PostToolInfo,
	PostToolVerdict,
	PreStepDecision,
	PreStepInfo,
	PressureReading,
	RequestErrorInfo,
	TodoState,
} from "./host.js";
import type { HistorianRoute } from "./sessions/historian.js";
import type { DshLogMessageRecord } from "./surface/dsh-session-log.js";
import type { McManageRecord, McReplacementContent } from "./surface/events.js";
import {
	MC_REWRITE_EVENT_TYPE,
	mcRewriteProjection,
} from "./surface/rewrite-projection.js";

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
			...(header.parentSession !== undefined
				? { parentSession: header.parentSession }
				: {}),
			...(header.delegationDepth !== undefined
				? { delegationDepth: header.delegationDepth }
				: {}),
			...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
		},
		surfaceNodes: () => [...session.surface.nodes],
		async replaceSurface(replacement, startSeq, endSeq, shadowedSeqs, options) {
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
				const begin =
					first === 0 &&
					last > 0 &&
					session.eventAt(nodes[0] as SessionSeq)?.type === "system/message"
						? 1
						: first;
				const span = nodes.slice(begin, last + 1);
				if (span.length === 0)
					throw new Error(
						"surface replace: span covers only the protected system prompt",
					);
				start = span[0]!;
				end = span[span.length - 1]!;
				shadowed = span;
			}
			const checkpoint = options?.checkpoint;
			const event = session.append(
				"user/message",
				{
					id: MessageId(`mc-edit-${randomUUID()}`),
					role: "user",
					content: replacement,
					// A manual `/compact` fold stamps the host's own checkpoint
					// source (T072); every other managed edit is a plugin notice.
					source:
						checkpoint === undefined
							? { kind: "magic-context" }
							: (compactCheckpointSource(
									CompactionId(checkpoint.compactionId),
									checkpoint.sourceCommandId !== undefined
										? CommandId(checkpoint.sourceCommandId)
										: undefined,
								) as never),
				},
				{
					surfaceOp: {
						op: "replace",
						startSeq: SessionSeq(start),
						endSeq: SessionSeq(end),
					},
					sourceEventSeqs: shadowed.map((seq) => SessionSeq(seq)),
				},
			);
			return { replacementSeq: event.seq };
		},
		async rewriteToolResult(seq: number, content: McReplacementContent) {
			const original = session.eventAt(SessionSeq(seq));
			if (original === undefined || original.type !== "tool/result") {
				throw new Error(
					`tool-result rewrite refused: surface seq ${String(seq)} is not a durable tool/result node`,
				);
			}
			// Content-only: every other field is copied from the original event,
			// which is exactly what `assertToolResultRewrite` verifies.
			const event = session.append(
				"tool/result",
				{ ...original.data, message: { ...original.data.message, content } },
				{
					surfaceOp: {
						op: "replace",
						startSeq: SessionSeq(seq),
						endSeq: SessionSeq(seq),
					},
					sourceEventSeqs: [SessionSeq(seq)],
				},
			);
			return { replacementSeq: event.seq };
		},
		async rewriteUserMessage(seq: number, content: McReplacementContent) {
			const original = session.eventAt(SessionSeq(seq));
			if (original === undefined || original.type !== "user/message") {
				throw new Error(
					`user rewrite refused: surface seq ${String(seq)} is not a durable user/message node`,
				);
			}
			const event = session.append(
				"user/message",
				{
					id: MessageId(`mc-edit-${randomUUID()}`),
					role: "user",
					content,
					source: { kind: "magic-context" },
				},
				{
					surfaceOp: {
						op: "replace",
						startSeq: SessionSeq(seq),
						endSeq: SessionSeq(seq),
					},
					sourceEventSeqs: [SessionSeq(seq)],
				},
			);
			return { replacementSeq: event.seq };
		},
		async rewriteAssistantBody(seq: number, content: McReplacementContent) {
			const original = session.eventAt(SessionSeq(seq));
			if (original === undefined || original.type !== "assistant/message") {
				throw new Error(
					`assistant rewrite refused: surface seq ${String(seq)} is not a durable assistant/message node`,
				);
			}
			// The projection event is ignorable and owner-scoped: a build
			// without this plugin skips it and sees the original body.
			const eventSeq = appendPluginRecord(session, MC_REWRITE_EVENT_TYPE, {
				targetSeq: seq,
				messageId: String(original.data.message.id),
				content,
				ignorable: true,
			});
			return { eventSeq: Number(eventSeq) };
		},
		async appendTail(content: McReplacementContent) {
			const event = session.append(
				"user/message",
				{
					id: MessageId(`mc-notice-${randomUUID()}`),
					role: "user",
					content,
					source: { kind: "magic-context" },
				},
				{ surfaceOp: "append" },
			);
			return { seq: event.seq };
		},
		async appendLogEvent(type, data) {
			// Plugin-owned bracket bookkeeping rides the ignorable plugin-record
			// channel: the reopen validator admits only KNOWN_SESSION_EVENT_TYPES
			// or ignorable envelopes, and out-of-repo types are outside the known
			// set by construction (observed 0.2.2-rc.1).
			const seq = appendPluginRecord(session, "plugin:magic-context/manage", {
				...data,
				kind: type,
			} as McManageRecord);
			return { seq };
		},
		async appendCompactionEvent(lifecycle: CompactionLifecycleEvent) {
			const { phase, data } = lifecycle;
			// The start…end pair is the host's compaction lock and the summary
			// event is the shadow-price anchor; both are log-only (no surfaceOp).
			const id = CompactionId(data.compactionId);
			if (phase === "start") {
				const start = data as CompactionStartData;
				const event = session.append("compaction/start", {
					compactionId: id,
					...(start.sourceCommandId !== undefined
						? { sourceCommandId: CommandId(start.sourceCommandId) }
						: {}),
					turn: start.turn,
				});
				return { seq: event.seq };
			}
			if (phase === "summary") {
				const summary = data as CompactionSummaryData;
				// The host models "marked" vs "unmarked" summarizers as a
				// discriminated union; our seam types the two optional fields
				// independently, so the payload is narrowed here.
				const event = session.append("compaction/summary", {
					compactionId: id,
					...(summary.sourceCommandId !== undefined
						? { sourceCommandId: CommandId(summary.sourceCommandId) }
						: {}),
					summary: summary.summary,
					shadowedRange: {
						start: SessionSeq(summary.shadowedRange.start),
						end: SessionSeq(summary.shadowedRange.end),
					},
					shadowedSeqs: summary.shadowedSeqs.map((seq) => SessionSeq(seq)),
					shadowedTokenCount: summary.shadowedTokenCount,
					provider: summary.provider,
					model: summary.model,
					...(summary.maxTokens !== undefined
						? { maxTokens: summary.maxTokens }
						: {}),
					...(summary.usage !== undefined
						? { usage: summary.usage as never }
						: {}),
					...(summary.rawOutput !== undefined
						? { rawOutput: summary.rawOutput }
						: {}),
					...(summary.llmStreamCall === true
						? { llmStreamCall: true as const }
						: {}),
				} as never);
				return { seq: event.seq };
			}
			const end = data as CompactionEndData;
			const event = session.append("compaction/end", {
				compactionId: id,
				...(end.sourceCommandId !== undefined
					? { sourceCommandId: CommandId(end.sourceCommandId) }
					: {}),
				turn: end.turn,
				...(end.error !== undefined ? { error: end.error } : {}),
			});
			return { seq: event.seq };
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
	/**
	 * Sees each step's model selection; feeds the historian route (host-owned
	 * model) and the mural capability (image input, FR-006). `imageInput` is
	 * the routed model's advertised modality — unknown routes report false.
	 */
	readonly observeModel?: (
		sessionId: string,
		selection: ModelSelection | undefined,
		imageInput: boolean,
	) => void;
}

export function createCordisHost(
	ctx: Context,
	options: CordisHostOptions = {},
): DshHost {
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
	// T044: the band's window is the CURRENT routed model's capacity, resolved
	// from the provider catalog on every pre-step that carries a model
	// selection. The meter's recorded window describes the LAST request's
	// model, so after a mid-session route switch (or an agent-default change)
	// pricing against it both misbands the pass and can deadlock a refusal —
	// the refusal blocks the very request that would refresh the reading
	// (spec Edge Cases — model switch; observed live on 0.2.2-rc.1).
	const routedWindows = new Map<string, number>();
	// N-06: route observations die with the session even without a consumer.
	ctx.on("agent/disposed", (payload) => {
		routedWindows.delete(payload.agent.session.id);
	});
	return {
		ctx,
		getSession,
		todoState(sessionId: string): TodoState | undefined {
			return source?.todoState(sessionId);
		},
		pressure(sessionId: string): PressureReading | undefined {
			const agent = ctx.agents.get(SessionId(sessionId));
			if (!agent) return undefined;
			const meter: TokenMeter | undefined = (ctx as { tokenMeter?: TokenMeter })
				.tokenMeter;
			if (!meter) return undefined;
			const projection = meter.contextPressure(agent.session);
			const routed = routedWindows.get(sessionId);
			const contextWindow = routed ?? projection.contextWindow;
			return {
				...(projection.pressureTokens !== undefined
					? { pressureTokens: projection.pressureTokens }
					: {}),
				...(contextWindow !== undefined ? { contextWindow } : {}),
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
		registerRewriteProjection(): () => void {
			// Registered on the session store the moment the plugin mounts, so
			// every live session and every restored one derives the rewrite.
			const dispose =
				ctx.sessions.registerMessageProjection(mcRewriteProjection);
			return () => {
				void dispose();
			};
		},
		onPreStep(
			listener: (
				info: PreStepInfo,
			) => PreStepDecision | Promise<PreStepDecision>,
		): () => void {
			return ctx.on("agent/pre-step", (payload, next) =>
				(async (): Promise<AgentPreStepDecision> => {
					const sessionId = payload.agent.session.id;
					// Hidden maintenance children are never managed: no head, no
					// snapshot, no lanes — the dreamer owns those sessions.
					if (sessionId.startsWith("session-mc-maint-"))
						return (await next()) as AgentPreStepDecision;
					let imageInput = false;
					if (payload.modelSelection !== undefined) {
						// Resolve the routed model's capacity for band pricing
						// (see routedWindows). Best effort: an unresolved route
						// falls back to the meter's recorded window.
						try {
							const prepared = await ctx.llm.prepareCall({
								provider: payload.modelSelection.provider,
								model: payload.modelSelection.model,
							});
							const capacity = prepared.context?.contextWindow;
							if (capacity !== undefined)
								routedWindows.set(sessionId, capacity);
							else routedWindows.delete(sessionId);
							imageInput = prepared.inputModalities?.includes("image") === true;
							log(
								`[dsh-magic-context] routed window for ${sessionId}: ${payload.modelSelection.provider}/${payload.modelSelection.model} ⇒ ${capacity ?? "undisclosed"}`,
							);
						} catch {
							routedWindows.delete(sessionId);
						}
					} else {
						routedWindows.delete(sessionId);
					}
					observeModel?.(sessionId, payload.modelSelection, imageInput);
					if (source !== undefined) {
						// The pass bridge reads the snapshot synchronously; refresh
						// it here, the one async moment before every listener. A
						// failed read means an unverifiable history ⇒ fail closed
						// (FR-004): refuse with a visible notice, never run unmanaged.
						try {
							await source.prefetch(sessionId);
						} catch (error) {
							log(
								`[dsh-magic-context] session-log prefetch failed for ${sessionId}; refusing step fail-closed: ${error instanceof Error ? error.message : String(error)}`,
							);
							try {
								// Awaited: a floating promise here is the
								// unhandled-rejection class DSH treats as
								// process-fatal (N-08). The enclosing
								// function is already async.
								await getSession(sessionId)?.appendTail([
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
					const decision = await listener({
						sessionId,
						turn: payload.turn,
						step: payload.step,
					});
					return decision === "reject" ? { kind: "reject" } : next();
				})(),
			);
		},
		onSessionClosed(handler: (sessionId: string) => void): () => void {
			// N-06: `agent/disposed` is DSH's session-close signal — the agent
			// left the registry (host runtime-types: emitted after driver
			// quiescence and scoped-registration unwind). One session, one
			// agent: this is when its resident state may go.
			return ctx.on("agent/disposed", (payload) => {
				handler(payload.agent.session.id);
			});
		},
		onRequestError(
			listener: (info: RequestErrorInfo) => boolean | Promise<boolean>,
		): () => void {
			return ctx.on("agent/request-error", (payload, next) =>
				(async () => {
					const handled = await listener({
						sessionId: payload.agent.session.id,
						turn: payload.turn,
						step: payload.step,
						provider: payload.provider,
						failure: payload.failure,
					});
					if (handled) return { kind: "retry" } as const;
					return next();
				})(),
			);
		},
		onPostToolExecute(
			listener: (
				info: PostToolInfo,
			) => PostToolVerdict | undefined | Promise<PostToolVerdict | undefined>,
		): () => void {
			return ctx.on("tools/post-execute", (exec, result, next) =>
				(async () => {
					const decision = await next();
					const sessionId = exec.agent?.session.id;
					if (sessionId === undefined || decision.kind !== "accept")
						return decision;
					// The verdict replaces the result's content BEFORE
					// materialization, so the rewrite is what the session logs —
					// the durable half of the post-execute channel.
					const verdict = await listener({
						sessionId,
						toolName: exec.name,
						...(exec.rootCallId !== undefined
							? { toolCallId: String(exec.rootCallId) }
							: {}),
						text: textOfDecision(decision, result),
					});
					if (verdict === undefined) return decision;
					const content = verdict.content ?? contentOfDecision(decision);
					return {
						kind: "accept",
						...(content !== undefined
							? { content }
							: { value: valueOfDecision(decision) }),
						...(verdict.additionalContext !== undefined
							? {
									additionalContexts: [
										...(decision.additionalContexts ?? []),
										{ role: "user", content: verdict.additionalContext },
									],
								}
							: decision.additionalContexts !== undefined
								? { additionalContexts: decision.additionalContexts }
								: {}),
					} as PostToolDecision;
				})(),
			);
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
	readonly read: (
		dshSessionId: string,
	) => readonly DshLogMessageRecord[] | undefined;
	prefetch(dshSessionId: string): Promise<void>;
	/** Latest `todo/write` state seen while projecting the log (T034). */
	todoState(dshSessionId: string): TodoState | undefined;
}

export function createCordisSessionLogSource(
	ctx: Context,
): CordisSessionLogSource {
	const cache = new Map<string, readonly DshLogMessageRecord[]>();
	const todos = new Map<string, TodoState>();
	// N-06: the cached surface snapshot (full record bodies) is the dominant
	// resident-host growth item; it must not outlive the session. Entries are
	// re-read from the host on the next prefetch, so this is pure release.
	ctx.on("agent/disposed", (payload) => {
		const sessionId = payload.agent.session.id;
		cache.delete(sessionId);
		todos.delete(sessionId);
	});
	return {
		read: (dshSessionId) => cache.get(dshSessionId),
		async prefetch(dshSessionId: string): Promise<void> {
			const snapshot: SessionSurfaceSnapshot =
				await ctx.sessionQuery.readSurface(SessionId(dshSessionId));
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
					.filter(
						(block): block is { type: "text"; text: string } =>
							block.type === "text",
					)
					.map((block) => block.text)
					.join("\n");
				const replayBlocks = (
					message.source as {
						replayState?: {
							blocks?: readonly { type: string; signature?: string }[];
						};
					}
				).replayState?.blocks;
				records.push({
					seq: Number(event.seq),
					messageId: String(message.id),
					role: message.role,
					text,
					createdAt: event.time,
					blocks: message.content,
					...(message.role === "tool"
						? { toolCallId: String(message.toolCallId) }
						: {}),
					...(replayBlocks?.some(
						(block) =>
							block.type === "reasoning" && typeof block.signature === "string",
					)
						? { reasoningSigned: true }
						: {}),
					...(message.role === "tool" && message.isError === true
						? { isError: true }
						: {}),
				});
			}
			cache.set(dshSessionId, records);
			// `todo/write` is log-only (no surface), so it never reaches the
			// message projection; capture the newest one here while the snapshot
			// is already in hand.
			for (const event of snapshot.events as readonly {
				type: string;
				seq: number;
				data?: unknown;
			}[]) {
				if (event.type !== "todo/write") continue;
				const data = event.data as { items?: unknown } | undefined;
				const items = Array.isArray(data?.items)
					? (data.items as { content?: unknown; status?: unknown }[])
					: [];
				todos.set(dshSessionId, {
					seq: Number(event.seq),
					items: items
						.filter((item) => typeof item.content === "string")
						.map((item) => ({
							content: String(item.content),
							status: String(item.status ?? "pending"),
						})),
				});
			}
		},
		todoState: (dshSessionId: string) => todos.get(dshSessionId),
	};
}

/**
 * Historian route following the live session's model selection (host fact:
 * route selection is DSH-owned per step; MC rides it, configures nothing).
 * The getters re-read on every fold call, so a model switch takes effect on
 * the next fold without remounting.
 */
export function createCordisHistorianRoute(): {
	readonly observe: (
		sessionId: string,
		selection: ModelSelection | undefined,
		imageInput: boolean,
	) => void;
	readonly route: HistorianRoute;
} {
	// N-15: model selection is per agent. A single process-global "last
	// prepare wins" selection made concurrent sessions price their folds
	// against whichever session most recently stepped; the observed
	// selection is now kept per session, with the last observation as the
	// fallback for folds of never-observed sessions.
	const perSession = new Map<
		string,
		{ selection: ModelSelection; imageInput: boolean }
	>();
	let last: { selection: ModelSelection; imageInput: boolean } | undefined;
	return {
		observe: (sessionId, selection, modalities) => {
			if (selection === undefined) return;
			last = { selection, imageInput: modalities };
			perSession.set(sessionId, last);
		},
		route: {
			get provider(): string {
				return last?.selection.provider ?? "";
			},
			get model(): string {
				return last?.selection.model ?? "";
			},
			get imageInput(): boolean {
				return last?.imageInput ?? false;
			},
			forSession: (sessionId) => {
				const seen = perSession.get(sessionId) ?? last;
				if (seen === undefined) return undefined;
				return {
					provider: seen.selection.provider,
					model: seen.selection.model,
					imageInput: seen.imageInput,
				};
			},
		},
	};
}

/** Flatten an accepted decision's content for the observer (text only). */
function textOfDecision(
	decision: PostToolDecision,
	result: Readonly<ToolExecutionResult>,
): string {
	const content = contentOfDecision(decision) ?? result.content;
	return (content ?? [])
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("\n");
}

/** The content an accepted decision carries (a `value` decision has none). */
function contentOfDecision(
	decision: PostToolDecision,
): McReplacementContent | undefined {
	return decision.kind === "accept" && "content" in decision
		? (decision.content as McReplacementContent | undefined)
		: undefined;
}

/** The value an accepted decision carries, for pass-through of value-form results. */
function valueOfDecision(decision: PostToolDecision): never {
	return (
		decision.kind === "accept" && "value" in decision
			? decision.value
			: undefined
	) as never;
}
