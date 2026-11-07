/**
 * Hidden-agent maintenance transport (T055).
 *
 * Tool-loop dreamer tasks (map-memories, verify, verify-broad, curate,
 * retrospective, maintain-docs, refresh-primers, smart-note confirmation
 * prompts) run a real agent: the shared carrier contract says the carrier
 * owns the tool steps. On DSH that carrier is a parentless agent on its own
 * session — `ctx.agents.create` with `origin: 'subagent'`, a restricted tool
 * surface, a step counter and a token budget enforced at `agent/pre-step`,
 * driven with one follow-up message and torn down with the handle disposer
 * (which removes the session: nothing durable survives a maintenance run;
 * crash residue is reaped at boot by `orphans.ts`).
 *
 * The Cordis wiring sits behind `MaintenanceAgentRuntime` so the carrier
 * logic — timeouts, budget, cancellation, usage, settlement reading — is
 * testable without a harness.
 */
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { deriveEventMessage, isSurfaceEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type { TokenTotals } from "@magic-context/core/features/magic-context/subagent-token-capture";
import type {
	HiddenCompletion,
	HiddenCompletionExecutor,
	HiddenRunHandle,
	HiddenRunIdentity,
} from "@magic-context/core/hooks/magic-context/compartment-runner-types";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { PromptArgs } from "@magic-context/core/shared/model-suggestion-retry";

export interface MaintenanceModelRoute {
	readonly provider: string;
	readonly model: string;
}

/** What the carrier decides about each proposed step of a maintenance run. */
export type MaintenanceStepDecision = "run" | "wrap-up" | "refuse";

/** One live maintenance agent, owned by the carrier that launched it. */
export interface MaintenanceAgentHandle {
	/** Send the task message and settle the turn (resolves when idle). */
	prompt(text: string, model: MaintenanceModelRoute | undefined): Promise<void>;
	/** Abandon the turn in flight (lease loss / deadline). */
	cancel(): void;
	/** The final assistant text of the run, or null when it produced none. */
	lastAssistant(): Promise<string | null>;
	/** Tear the agent down and REMOVE its session (hidden by contract). */
	dispose(): Promise<void>;
}

/** Host seam implemented by the Cordis wiring (production) or a double. */
export interface MaintenanceAgentRuntime {
	launch(spec: {
		readonly sessionId: string;
		readonly cwd: string;
		readonly model: MaintenanceModelRoute | undefined;
		readonly allowlist: readonly string[];
		readonly maxOutputTokens: number | undefined;
		/** Called once per proposed step (1-based) BEFORE the step runs. */
		onStep: (stepCount: number) => MaintenanceStepDecision;
		/** Called with each model call's usage as the run proceeds. */
		onUsage: (usage: { input: number; output: number }) => void;
	}): Promise<MaintenanceAgentHandle>;
}

export interface MaintenanceAgentTransportOptions {
	/** Hard step cap per run (default 24). */
	readonly maxSteps?: number;
	/** Output tokens after which the agent is told to finish (default 100k). */
	readonly maxRunTokens?: number;
	/** Tool names the maintenance agent may see. */
	readonly toolAllowlist?: readonly string[];
}

const WRAP_UP_TEXT =
	"Your tool-use budget for this maintenance run is exhausted. Reply now with the complete final answer only — no further tool calls.";

interface AgentRunState {
	readonly identity: HiddenRunIdentity;
	agent?: MaintenanceAgentHandle;
	usage: TokenTotals & { reasoning?: number };
	steps: number;
	lastText: string | null;
	lastError?: unknown;
}

function emptyUsage(): TokenTotals & { reasoning?: number } {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

function routeOf(spec: unknown): MaintenanceModelRoute | undefined {
	if (typeof spec !== "object" || spec === null) return undefined;
	const provider = (spec as { providerID?: unknown }).providerID;
	const model = (spec as { modelID?: unknown }).modelID;
	return typeof provider === "string" && typeof model === "string"
		? { provider, model }
		: undefined;
}

export class DshHiddenAgentTransport implements HiddenCompletionExecutor {
	readonly capabilities = { tools: true, harness: "dsh" } as const;

	private readonly runs = new Map<string, AgentRunState>();
	private readonly maxSteps: number;
	private readonly maxRunTokens: number;
	private readonly allowlist: readonly string[];

	constructor(
		private readonly runtime: MaintenanceAgentRuntime,
		options: MaintenanceAgentTransportOptions = {},
	) {
		this.maxSteps = options.maxSteps ?? 24;
		this.maxRunTokens = options.maxRunTokens ?? 100_000;
		this.allowlist = options.toolAllowlist ?? ["read"];
	}

	async open(run: HiddenRunIdentity): Promise<HiddenRunHandle> {
		const id = `session-mc-maint-${randomUUID()}`;
		const state: AgentRunState = {
			identity: run,
			usage: emptyUsage(),
			steps: 0,
			lastText: null,
		};
		this.runs.set(id, state);
		const agent = await this.runtime.launch({
			sessionId: id,
			cwd: run.directory,
			model: routeOf(run.model),
			allowlist: this.allowlist,
			maxOutputTokens: run.maxOutputTokens,
			onStep: (stepCount) => {
				state.steps = stepCount;
				if (stepCount > this.maxSteps) return "refuse";
				if (state.usage.input + state.usage.output >= this.maxRunTokens)
					return "wrap-up";
				return "run";
			},
			onUsage: (usage) => {
				state.usage = {
					...state.usage,
					input: state.usage.input + usage.input,
					output: state.usage.output + usage.output,
				};
			},
		});
		state.agent = agent;
		return { id, childSessionId: id };
	}

	async attempt(handle: HiddenRunHandle, request: PromptArgs): Promise<void> {
		const state = this.runs.get(handle.id);
		const agent = state?.agent;
		if (state === undefined || agent === undefined)
			throw new Error("magic-context: unknown maintenance agent run");
		const body = (request.body ?? {}) as Record<string, unknown>;
		const parts = Array.isArray(body["parts"]) ? body["parts"] : [];
		const prompt = parts
			.filter(
				(part): part is { type: string; text: string } =>
					typeof part === "object" &&
					part !== null &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			)
			.map((part) => part.text)
			.join("\n");
		const model = routeOf(body["model"]);
		if (model !== undefined)
			handle.attemptedModel = `${model.provider}/${model.model}`;
		const abort = request.signal;
		let settleAbort: (() => void) | undefined;
		const cancelled = new Promise<never>((_done, reject) => {
			settleAbort = () => reject(new Error("maintenance run cancelled"));
			if (abort?.aborted === true) settleAbort();
			else abort?.addEventListener("abort", settleAbort, { once: true });
		});
		const deadlineMs = state.identity.timeoutMs;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_done, reject) => {
			timer = setTimeout(() => {
				reject(new Error("maintenance run exceeded its deadline"));
			}, deadlineMs);
		});
		try {
			await Promise.race([agent.prompt(prompt, model), cancelled, deadline]);
		} catch (error) {
			// Lease loss or a blown deadline stops the agent, never strands it.
			agent.cancel();
			state.lastError = error;
			throw error;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (abort !== undefined && settleAbort !== undefined)
				abort.removeEventListener("abort", settleAbort);
		}
		try {
			state.lastText = await agent.lastAssistant();
		} catch (error) {
			state.lastError = error;
			state.lastText = null;
		}
	}

	async collect(handle: HiddenRunHandle): Promise<HiddenCompletion> {
		const state = this.runs.get(handle.id);
		if (state === undefined)
			return { text: null, usage: emptyUsage(), lengthCapped: false };
		return {
			text: state.lastText,
			usage: state.usage,
			lengthCapped: false,
			attemptedModel: handle.attemptedModel,
			...(state.lastError !== undefined ? { hostError: state.lastError } : {}),
		};
	}

	async close(
		handle: HiddenRunHandle | null,
		settlement: {
			promptSettled: boolean;
			privacySensitive: boolean;
			context: string;
			log: (message: string) => void;
		},
	): Promise<void> {
		if (handle === null) return;
		const state = this.runs.get(handle.id);
		this.runs.delete(handle.id);
		if (state?.agent !== undefined) await state.agent.dispose();
		if (handle.id.startsWith("session-mc-maint-"))
			sessionLog(
				handle.id,
				`maintenance agent closed (settled=${String(settlement.promptSettled)}, steps=${String(state?.steps ?? 0)})`,
			);
	}
}

