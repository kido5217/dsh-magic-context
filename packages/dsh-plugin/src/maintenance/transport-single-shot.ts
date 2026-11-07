/**
 * Single-shot maintenance transport (T054).
 *
 * The single-shot dreamer tasks (`compress-cues`, `classify-memories`,
 * `review-user-memories`, smart-note compile/confirm) are one auxiliary
 * completion each: system + prompt, answer, parse. The shared runner
 * (`runHiddenSingleShotPrompt`) owns the model chain, the first-output
 * deadline, the total timeout, the output validation and the run record;
 * this file is the DSH carrier underneath it: one `host.llmStream` call per
 * attempt, with NO durable session identity (a maintenance completion never
 * enters the session tree, and the other harnesses' hidden carriers give it
 * no persistence either).
 *
 * Attempt state lives in memory keyed by the handle the core allocates:
 * text and usage accumulate as chunks arrive, so `collectPartial` can hand
 * the core the closed entries of an interrupted or cancelled run.
 */
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import type { TokenTotals } from "@magic-context/core/features/magic-context/subagent-token-capture";
import type {
	HiddenCompletion,
	HiddenCompletionExecutor,
	HiddenRunHandle,
	HiddenRunIdentity,
} from "@magic-context/core/hooks/magic-context/compartment-runner-types";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { PromptArgs } from "@magic-context/core/shared/model-suggestion-retry";

/** The host seam: the same purpose-tagged aux stream the historian fold
 *  uses (production: `ctx.llm.stream`; doubles script chunk sequences). */
export interface SingleShotStreamHost {
	llmStream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

interface AttemptRecord {
	text: string;
	reasoning: string;
	usage: TokenTotals & { reasoning?: number };
	lengthCapped: boolean;
	providerId?: string;
	modelId?: string;
	error?: unknown;
}

interface RunState {
	readonly identity: HiddenRunIdentity;
	last?: AttemptRecord;
}

function emptyUsage(): TokenTotals & { reasoning?: number } {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}

/** One hidden completion carrier per process, shared by every single-shot
 *  task. Stateless between runs; per-run state is the attempt record. */
export class DshSingleShotTransport implements HiddenCompletionExecutor {
	readonly capabilities = { tools: false, harness: "dsh" } as const;

	private readonly runs = new Map<string, RunState>();
	private seq = 0;

	constructor(private readonly host: SingleShotStreamHost) {}

	async open(run: HiddenRunIdentity): Promise<HiddenRunHandle> {
		this.seq += 1;
		const id = `mc-maint-ss-${String(this.seq)}`;
		this.runs.set(id, { identity: run });
		return { id };
	}

	async attempt(handle: HiddenRunHandle, request: PromptArgs): Promise<void> {
		const run = this.runs.get(handle.id);
		if (run === undefined)
			throw new Error("magic-context: unknown single-shot run");
		const body = (request.body ?? {}) as Record<string, unknown>;
		const model = body["model"] as
			| { providerID?: string; modelID?: string }
			| undefined;
		const provider = model?.providerID ?? "";
		const modelId = model?.modelID ?? "";
		if (provider === "" || modelId === "") {
			// "no models": a single-shot task without a resolvable model fails
			// here and the shared runner records the failure class.
			throw new Error("magic-context: single-shot attempt has no routed model");
		}
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
		const system =
			typeof body["system"] === "string" ? body["system"] : run.identity.system;
		const record: AttemptRecord = {
			text: "",
			reasoning: "",
			usage: emptyUsage(),
			lengthCapped: false,
			providerId: provider,
			modelId: modelId,
		};
		run.last = record;
		handle.attemptedModel = `${provider}/${modelId}`;
		const options: GenerateOptions = {
			provider,
			model: modelId,
			system,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
			purpose: "magic-context",
			...(run.identity.maxOutputTokens !== undefined
				? { maxTokens: run.identity.maxOutputTokens }
				: {}),
			...(request.signal !== undefined ? { signal: request.signal } : {}),
		};
		try {
			for await (const chunk of this.host.llmStream(
				options,
			) as AsyncIterable<StreamChunk>) {
				if (chunk.type === "text-delta") record.text += chunk.text;
				else if (chunk.type === "reasoning-delta")
					record.reasoning += chunk.text;
				else if (chunk.type === "usage") {
					record.usage = {
						input: chunk.usage.inputTokens,
						output: chunk.usage.outputTokens,
						cacheRead: 0,
						cacheWrite: 0,
						...(chunk.usage.reasoningTokens !== undefined
							? { reasoning: chunk.usage.reasoningTokens }
							: {}),
					};
				} else if (chunk.type === "finish")
					record.lengthCapped =
						(chunk.reason as { kind?: string }).kind === "length";
			}
		} catch (error) {
			record.error = error;
			throw error;
		}
	}

	async collect(handle: HiddenRunHandle): Promise<HiddenCompletion> {
		return this.completion(handle);
	}

	async collectPartial(handle: HiddenRunHandle): Promise<HiddenCompletion> {
		// The attempt record accumulates live, so an interrupted read still
		// returns everything streamed so far.
		return this.completion(handle);
	}

	private completion(handle: HiddenRunHandle): HiddenCompletion {
		const run = this.runs.get(handle.id);
		const attempt = run?.last;
		if (attempt === undefined)
			return { text: null, usage: emptyUsage(), lengthCapped: false };
		return {
			text: attempt.text.length > 0 ? attempt.text : null,
			reasoning: attempt.reasoning,
			usage: attempt.usage,
			lengthCapped: attempt.lengthCapped,
			...(attempt.providerId !== undefined
				? { providerId: attempt.providerId }
				: {}),
			...(attempt.modelId !== undefined ? { modelId: attempt.modelId } : {}),
			attemptedModel: handle.attemptedModel,
			...(attempt.error !== undefined ? { hostError: attempt.error } : {}),
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
		const run = this.runs.get(handle.id);
		this.runs.delete(handle.id);
		// Fail-closed on partial output: nothing durable exists to leak, but a
		// settled-without-text run is worth one diagnostic line.
		if (
			run?.last !== undefined &&
			!settlement.promptSettled &&
			run.last.text.length > 0
		)
			sessionLog(
				handle.id,
				`single-shot closed unsettled (${String(run.last.text.length)} chars kept out)`,
			);
	}
}
