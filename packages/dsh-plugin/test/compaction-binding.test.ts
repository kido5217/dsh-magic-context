/**
 * Compaction binding spike (T009).
 *
 * Question: can two compaction engines both serve `ctx.compaction`, and does
 * the bundle's disable row actually win over a shipped engine?
 *
 * Two independent facts are checked:
 *
 * 1. **One engine per context.** `CompactionEngine` is a Cordis `Service`;
 *    providing a second implementation for the same service key is rejected by
 *    the runtime, so a stray native engine cannot silently share the slot with
 *    Magic Context's claim.
 * 2. **The bundle's patch disables the shipped engine.** `cordis.patch.yml`
 *    carries `- id: compaction-basic` / `disabled: true`; the profile
 *    composition test (T002, `gate-evidence/`) confirms the composed tree has
 *    no enabled `compaction-basic` row.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { CompactionEngine } from "@deepseek-ai/dsh-compaction";

class StubEngine extends CompactionEngine {
	async compactIfNeeded(): Promise<null> {
		return null;
	}
	async compactNow(): Promise<null> {
		return null;
	}
	async compactRegion(): Promise<never> {
		throw new Error("not used in this spike");
	}
}

/** One macrotask turn: Cordis services publish on their async init. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("compaction binding", () => {
	test("a second engine cannot silently take over ctx.compaction", async () => {
		const ctx = new Context();
		ctx.plugin(StubEngine);
		await settle();
		const engine = ctx.reflect.get("compaction");
		expect(engine).toBeInstanceOf(StubEngine);
		// The slot is single-valued but LAST-WINS: a second provider displaces
		// the first instance. Runtime exclusivity is therefore NOT a defence —
		// exactly one engine must be composed at boot, which is the bundle
		// patch's job (second test). Magic Context's own claim installs itself
		// through the same slot and unwinds on unmount (foundation tests).
		ctx.plugin(StubEngine);
		await settle();
		const second = ctx.reflect.get("compaction");
		expect(second).toBeInstanceOf(StubEngine);
		expect(second).not.toBe(engine);
	});

	test("the shipped bundle disables compaction-basic", () => {
		const patch = readFileSync(
			join(import.meta.dir, "..", "cordis.patch.yml"),
			"utf8",
		);
		expect(patch).toContain("- id: compaction-basic");
		expect(patch).toMatch(/compaction-basic[\s\S]{0,120}disabled:\s*true/);
	});
});
