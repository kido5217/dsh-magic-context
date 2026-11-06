/**
 * T044 — band pricing follows the CURRENT routed model, not the window
 * recorded under the last request (spec Edge Cases — model switch). The
 * window is resolved from the provider catalog at pre-step; an unresolved
 * or selection-less step falls back to the meter's recorded window.
 */
import { describe, expect, test } from "bun:test";
import type { Context } from "@deepseek-ai/cordis";
import { createCordisHost } from "../src/host-cordis.js";

interface StubOptions {
	readonly catalogWindow?: number;
	readonly prepareFails?: boolean;
}

function stubHost(options: StubOptions = {}) {
	const handlers: Array<(payload: any, next: () => any) => Promise<any>> = [];
	const ctx = {
		agents: { get: () => ({ session: { id: "s1" } }) },
		tokenMeter: { contextPressure: () => ({ pressureTokens: 25_000, contextWindow: 24_000 }) },
		llm: {
			prepareCall: async () => {
				if (options.prepareFails === true) throw new Error("unknown route");
				return options.catalogWindow === undefined
					? { config: {} }
					: { config: {}, context: { contextWindow: options.catalogWindow } };
			},
		},
		on: (_type: string, handler: any) => {
			handlers.push(handler);
			return () => {};
		},
	} as unknown as Context;
	const host = createCordisHost(ctx);
	// The lanes pass registers the one pre-step listener; stand in for it.
	host.onPreStep(() => "enter");
	const preStep = async (modelSelection?: { provider: string; model: string }) => {
		const handler = handlers[0]!;
		await handler(
			{ agent: { session: { id: "s1" } }, modelSelection, turn: 1, step: 1 },
			() => ({ kind: "continue" }),
		);
	};
	return { host, preStep };
}

describe("band window pricing follows the routed model (T044)", () => {
	test("before any pre-step, the recorded window is reported", () => {
		const { host } = stubHost({ catalogWindow: 48_000 });
		expect(host.pressure("s1")).toEqual({ pressureTokens: 25_000, contextWindow: 24_000 });
	});

	test("a selection for a larger route re-prices the band on the same pass", async () => {
		const { host, preStep } = stubHost({ catalogWindow: 48_000 });
		await preStep({ provider: "p2", model: "big" });
		// 25k prompt under the NEW 48k window is mid-band, not the refusal
		// wall the stale 24k reading would force.
		expect(host.pressure("s1")).toEqual({ pressureTokens: 25_000, contextWindow: 48_000 });
	});

	test("a step without a selection falls back to the recorded window", async () => {
		const { host, preStep } = stubHost({ catalogWindow: 48_000 });
		await preStep({ provider: "p2", model: "big" });
		await preStep(undefined);
		expect(host.pressure("s1")).toEqual({ pressureTokens: 25_000, contextWindow: 24_000 });
	});

	test("an unresolved route falls back to the recorded window", async () => {
		const { host, preStep } = stubHost({ prepareFails: true });
		await preStep({ provider: "p2", model: "gone" });
		expect(host.pressure("s1")).toEqual({ pressureTokens: 25_000, contextWindow: 24_000 });
	});

	test("a catalog route without disclosed capacity falls back too", async () => {
		const { host, preStep } = stubHost({});
		await preStep({ provider: "p2", model: "silent" });
		expect(host.pressure("s1")).toEqual({ pressureTokens: 25_000, contextWindow: 24_000 });
	});
});
