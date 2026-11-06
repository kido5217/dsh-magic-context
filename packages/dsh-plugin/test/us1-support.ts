/**
 * Shared scaffolding for the US1 test files: a mounted adapter on the host
 * double over a real temp store, with a durable-log reader wired from the
 * FakeSession and a deterministic historian route.
 */
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { mountAdapter, type AdapterHandle, type MountOptions } from "../src/index.js";
import type { FakeSession } from "./double.js";
import { TestDshHost } from "./double.js";

const WORDS = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu".split(" ");

/**
 * Deterministic message payload with real text entropy (the shared store's
 * tokenizer compresses uniform filler to ~nothing): ~4000 chars of varied
 * words ≈ 1000 tokens — one message per protected-tail budget unit.
 */
export function bigMessage(index: number): string {
	let text = `message-${index}-payload`;
	let seed = index * 7919 + 13;
	while (text.length < 4000) {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		text += " " + WORDS[seed % WORDS.length]!.repeat(1 + (seed % 3));
	}
	return text;
}

/** Seed a session whose initial surface is seqs 0..count-1 with real text. */
export function seedSession(host: TestDshHost, id: string, count: number, origin?: "subagent"): FakeSession {
	const surface = Array.from({ length: count }, (_, i) => i);
	const session = host.addSession(origin === undefined ? { id } : { id, origin, parentSession: "root", delegationDepth: 1 }, surface);
	for (let i = 0; i < count; i += 1) session.seedMessage(i, `m${String(i)}`, bigMessage(i), i % 2 === 0 ? "user" : "assistant");
	return session;
}

export function us1Mount(host: TestDshHost, db: ContextDatabase, extra?: Partial<MountOptions>): AdapterHandle {
	return mountAdapter(
		host,
		MagicContextConfigSchema.parse({}),
		db,
		{
			readSessionLog: (sessionId) => host.sessions.get(sessionId)?.logRecords() ?? [],
			historianRoute: { provider: "aux", model: "hist-1" },
			...extra,
		},
	);
}

export function setPressure(host: TestDshHost, sessionId: string, tokens: number, window = 10_000): void {
	host.pressureReadings.set(sessionId, { pressureTokens: tokens, contextWindow: window });
}

export function clearPressure(host: TestDshHost, sessionId: string): void {
	host.pressureReadings.set(sessionId, undefined);
}

export const preStep = { sessionId: "ignored", turn: 1, step: 1 } as const;

export function stepFor(sessionId: string): { sessionId: string; turn: number; step: number } {
	return { sessionId, turn: 1, step: 1 };
}
