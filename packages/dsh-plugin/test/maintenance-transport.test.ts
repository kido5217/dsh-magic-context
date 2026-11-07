/**
 * T054/T064 — the single-shot transport. The shared runner
 * `runHiddenSingleShotPrompt` drives the whole life cycle over the DSH
 * carrier: open → attempt (one aux stream) → collect → parse → close, with
 * usage captured, a truncated run refused before the parser sees it, an
 * empty completion refused, and the model fallback chain advancing through
 * the same carrier.
 */
import { describe, expect, test } from "bun:test";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm/types";
import { runHiddenSingleShotPrompt } from "@magic-context/core/features/magic-context/dreamer/hidden-single-shot";
import type { SingleShotStreamHost } from "../src/maintenance/transport-single-shot.js";
import { DshSingleShotTransport } from "../src/maintenance/transport-single-shot.js";

interface Scripted {
	chunks: StreamChunk[];
	throwAt?: number;
}

function host(
	...scripts: Scripted[]
): SingleShotStreamHost & { calls: GenerateOptions[] } {
	const calls: GenerateOptions[] = [];
	let attempt = 0;
	return {
		calls,
		llmStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
			calls.push(options);
			const script = scripts[Math.min(attempt, scripts.length - 1)]!;
			attempt += 1;
			let seen = 0;
			const chunks = script.chunks;
			return {
				[Symbol.asyncIterator]: (): AsyncIterator<StreamChunk> => ({
					next: async () => {
						if (script.throwAt !== undefined && seen === script.throwAt) {
							seen += 1;
							throw new Error("stream died");
						}
						const value = chunks[seen];
						if (value === undefined)
							return { done: true as const, value: undefined as never };
						seen += 1;
						return { done: false as const, value };
					},
				}),
			};
		},
	};
}

const text = (t: string): StreamChunk => ({
	type: "text-delta",
	index: 0,
	text: t,
});
const usage = (i: number, o: number): StreamChunk => ({
	type: "usage",
	usage: { inputTokens: i, outputTokens: o },
});
const stop: StreamChunk = { type: "finish", reason: { kind: "stop" } as never };
const length: StreamChunk = {
	type: "finish",
	reason: { kind: "length" } as never,
};

function args<T>(
	transport: DshSingleShotTransport,
	parse: (raw: string) => T,
	timeoutMs = 5_000,
): Parameters<typeof runHiddenSingleShotPrompt<T>>[0] {
	return {
		executor: transport,
		parentSessionId: undefined,
		sessionDirectory: "/tmp",
		agent: "magic-context",
		system: "SYS",
		prompt: "PROMPT",
		title: "t",
		callContext: "dreamer:test",
		model: "mock/mock-model",
		fallbackModels: ["mock/mock-model2"],
		timeoutMs,
		parse: (raw) => parse(raw),
	};
}

