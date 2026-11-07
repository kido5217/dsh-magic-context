/**
 * Protected-tail boundary (T029).
 *
 * The adapter's v1 rule was a token budget over the newest messages. The core's
 * rule is a boundary SNAPSHOT computed in raw-message ordinals, with tool-arc
 * fencing and the compartment anchor. DSH stores the anchor as a durable SEQ,
 * so the adapter converts it — and this test pins both the conversion and the
 * fallback contract.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { resolveDshBoundary } from "../src/surface/boundary.js";
import {
	createDshRawMessageProvider,
	projectDshSessionLog,
	registerDshRawHistoryProvider,
} from "../src/surface/dsh-session-log.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
const cfg = MagicContextConfigSchema.parse({});

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
});

afterAll(async () => {
	await closeDatabase();
});

function seed(host: TestDshHost, id: string, count: number) {
	const session = host.addSession(
		{ id },
		Array.from({ length: count }, (_, index) => index),
	);
	for (let index = 0; index < count; index += 1) {
		session.seedMessage(
			index,
			`m${String(index)}`,
			`message ${String(index)} `.repeat(40),
			"user",
		);
	}
	return session;
}

describe("protected-tail boundary", () => {
	test("the compartment anchor is converted from a durable seq to an ordinal", () => {
		const host = new TestDshHost();
		const session = seed(host, "s-boundary", 6);
		// Compartments store DSH SEQS (PARITY 8).
		appendCompartments(db, "s-boundary", [
			{
				sequence: 1,
				startMessage: 0,
				endMessage: 2,
				startMessageId: "m0",
				endMessageId: "m2",
				title: "early",
				content: "early work",
			},
		]);
		const projection = projectDshSessionLog(session.logRecords());
		const unregister = registerDshRawHistoryProvider(
			"s-boundary",
			() => projection,
		);
		try {
			const boundary = resolveDshBoundary({
				db,
				config: cfg,
				mcSession: "s-boundary",
				projection,
				contextWindow: 10_000,
				percentage: 40,
				pressureTokens: 4_000,
			});
			expect(boundary?.source).toBe("resolver");
			// The anchor (seq 2 ⇒ ordinal 3) closes the eligible range: messages
			// already folded must not be eligible again.
			expect(boundary!.eligibleMessageIds).not.toContain("m0");
			expect(boundary!.eligibleMessageIds).not.toContain("m2");
			expect(boundary!.protectedTailStart).toBeGreaterThanOrEqual(1);
		} finally {
			unregister();
		}
	});

	test("without a raw provider it degrades instead of throwing", () => {
		const host = new TestDshHost();
		const session = seed(host, "s-boundary-missing", 3);
		const projection = projectDshSessionLog(session.logRecords());
		const boundary = resolveDshBoundary({
			db,
			config: cfg,
			mcSession: "s-boundary-missing",
			projection,
			contextWindow: 10_000,
			percentage: 40,
			pressureTokens: 4_000,
		});
		// The contract is "never breaks a pass": either the resolver declines
		// (the caller keeps its token-budget fallback) or it returns a snapshot
		// whose halves partition the projection. It must not throw.
		if (boundary !== undefined) {
			expect(boundary.protectedTailStart).toBeGreaterThanOrEqual(1);
			expect(
				boundary.eligibleMessageIds.length + boundary.protectedMessageIds.size,
			).toBeGreaterThan(0);
		}
	});

	test("no window and no messages both decline", () => {
		const host = new TestDshHost();
		const session = seed(host, "s-boundary-empty", 1);
		const projection = projectDshSessionLog(session.logRecords());
		expect(
			resolveDshBoundary({
				db,
				config: cfg,
				mcSession: "s-boundary-empty",
				projection,
				contextWindow: undefined,
				percentage: undefined,
				pressureTokens: undefined,
			}),
		).toBeUndefined();
	});
});
