/**
 * Shared test doubles for the tool-layer tests (T032).
 *
 * A fake `DshHost` that records registered `ToolDefinition`s (kept separate
 * from the foundation double in ./double.ts, which another lane owns), plus
 * a minimal `RawMessageProvider` fixture — the sessions layer registers real
 * providers in production; tool tests register this fixture directly.
 */
import type { ToolDefinition, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";

/**
 * Fake of the frozen `DshHost` seam (src/host.ts): records every tool
 * registration and honors the disposer contract (idempotent unregister).
 */
export class FakeToolHost {
	readonly tools = new Map<string, ToolDefinition>();
	readonly registrationOrder: string[] = [];
	disposedCount = 0;

	registerTool(definition: ToolDefinition): () => void {
		this.tools.set(definition.name, definition);
		this.registrationOrder.push(definition.name);
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.tools.delete(definition.name);
			this.disposedCount++;
		};
	}
}

/** Minimal execution context: identity, a live signal, no-op deferral hooks. */
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

/** Execute a registered tool and assert its canonical output is the reply string. */
export async function callTool(
	host: FakeToolHost,
	name: string,
	args: Record<string, unknown>,
): Promise<string> {
	const definition = host.tools.get(name);
	if (!definition) throw new Error(`tool '${name}' is not registered`);
	const value = await definition.execute(args, execContext(name, args));
	if (typeof value !== "string") {
		throw new Error(`tool '${name}' returned non-string canonical value: ${String(value)}`);
	}
	return value;
}

/** In-memory raw-history provider over fixed messages (expand read path). */
export function fixtureProvider(messages: RawMessage[]): RawMessageProvider {
	const byId = new Map(messages.map((message) => [message.id, message]));
	return {
		readMessages: () => messages,
		readMessageById: (messageId: string) => byId.get(messageId) ?? null,
		hasMessageById: (messageId: string) => byId.has(messageId),
		getMessageCount: () => messages.length,
	};
}
