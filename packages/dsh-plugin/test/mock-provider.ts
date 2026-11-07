/**
 * Mock OpenAI-compatible provider (live-gate harness).
 *
 * The live gates need a deterministic model behind a real `dsh` process: no
 * network, no key, no randomness, and full visibility of the request the host
 * actually assembled (which is how a surface rewrite is proven to reach the
 * model). This server speaks just enough of `POST /chat/completions` for the
 * `openai-completions` client: JSON or SSE, text and tool-call deltas, plus a
 * recorded transcript of every request body.
 *
 * Usage from a test:
 *
 * ```ts
 * const provider = startMockProvider();
 * const home = createLiveHome({ route: { provider: "mock", baseURL: provider.baseURL, models: [{ id: "m" }] }, defaultModel: "m" });
 * provider.script([{ text: "hello" }]);
 * home.runHeadless("hi");
 * expect(provider.requests[0]?.messages).toEqual(...);
 * provider.stop();
 * ```
 */
import { randomUUID } from "node:crypto";

/** One scripted assistant turn. */
export interface MockReply {
	/** Assistant text (streamed as one delta). */
	readonly text?: string;
	/** Provider reasoning, streamed as `reasoning_content` deltas (thinking models). */
	readonly thinking?: string;
	/** Tool calls the assistant asks for; each gets a fresh call id. */
	readonly toolCalls?: readonly {
		readonly name: string;
		readonly arguments: string;
	}[];
	/** Finish reason (defaults to "stop" / "tool_calls"). */
	readonly finishReason?: string;
	/** Fail the request with this HTTP status instead of replying. */
	readonly failStatus?: number;
	/** Provider-reported prompt tokens, so a live gate can drive real pressure. */
	readonly promptTokens?: number;
	/**
	 * Stall this reply (the response headers are withheld) for N ms. Used to
	 * keep a turn open while a background agent — e.g. an async `subagent`
	 * child — takes its own steps inside the same host process.
	 */
	readonly delayMs?: number;
}

export interface MockRequest {
	readonly path: string;
	readonly body: Record<string, unknown>;
}

export interface MockProvider {
	readonly baseURL: string;
	readonly port: number;
	/** Queue replies; each request consumes the next one (the last repeats). */
	script(replies: readonly MockReply[]): void;
	/**
	 * Answer by inspecting the request instead of by position. Live gates that
	 * involve a DELEGATED CHILD cannot rely on request order — the parent and
	 * the child interleave — so they match on what the request actually carries.
	 */
	respond(handler: (request: Record<string, unknown>) => MockReply): void;
	/** Every request the host made, in order. */
	readonly requests: readonly MockRequest[];
	/** Messages arrays of every chat completion request, for transcript assertions. */
	messagesOf(index?: number): readonly Record<string, unknown>[];
	stop(): void;
}

const API_KEY = "mock-key";

function sseChunk(
	choice: Record<string, unknown>,
	usage?: Record<string, unknown>,
): string {
	const payload: Record<string, unknown> = {
		id: `chatcmpl-${randomUUID()}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "mock-model",
		choices: [choice],
	};
	if (usage !== undefined) payload["usage"] = usage;
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Turn one scripted reply into the HTTP response the client expects. */
function respondWith(reply: MockReply, body: Record<string, unknown>): Response {
	if (reply.failStatus !== undefined) {
		return new Response(
			JSON.stringify({
				error: { message: "mock provider failure", type: "mock" },
			}),
			{
				status: reply.failStatus,
				headers: { "content-type": "application/json" },
			},
		);
	}
	const stream = body["stream"] !== false;
	const toolCalls = reply.toolCalls ?? [];
	const finishReason =
		reply.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop");
	if (!stream) {
		return new Response(
			JSON.stringify({
				id: `chatcmpl-${randomUUID()}`,
				object: "chat.completion",
				created: Math.floor(Date.now() / 1000),
				model: "mock-model",
				choices: [
					{
						index: 0,
						message: {
							role: "assistant",
							content: reply.text ?? "",
							...(toolCalls.length > 0
								? {
										tool_calls: toolCalls.map((call) => ({
											id: `call_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
											type: "function",
											function: {
												name: call.name,
												arguments: call.arguments,
											},
										})),
									}
								: {}),
						},
						finish_reason: finishReason,
					},
				],
			}),
			{ headers: { "content-type": "application/json" } },
		);
	}
	const parts: string[] = [];
	parts.push(
		sseChunk({
			index: 0,
			delta: { role: "assistant", content: "" },
			finish_reason: null,
		}),
	);
	if (reply.thinking !== undefined && reply.thinking.length > 0) {
		parts.push(
			sseChunk({
				index: 0,
				delta: { reasoning_content: reply.thinking },
				finish_reason: null,
			}),
		);
	}
	if (reply.text !== undefined && reply.text.length > 0) {
		parts.push(
			sseChunk({
				index: 0,
				delta: { content: reply.text },
				finish_reason: null,
			}),
		);
	}
	toolCalls.forEach((call, index) => {
		parts.push(
			sseChunk({
				index: 0,
				delta: {
					tool_calls: [
						{
							index,
							id: `call_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
							type: "function",
							function: { name: call.name, arguments: call.arguments },
						},
					],
				},
				finish_reason: null,
			}),
		);
	});
	const promptTokens = reply.promptTokens ?? 100;
	parts.push(
		sseChunk(
			{ index: 0, delta: {}, finish_reason: finishReason },
			{
				prompt_tokens: promptTokens,
				completion_tokens: 10,
				total_tokens: promptTokens + 10,
			},
		),
	);
	parts.push("data: [DONE]\n\n");
	return new Response(parts.join(""), {
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
}

/** Start the mock provider on an ephemeral port. */
export function startMockProvider(): MockProvider {
	let replies: MockReply[] = [{ text: "ok" }];
	let responder: ((request: Record<string, unknown>) => MockReply) | undefined;
	let cursor = 0;
	const requests: MockRequest[] = [];

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(request) {
			const url = new URL(request.url);
			const body = (await request.json().catch(() => ({}))) as Record<
				string,
				unknown
			>;
			requests.push({ path: url.pathname, body });
			const reply = responder
				? responder(body)
				: (replies[Math.min(cursor, replies.length - 1)] ?? {
						text: "ok",
					});
			cursor += 1;
			if (reply.delayMs !== undefined && reply.delayMs > 0) {
				await new Promise((done) => setTimeout(done, reply.delayMs));
			}
			return respondWith(reply, body);
		},
	});

	const port = server.port ?? 0;
	return {
		baseURL: `http://127.0.0.1:${String(port)}/v1`,
		port,
		script(next) {
			responder = undefined;
			replies = [...next];
			cursor = 0;
		},
		respond(handler) {
			responder = handler;
		},
		requests,
		messagesOf(index = 0) {
			const body = requests[index]?.body;
			const messages = body?.["messages"];
			return Array.isArray(messages)
				? (messages as Record<string, unknown>[])
				: [];
		},
		stop() {
			server.stop(true);
		},
	};
}

/** The API key env var the seeded profile uses. */
export const MOCK_API_KEY_ENV = "MC_MOCK_API_KEY";

/** Env a live turn must carry so the provider client finds its key. */
export function mockProviderEnv(): Record<string, string> {
	return { [MOCK_API_KEY_ENV]: API_KEY };
}