/**
 * Production `MaintenanceAgentRuntime` over the live Cordis context:
 * parentless subagent-origin agent, scoped tool restriction, scoped pre-step
 * budget gate, scoped usage tap over `llm/stream`, surface-read settlement,
 * and handle disposal (which removes the session outright).
 */
export function createCordisMaintenanceAgentRuntime(
	ctx: Context,
): MaintenanceAgentRuntime {
	return {
		async launch(spec) {
			const { agent, dispose } = await ctx.agents.create({
				sessionId: SessionId(spec.sessionId),
				meta: { cwd: spec.cwd, origin: "subagent" },
				...(spec.model !== undefined
					? {
							agentOptions: {
								provider: spec.model.provider,
								model: spec.model.model,
								...(spec.maxOutputTokens !== undefined
									? { maxTokens: spec.maxOutputTokens }
									: {}),
							},
						}
					: {}),
				setup: (agentCtx: Context) => {
					agentCtx.tools.restrict({ allow: spec.allowlist });
					let steps = 0;
					agentCtx.on("agent/pre-step", (_payload, next) => {
						steps += 1;
						const decision = spec.onStep(steps);
						if (decision === "refuse")
							return Promise.resolve({ kind: "reject" } as const);
						if (decision === "wrap-up")
							return Promise.resolve({
								kind: "enter",
								messages: [
									createUserMessage({
										content: [
											{
												type: "text",
												text: WRAP_UP_TEXT,
											},
										],
										source: { kind: "user" },
									}),
								],
							} as const);
						return next();
					});
					agentCtx.on("llm/stream", (options, next) => {
						const inner = next();
						return {
							[Symbol.asyncIterator]: () => {
								const it = inner[Symbol.asyncIterator]();
								return {
									next: async () => {
										const step = await it.next();
										if (!step.done && step.value.type === "usage")
											spec.onUsage({
												input: step.value.usage.inputTokens,
												output: step.value.usage.outputTokens,
											});
										return step;
									},
									return: async (value?: never) => {
										await it.return?.(value as never);
										return {
											done: true as const,
											value: undefined as never,
										};
									},
									throw: async (error?: unknown) => {
										await it.throw?.(error);
										return {
											done: true as const,
											value: undefined as never,
										};
									},
								};
							},
						};
					});
				},
			});
			return {
				async prompt(text, modelSelection) {
					if (modelSelection !== undefined)
						agent.model.select({
							provider: modelSelection.provider,
							model: modelSelection.model,
						});
					agent.followup(
						createUserMessage({
							content: [{ type: "text", text }],
							source: { kind: "user" },
						}),
					);
					await agent.whenIdle();
					await ctx.sessions.flush(agent.session);
				},
				cancel() {
					agent.cancel({
						kind: "hook",
						reason: "magic-context maintenance",
					});
				},
				async lastAssistant() {
					const snapshot = await ctx.sessionQuery.readSurface(agent.id);
					let text: string | null = null;
					for (const event of snapshot.events) {
						if (!isSurfaceEvent(event)) continue;
						const message = deriveEventMessage(event);
						if (message === null || message.role !== "assistant") continue;
						const t = message.content
							.filter(
								(block): block is { type: "text"; text: string } =>
									block.type === "text",
							)
							.map((block) => block.text)
							.join("\n");
						if (t.trim() !== "") text = t;
					}
					return text;
				},
				dispose: () => dispose(),
			};
		},
	};
}
