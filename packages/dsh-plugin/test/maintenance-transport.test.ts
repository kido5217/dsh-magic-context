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
