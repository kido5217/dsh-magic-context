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

// ---------------------------------------------------------------------------
// T056 — crashed maintenance sessions are reaped at boot.
// ---------------------------------------------------------------------------
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapMaintenanceOrphans } from "../src/maintenance/orphans.js";

describe("maintenance orphan reaper", () => {
	test("removes crashed maintenance sessions and nothing else", () => {
		const root = mkdtempSync(join(tmpdir(), "mc-orphans-"));
		const ws = join(root, "--proj--");
		mkdirSync(join(ws, "session-mc-maint-dead"), { recursive: true });
		writeFileSync(join(ws, "session-mc-maint-dead", "log.jsonl"), "{}\n");
		mkdirSync(join(ws, "session-user"), { recursive: true });
		mkdirSync(join(root, "--other--"), { recursive: true });
		// N-10 age fence: mark the crashed session's files a day old — the
		// reaper only removes directories that have seen no activity.
		const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
		utimesSync(join(ws, "session-mc-maint-dead", "log.jsonl"), past, past);
		utimesSync(join(ws, "session-mc-maint-dead"), past, past);
		expect(reapMaintenanceOrphans(root)).toEqual(["session-mc-maint-dead"]);
		expect(existsSync(join(ws, "session-mc-maint-dead"))).toBe(false);
		expect(existsSync(join(ws, "session-user"))).toBe(true);
		// An absent root is not a boot failure.
		expect(reapMaintenanceOrphans(join(root, "nope"))).toEqual([]);
	});

	test("a maintenance session a live sibling may still own is spared (N-10)", () => {
		const root = mkdtempSync(join(tmpdir(), "mc-orphans-"));
		const ws = join(root, "--proj--");
		// Fresh directory: a concurrent harness process could be writing it
		// RIGHT NOW; boot must not pull the directory out from under it.
		mkdirSync(join(ws, "session-mc-maint-alive"), { recursive: true });
		writeFileSync(join(ws, "session-mc-maint-alive", "log.jsonl"), "{}\n");
		expect(reapMaintenanceOrphans(root)).toEqual([]);
		expect(existsSync(join(ws, "session-mc-maint-alive"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// T064 — the production Cordis runtime: classification, restriction, gates.
// ---------------------------------------------------------------------------
import { createCordisMaintenanceAgentRuntime } from "../src/maintenance/transport-agent.js";

function fakeCordis(opts: {
	events?: readonly unknown[];
	usageChunks?: readonly unknown[];
}) {
	const created: {
		sessionId: string;
		meta: Record<string, unknown>;
		agentOptions: Record<string, unknown> | undefined;
		handlers: Map<string, (payload: never, next: () => unknown) => unknown>;
		restrictions: { allow?: readonly string[] }[];
	}[] = [];
	let idle = false;
	const followed: unknown[] = [];
	let flushed = 0;
	let disposed = 0;
	const ctx = {
		agents: {
			async create(o: {
				sessionId: string;
				meta: Record<string, unknown>;
				agentOptions?: Record<string, unknown>;
				setup: (agentCtx: {
					tools: {
						restrict: (f: { allow?: readonly string[] }) => void;
					};
					on: (
						type: string,
						handler: (payload: never, next: () => unknown) => unknown,
					) => void;
				}) => void;
			}) {
				const handlers = new Map<
					string,
					(payload: unknown, next: () => unknown) => unknown
				>();
				const restrictions: { allow?: readonly string[] }[] = [];
				o.setup({
					tools: { restrict: (f) => void restrictions.push(f) },
					on: (type, handler) =>
						void handlers.set(
							type,
							handler as (payload: unknown, next: () => unknown) => unknown,
						),
				});
				created.push({
					sessionId: o.sessionId,
					meta: o.meta,
					agentOptions: o.agentOptions,
					handlers,
					restrictions,
				});
				idle = false;
				return {
					agent: {
						id: o.sessionId,
						session: { id: o.sessionId },
						model: { select: () => {} },
						followup: (m: unknown) => {
							followed.push(m);
							queueMicrotask(() => {
								idle = true;
							});
						},
						whenIdle: () =>
							new Promise<void>((done) => {
								const timer = setInterval(() => {
									if (idle) {
										clearInterval(timer);
										done();
									}
								}, 1);
							}),
						cancel: () => {
							idle = true;
						},
					},
					dispose: () => {
						disposed += 1;
					},
				};
			},
		},
		sessions: {
			async flush() {
				flushed += 1;
			},
		},
		sessionQuery: {
			async readSurface() {
				return { events: opts.events ?? [] };
			},
		},
	};
	return {
		ctx,
		created,
		followed,
		flushed: () => flushed,
		disposed: () => disposed,
		usageSeen: [] as { input: number; output: number }[],
		usageChunks: opts.usageChunks ?? [],
	};
}

describe("cordis maintenance runtime", () => {
	test("launch classifies the session as a hidden subagent child", async () => {
		const f = fakeCordis({
			usageChunks: [
				{
					type: "usage",
					usage: {
						inputTokens: 7,
						outputTokens: 3,
						totalTokens: 10,
					},
				},
			],
		});
		const runtime = createCordisMaintenanceAgentRuntime(f.ctx as never);
		let onStepDecision = "run" as MaintenanceStepDecision;
		const handle = await runtime.launch({
			sessionId: "session-mc-maint-x",
			cwd: "/proj",
			model: { provider: "mock", model: "mock-model" },
			allowlist: ["read", "ctx_memory"],
			maxOutputTokens: 900,
			onStep: () => onStepDecision,
			onUsage: (u) => void f.usageSeen.push(u),
		});
		const created = f.created[0]!;
		expect(created.meta).toEqual({ cwd: "/proj", origin: "subagent" });
		expect(created.agentOptions).toMatchObject({
			provider: "mock",
			model: "mock-model",
			maxTokens: 900,
		});
		expect(created.restrictions).toEqual([{ allow: ["read", "ctx_memory"] }]);
		// The pre-step gate refuses when the carrier says stop.
		const preStep = created.handlers.get("agent/pre-step")! as (
			payload: unknown,
			next: () => unknown,
		) => unknown;
		expect(
			preStep({} as never, () => "next"), //
		).toBe("next");
		onStepDecision = "refuse";
		expect(await preStep({} as never, () => "next")).toEqual({
			kind: "reject",
		});
		onStepDecision = "wrap-up";
		const decision = (await preStep({} as never, () => "next")) as {
			kind: string;
			messages: { content: { text: string }[] }[];
		};
		expect(decision.kind).toBe("enter");
		expect(decision.messages[0]!.content[0]!.text).toContain("tool-use budget");
		// The usage tap sees provider usage chunks flow through.
		const stream = created.handlers.get("llm/stream")! as (
			payload: unknown,
			next: () => unknown,
		) => unknown;
		const iterable = stream(
			{ provider: "mock", model: "mock-model", messages: [] },
			() => ({
				[Symbol.asyncIterator]: () => {
					const chunks = [...f.usageChunks];
					let i = 0;
					return {
						next: async () =>
							i < chunks.length
								? { done: false as const, value: chunks[i++] }
								: { done: true as const, value: undefined },
					};
				},
			}),
		) as AsyncIterable<unknown>;
		for await (const _chunk of iterable) {
			// drain
		}
		expect(f.usageSeen).toEqual([{ input: 7, output: 3 }]);
		await handle.prompt("task", undefined);
		expect(f.followed).toHaveLength(1);
		expect(f.flushed()).toBe(1);
		await handle.dispose();
		expect(f.disposed()).toBe(1);
	});

	test("settlement is the last assistant message on the surface", async () => {
		const f = fakeCordis({
			usageChunks: [],
			events: [
				{
					type: "user/message",
					seq: 1,
					time: 1,
					surfaceOp: "append",
					data: {
						id: "u1",
						role: "user",
						content: [{ type: "text", text: "task" }],
						source: { kind: "user" },
					},
				},
				{
					type: "assistant/message",
					seq: 2,
					time: 2,
					surfaceOp: "append",
					data: {
						turn: 1,
						step: 1,
						message: {
							id: "a2",
							role: "assistant",
							source: { kind: "model" },
							content: [{ type: "text", text: "<manifest>final</manifest>" }],
						},
					},
				},
			],
		});
		const runtime = createCordisMaintenanceAgentRuntime(f.ctx as never);
		const handle = await runtime.launch({
			sessionId: "session-mc-maint-y",
			cwd: "/proj",
			model: undefined,
			allowlist: [],
			maxOutputTokens: undefined,
			onStep: () => "run",
			onUsage: () => {},
		});
		expect(await handle.lastAssistant()).toBe("<manifest>final</manifest>");
	});
});
