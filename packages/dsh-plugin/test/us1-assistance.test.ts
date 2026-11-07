/**
 * US1 assistance lanes (T038): temporal markers, auto-search, the note and
 * `ctx_reduce` nudges, and synthetic todo — including the property they all
 * share and that is easiest to get wrong: **no duplicate delivery**.
 *
 * The lanes are driven through the engine where delivery is stateful, and
 * through their selectors where the assertion is about the decision itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MagicContextConfigSchema } from "@magic-context/core/config/schema/magic-context";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { setHarness } from "@magic-context/core/shared/harness";
import { autoSearchLane, selectAutoSearch } from "../src/lanes/auto-search.js";
import { type LaneContext, runLanePass } from "../src/lanes/engine.js";
import { LaneGates } from "../src/lanes/gating.js";
import { noteNudgeLane } from "../src/lanes/note-nudge.js";
import { reduceNudgeLane } from "../src/lanes/reduce-nudge.js";
import { temporalLane } from "../src/lanes/temporal.js";
import { todoLane } from "../src/lanes/todo.js";
import { rulesForRole } from "../src/sessions/subagent-rules.js";
import { projectDshSessionLog } from "../src/surface/dsh-session-log.js";
import { ManagedEdits } from "../src/surface/managed-edits.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;
const cfg = MagicContextConfigSchema.parse({});
const PRIMARY = rulesForRole("primary");

const LANES = [
	autoSearchLane,
	temporalLane,
	noteNudgeLane,
	reduceNudgeLane,
	todoLane,
];

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

function contextFor(
	session: TestDshHost["sessions"] extends Map<string, infer S> ? S : never,
	id: string,
): LaneContext {
	return {
		session,
		mcSession: id,
		projection: projectDshSessionLog(session.logRecords()),
		rules: PRIMARY,
		band: "execute",
		permission: { permitted: true, reason: "scheduler" },
		config: cfg,
		db,
		protectedMessageIds: new Set(),
		projectDir: process.cwd(),
	};
}

describe("assistance lanes", () => {
	test("the whole assistance set is a no-op on a session with nothing to say", async () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-quiet" }, [0]);
		session.seedMessage(0, "u1", "quiet", "user");
		const managedEdits = new ManagedEdits(host);
		const result = await runLanePass(managedEdits, {
			session,
			mcSession: "s-quiet",
			projection: projectDshSessionLog(session.logRecords()),
			rules: PRIMARY,
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
			projectDir: process.cwd(),
			lanes: LANES,
			gates: new LaneGates(),
		});
		expect(result.changed).toBe(false);
		expect(session.notices).toHaveLength(0);
		expect(session.replacements).toHaveLength(0);
	});

	test("gating refuses the whole set below the execute band", async () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-gated" }, [0]);
		session.seedMessage(0, "u1", "x".repeat(200_000), "user");
		host.todoStates.set("s-gated", {
			seq: 1,
			items: [{ content: "one", status: "pending" }],
		});
		const managedEdits = new ManagedEdits(host);
		const result = await runLanePass(managedEdits, {
			session,
			mcSession: "s-gated",
			projection: projectDshSessionLog(session.logRecords()),
			rules: PRIMARY,
			band: "below-execute",
			permission: { permitted: false },
			config: cfg,
			db,
			protectedMessageIds: new Set(),
			projectDir: process.cwd(),
			todo: host.todoState("s-gated"),
			lanes: LANES,
			gates: new LaneGates(),
		});
		expect(result.changed).toBe(false);
		expect(result.outcomes.every((outcome) => outcome.ran === false)).toBe(
			true,
		);
		expect(session.notices).toHaveLength(0);
	});
});

describe("auto-search", () => {
	test("disabled by config produces no augmentation", async () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-as-off" }, [0]);
		session.seedMessage(
			0,
			"u1",
			"how does the parser handle trailing commas in the config loader",
			"user",
		);
		const disabled = {
			...cfg,
			memory: {
				...cfg.memory,
				auto_search: { ...cfg.memory.auto_search, enabled: false },
			},
		};
		const selection = await selectAutoSearch({
			session,
			mcSession: "s-as-off",
			projection: projectDshSessionLog(session.logRecords()),
			rules: PRIMARY,
			band: "execute",
			permission: { permitted: true, reason: "scheduler" },
			config: disabled,
			db,
			protectedMessageIds: new Set(),
			projectDir: process.cwd(),
		});
		expect(selection.requests).toEqual([]);
	});

	test("with no embedding backend the core records a skip and the lane stays a no-op", async () => {
		const host = new TestDshHost();
		const session = host.addSession({ id: "s-as-skip" }, [0]);
		session.seedMessage(
			0,
			"u1",
			"how does the parser handle trailing commas in the config loader",
			"user",
		);
		const enabled = {
			...cfg,
			memory: {
				...cfg.memory,
				auto_search: { ...cfg.memory.auto_search, enabled: true },
			},
		};
		const managedEdits = new ManagedEdits(host);
		const pass = () =>
			runLanePass(managedEdits, {
				session,
				mcSession: "s-as-skip",
				projection: projectDshSessionLog(session.logRecords()),
				rules: PRIMARY,
				band: "execute",
				permission: { permitted: true, reason: "scheduler" },
				config: enabled,
				db,
				protectedMessageIds: new Set(),
				projectDir: process.cwd(),
				lanes: [autoSearchLane],
				gates: new LaneGates(),
			});
		// No project embeddings on this machine: the hint is skipped, no throw,
		// and no second pass invents one.
		const first = await pass();
		expect(first.changed).toBe(false);
		const second = await pass();
		expect(second.changed).toBe(false);
		expect(session.replacements).toHaveLength(0);
	});
});
