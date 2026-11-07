/**
 * T051 — mural wiring (FR-006).
 *
 * The mural is the core's deterministic PNG of the project memories the
 * injection budget left out. The DSH adapter contributes exactly the gates
 * and the delivery:
 *
 *  - flag + identity + ROUTE capability: the image only ships when
 *    `mural.enabled` is on AND the routed model advertises `image` input;
 *    an unknown-capability route gets a text-only baseline;
 *  - delivery: the encoded PNG commits through the host attachment store and
 *    the baseline node carries an `image` content block next to its text,
 *    with the core's `<memory-mural>` guidance block in the text.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { computeCueContentHash } from "@magic-context/core/features/magic-context/mural/storage-mural-cues";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { type AdapterHandle, mountAdapter } from "../src/index.js";
import type { HistorianRoute } from "../src/sessions/historian.js";
import type { DshLogMessageRecord } from "../src/surface/dsh-session-log.js";
import type { MuralAttachments } from "../src/surface/head.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
let projectDir: string;
let identity: string;
const handles: AdapterHandle[] = [];

const records: readonly DshLogMessageRecord[] = [
	{
		seq: 1,
		messageId: "m-1",
		role: "user",
		text: "seed the vault",
		createdAt: Date.UTC(2026, 0, 10),
	},
	{
		seq: 2,
		messageId: "m-2",
		role: "assistant",
		text: "vault seeded",
		createdAt: Date.UTC(2026, 0, 10),
	},
];

interface FakeAttachments extends MuralAttachments {
	readonly calls: number;
	readonly bytes: Uint8Array[];
}

function fakeAttachments(): FakeAttachments {
	const bytes: Uint8Array[] = [];
	return {
		bytes,
		get calls() {
			return bytes.length;
		},
		async saveImages(inputs) {
			bytes.push(inputs[0]!.data);
			return inputs.map(
				(_, i) =>
					({
						attachmentId: `att-${String(i)}`,
						mediaType: "image/png",
						bytes: 1_024,
						width: 1_092,
						height: 1_092,
					}) as unknown as ImageAttachmentRef,
			);
		},
	};
}

beforeAll(async () => {
	setHarness("dsh");
	db = (await openDatabaseAsync({
		dbPath: join(getMagicContextStorageDir(), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-mural-proj-"));
	identity = resolveProjectIdentityForSession(projectDir)!;
	// 16 active memories, every one with a hash-current mural cue; a 50-token
	// memory budget puts the whole pool into the overflow the mural renders.
	for (let i = 0; i < 16; i += 1) {
		const content = `Memory ${String(i)}: the vault rule numbered ${String(i)} governs archival conduct of the north wind farm, its turbine service windows, spare parts ledgers, and the quarterly noise audit procedure.`;
		const memory = insertMemory(db, {
			projectPath: identity,
			category: "PROJECT_RULES",
			content,
		});
		db.prepare(
			"UPDATE memories SET mural_cue = ?, mural_cue_hash = ?, mural_cue_at = ? WHERE id = ?",
		).run(
			`vault rule ${String(i)}`,
			computeCueContentHash(content),
			Date.now(),
			memory.id,
		);
	}
});

afterAll(async () => {
	for (const handle of handles) await handle.dispose();
	handles.length = 0;
	await closeDatabase();
});

describe("mural wiring (T047)", () => {
	test("image-capable route: baseline carries the block, PNG commits via attachments", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({
			mural: { enabled: true },
			memory: { injection_budget_tokens: 500 },
		});
		const attachments = fakeAttachments();
		const route: HistorianRoute = {
			provider: "mock",
			model: "vision",
			imageInput: true,
		};
		const handle = mountAdapter(host, config, db, {
			readSessionLog: () => records,
			projectDir,
			historianRoute: route,
			attachments,
		});
		handles.push(handle);
		const session = host.addSession({ id: "s-mural" });
		host.pressureReadings.set("s-mural", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host.firePreStep({ sessionId: "s-mural", turn: 1, step: 1 }),
		).toBe("enter");

		const head = handle.head.peek("s-mural");
		expect(head).toBeDefined();
		expect(head!.text).toContain("<memory-mural>");
		// One image commit: the core's deterministic PNG, through the store.
		expect(attachments.calls).toBe(1);
		expect(attachments.bytes[0]!.length).toBeGreaterThan(100);
		expect(attachments.bytes[0]!.subarray(1, 4)).toEqual(
			Uint8Array.from([0x50, 0x4e, 0x47]),
		); // "PNG"
		// The baseline node carries an image content block beside its text.
		const baseline = session.notices.find((notice) =>
			notice.content.some(
				(block) =>
					block.type === "text" && block.text.includes("<memory-mural>"),
			),
		);
		expect(baseline).toBeDefined();
		expect(baseline!.content.some((block) => block.type === "image")).toBe(
			true,
		);

		await handle.dispose();
		handles.pop();
	});

	test("route without image input: text-only baseline, zero image commits", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({
			mural: { enabled: true },
			memory: { injection_budget_tokens: 500 },
		});
		const attachments = fakeAttachments();
		const route: HistorianRoute = {
			provider: "mock",
			model: "text-only",
			imageInput: false,
		};
		const handle = mountAdapter(host, config, db, {
			readSessionLog: () => records,
			projectDir,
			historianRoute: route,
			attachments,
		});
		handles.push(handle);
		host.addSession({ id: "s-mural-off" });
		host.pressureReadings.set("s-mural-off", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host.firePreStep({ sessionId: "s-mural-off", turn: 1, step: 1 }),
		).toBe("enter");

		const head = handle.head.peek("s-mural-off");
		expect(head).toBeDefined();
		expect(head!.text).not.toContain("<memory-mural>");
		expect(attachments.calls).toBe(0);

		await handle.dispose();
		handles.pop();
	});

	test("flag off: no mural even on an image-capable route", async () => {
		const host = new TestDshHost();
		const config = MagicContextConfigSchema.parse({});
		const attachments = fakeAttachments();
		const route: HistorianRoute = {
			provider: "mock",
			model: "vision",
			imageInput: true,
		};
		const handle = mountAdapter(host, config, db, {
			readSessionLog: () => records,
			projectDir,
			historianRoute: route,
			attachments,
		});
		handles.push(handle);
		host.addSession({ id: "s-mural-flag" });
		host.pressureReadings.set("s-mural-flag", {
			pressureTokens: 1_000,
			contextWindow: 100_000,
		});
		expect(
			await host.firePreStep({ sessionId: "s-mural-flag", turn: 1, step: 1 }),
		).toBe("enter");

		const head = handle.head.peek("s-mural-flag");
		expect(head).toBeDefined();
		expect(head!.text).not.toContain("<memory-mural>");
		expect(attachments.calls).toBe(0);

		await handle.dispose();
		handles.pop();
	});
});