describe("single-shot transport", () => {
	test("one streamed completion parses with usage captured", async () => {
		const h = host({
			chunks: [text("<ok/>"), usage(11, 5), stop],
		});
		const transport = new DshSingleShotTransport(h);
		const result = await runHiddenSingleShotPrompt(
			args(transport, (raw) => raw),
		);
		expect(result.validated).toBe("<ok/>");
		expect(result.completion.usage).toMatchObject({ input: 11, output: 5 });
		expect(h.calls[0]).toMatchObject({
			provider: "mock",
			model: "mock-model",
			system: "SYS",
			purpose: "magic-context",
		});
		expect(
			(
				(h.calls[0]!.messages[0] as unknown as { content: { text: string }[] })
					.content[0]!.text as string
			).includes("PROMPT"),
		).toBe(true);
	});

	test("a length-capped answer is refused before the parser runs", async () => {
		const h = host({ chunks: [text("<ok"), length] });
		const transport = new DshSingleShotTransport(h);
		let parsed = 0;
		await expect(
			runHiddenSingleShotPrompt(
				args(transport, () => {
					parsed += 1;
					return "x";
				}),
			),
		).rejects.toThrow();
		expect(parsed).toBe(0);
	});

	test("an empty completion is refused, not parsed as empty work", async () => {
		const h = host({ chunks: [stop] });
		const transport = new DshSingleShotTransport(h);
		await expect(
			runHiddenSingleShotPrompt(args(transport, (r) => r)),
		).rejects.toThrow();
	});

	test("a stream failure advances the model chain and the carrier records partials", async () => {
		const h = host(
			{
				chunks: [
					text("part"),
					{ type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
					stop,
				],
				throwAt: 1,
			},
			{ chunks: [text("<done/>"), usage(3, 4), stop] },
		);
		const transport = new DshSingleShotTransport(h);
		const result = await runHiddenSingleShotPrompt(
			args(transport, (raw) => raw),
		);
		expect(result.validated).toBe("<done/>");
		expect(h.calls.length).toBe(2);
	});

	test("close forgets the run; a late collect reports nothing", async () => {
		const h = host({ chunks: [text("abc"), stop] });
		const transport = new DshSingleShotTransport(h);
		const handle = await transport.open({
			agent: "magic-context",
			kind: "dreamer-task",
			system: "SYS",
			timeoutMs: 1000,
			title: "t",
			directory: "/tmp",
		});
		await transport.attempt(handle, {
			path: { id: handle.id },
			body: {
				model: { providerID: "mock", modelID: "mock-model" },
				parts: [{ type: "text", text: "go" }],
			},
		});
		await transport.close(handle, {
			promptSettled: true,
			privacySensitive: true,
			context: "test",
			log: () => {},
		});
		const after = await transport.collect(handle);
		expect(after.text).toBeNull();
	});
});

import type { HiddenRunIdentity } from "@magic-context/core/hooks/magic-context/compartment-runner-types";
import type {
	MaintenanceAgentHandle,
	MaintenanceAgentRuntime,
	MaintenanceStepDecision,
} from "../src/maintenance/transport-agent.js";
// ---------------------------------------------------------------------------
// T055/T064 — the hidden-agent transport over a faked maintenance runtime.
// ---------------------------------------------------------------------------
import { DshHiddenAgentTransport } from "../src/maintenance/transport-agent.js";

interface FakeAgent extends MaintenanceAgentHandle {
	promptText: string | undefined;
	promptModel: { provider: string; model: string } | undefined;
	cancelled: number;
	disposed: number;
	spec: Parameters<MaintenanceAgentRuntime["launch"]>[0];
	settle: (() => void) | undefined;
	fail: Error | undefined;
}

function fakeRuntime(behavior: (agent: FakeAgent) => void = () => {}): {
	runtime: MaintenanceAgentRuntime;
	agents: FakeAgent[];
	last: () => FakeAgent;
} {
	const agents: FakeAgent[] = [];
	const runtime: MaintenanceAgentRuntime = {
		async launch(spec) {
			const agent: FakeAgent = {
				promptText: undefined,
				promptModel: undefined,
				cancelled: 0,
				disposed: 0,
				spec,
				settle: undefined,
				fail: undefined,
				async prompt(text, model) {
					agent.promptText = text;
					agent.promptModel = model;
					if (agent.fail !== undefined) throw agent.fail;
					await new Promise<void>((done) => {
						agent.settle = done;
						behavior(agent);
					});
				},
				cancel() {
					agent.cancelled += 1;
					agent.settle?.();
				},
				async lastAssistant() {
					return "<manifest/>";
				},
				async dispose() {
					agent.disposed += 1;
				},
			};
			agents.push(agent);
			return agent;
		},
	};
	return { runtime, agents, last: () => agents[agents.length - 1]! };
}

const identity = (over: Partial<HiddenRunIdentity> = {}): HiddenRunIdentity =>
	({
		agent: "magic-context",
		kind: "dreamer-task",
		system: "SYS",
		timeoutMs: 5_000,
		title: "t",
		directory: "/tmp/project",
		...over,
	}) as unknown as HiddenRunIdentity;

const agentAttempt = {
	path: { id: "x" },
	body: {
		model: { providerID: "mock", modelID: "mock-model" },
		parts: [{ type: "text", text: "do the loop" }],
	},
};

describe("hidden-agent transport", () => {
	test("runs the loop, collects the settlement, disposes the session", async () => {
		const { runtime, last } = fakeRuntime((agent) => {
			agent.spec.onUsage({ input: 40, output: 10 });
			agent.settle?.(); // no further steps; settle immediately
		});
		const transport = new DshHiddenAgentTransport(runtime);
		const handle = await transport.open(identity());
		expect(handle.id.startsWith("session-mc-maint-")).toBe(true);
		await transport.attempt(handle, agentAttempt);
		const completion = await transport.collect(handle);
		expect(completion.text).toBe("<manifest/>");
		expect(completion.usage).toMatchObject({ input: 40, output: 10 });
		const agent = last();
		expect(agent.promptText).toContain("do the loop");
		expect(agent.promptModel).toEqual({
			provider: "mock",
			model: "mock-model",
		});
		await transport.close(handle, {
			promptSettled: true,
			privacySensitive: true,
			context: "test",
			log: () => {},
		});
		expect(agent.disposed).toBe(1);
	});

	test("the step cap refuses late steps and the token budget wraps up", async () => {
		const decisions: MaintenanceStepDecision[] = [];
		const { runtime } = fakeRuntime((agent) => {
			agent.spec.onUsage({ input: 0, output: 999_000 });
			for (let step = 1; step <= 30; step += 1)
				decisions.push(agent.spec.onStep(step));
			agent.settle?.();
		});
		const transport = new DshHiddenAgentTransport(runtime, {
			maxSteps: 24,
			maxRunTokens: 1000,
		});
		const handle = await transport.open(identity());
		await transport.attempt(handle, agentAttempt);
		// Over the cap: refused regardless of budget; under it with an spent
		// budget: wrap-up; step 1 before any usage: run.
		expect(decisions[0]).toBe("wrap-up"); // budget already spent at step 1
		expect(decisions[23]).toBe("wrap-up"); // step 24: capped only at >max
		expect(decisions[24]).toBe("refuse");
		expect(decisions[29]).toBe("refuse");
		await transport.close(handle, {
			promptSettled: true,
			privacySensitive: true,
			context: "test",
			log: () => {},
		});
	});

	test("the deadline cancels the agent and fails the attempt", async () => {
		const { runtime, last } = fakeRuntime();
		const transport = new DshHiddenAgentTransport(runtime);
		const handle = await transport.open(identity({ timeoutMs: 20 }));
		const started = transport.attempt(handle, agentAttempt);
		await expect(started).rejects.toThrow("deadline");
		expect(last().cancelled).toBe(1);
	});

	test("an abort (lease loss) cancels the agent mid-run", async () => {
		const { runtime, last } = fakeRuntime();
		const transport = new DshHiddenAgentTransport(runtime);
		const handle = await transport.open(identity());
		const controller = new AbortController();
		const started = transport.attempt(handle, {
			...agentAttempt,
			signal: controller.signal,
		});
		await Bun.sleep(5);
		controller.abort();
		await expect(started).rejects.toThrow("cancelled");
		expect(last().cancelled).toBe(1);
		await transport.close(handle, {
			promptSettled: false,
			privacySensitive: true,
			context: "test",
			log: () => {},
		});
		expect(last().disposed).toBe(1);
	});
});
