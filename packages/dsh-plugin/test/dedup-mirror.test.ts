/**
 * R-07 drift pin: the DSH no-work detector mirrors the core's module-private
 * `DEDUP_SAFE_TOOLS` idempotence list (`heuristic-cleanup.ts`). The core is
 * read-only and the set is not exported, so the pin is literal: parse the
 * core source and compare sets. Silent drift is exactly what makes the
 * detector miss work the core would do (or claim work it would not).
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEDUP_SAFE_TOOLS } from "../src/lanes/heuristics.js";

test("DEDUP_SAFE_TOOLS mirror equals the core list verbatim", () => {
	const coreSource = readFileSync(
		join(
			import.meta.dir,
			"../../plugin/src/hooks/magic-context/heuristic-cleanup.ts",
		),
		"utf8",
	);
	const declaration = coreSource.match(
		/const DEDUP_SAFE_TOOLS = new Set\(\[([\s\S]*?)\]\)/,
	);
	expect(declaration).not.toBeNull();
	const coreTools = new Set(
		[...(declaration![1] as string).matchAll(/"([^"]+)"/g)].map(
			(match) => match[1],
		),
	);
	expect(coreTools.size).toBeGreaterThan(0);
	const mirrored = new Set(DEDUP_SAFE_TOOLS);
	const onlyCore = [...coreTools].filter((t) => !mirrored.has(t));
	const onlyMirror = [...mirrored].filter((t) => !coreTools.has(t));
	expect({ onlyCore, onlyMirror }).toEqual({ onlyCore: [], onlyMirror: [] });
});
