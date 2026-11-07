/**
 * V4 live gate (T052): the mural ships as an image only over an
 * image-capable route; on a text-only route the mural stays off the wire and
 * the route fact is recorded (quickstart V4, FR-006).
 *
 * Same store, same project, same 16-memory pool that overflows the injection
 * budget — only the routed model's advertised input modalities change. The
 * profile's default model is flipped between the two runs; the mock provider
 * records the `model` each request actually used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getLogFilePath } from "@magic-context/core/shared/logger";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { computeCueContentHash } from "@magic-context/core/features/magic-context/mural/storage-mural-cues";
import {
	type ContextDatabase,
	closeDatabase,
	openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { setHarness } from "@magic-context/core/shared/harness";
import { createLiveHome, type LiveHome } from "./live-home.js";
import {
	MOCK_API_KEY_ENV,
	mockProviderEnv,
	startMockProvider,
} from "./mock-provider.js";

const provider = startMockProvider();
let home: LiveHome | undefined;
let db: ContextDatabase;
let projectDir: string;
let evidenceDir: string;

function contentText(message: Record<string, unknown>): string {
	const content = message["content"];
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.map((part) =>
				typeof part === "object" && part !== null && "text" in part
					? String((part as { text?: string }).text ?? "")
					: "",
			)
			.join("\n");
	return "";
}

function lastBaseline(): { text: string; raw: string } {
	let text = "";
	let raw = "";
	for (const request of provider.requests) {
		const body = JSON.stringify(request.body);
		if (!body.includes("## Magic Context")) continue;
		raw = body;
		for (const message of request.body["messages"] as Record<string, unknown>[])
			if (contentText(message).includes("## Magic Context"))
				text = contentText(message);
	}
	return { text, raw };
}

function setDefaultModel(model: string): void {
	const patch = join(home!.home, "profiles", home!.profile, "cordis.patch.yml");
	const rows = JSON.parse(readFileSync(patch, "utf8")) as Record<
		string,
		unknown
	>[];
	for (const row of rows) {
		if (row["name"] === "@deepseek-ai/dsh-agent-default-model")
			(row.config as Record<string, unknown>).model = model;
	}
	writeFileSync(patch, `${JSON.stringify(rows, null, 2)}\n`);
}

/**
 * The durable route fact: the adapter records the skip through the host's
 * session-log seam (and core logs), both under the live home.
 */
function muralLogLines(): string {
	const hits: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else {
				for (const line of readFileSync(path, "utf8").split("\n"))
					if (
						line.includes("mural") &&
						line.includes("[magic-context]")
					)
						hits.push(line);
			}
		}
	};
	for (const root of [
		join(home!.home, "data", "cortexkit", "magic-context"),
		join(home!.home, "sessions"),
		dirname(getLogFilePath()),
	]) {
		try {
			walk(root);
		} catch {
			/* no logs at this root */
		}
	}
	return hits.join("\n");
}

beforeAll(async () => {
	// Parent-side core writes must carry the harness the CHILD reads under.
	setHarness("dsh");
	evidenceDir = `${import.meta.dir}/../tmp/gate-evidence/v4-mural`;
	mkdirSync(evidenceDir, { recursive: true });
	const homeRoot = `${import.meta.dir}/../tmp/live-v4`;
	// Aim the PARENT's core store (test isolation honours XDG_DATA_HOME when
	// it differs from the preload pin) at the child's home so parent-side
	// seeding lands in the child's real store.
	process.env.XDG_DATA_HOME = join(homeRoot, "home", "data");
	// The fact must come from THIS run: start the shared harness log clean.
	try {
		rmSync(getLogFilePath());
	} catch {
		/* no log yet */
	}
	home = createLiveHome({
		root: homeRoot,
		route: {
			provider: "mock",
			baseURL: provider.baseURL,
			apiKeyEnv: MOCK_API_KEY_ENV,
			models: [
				{
					id: "mock-vision",
					contextWindow: 20_000,
					input: ["text", "image"],
				},
				{ id: "mock-text", contextWindow: 20_000 },
			],
		},
		defaultModel: "mock-vision",
	});
	db = (await openDatabaseAsync({
		dbPath: join(home.home, "data", "cortexkit", "magic-context", "context.db"),
		nativeTurnDeadlines: true,
	}))!;
	projectDir = mkdtempSync(join(tmpdir(), "mc-v4-proj-"));
	writeFileSync(
		join(projectDir, "ARCHITECTURE.md"),
		"The system has a vault module and a nightly build script.\n",
	);
	// The plugin reads the SHARED CortexKit config layers (config/index.ts) —
	// the project layer drives mural + budget, exactly as for any other host.
	mkdirSync(join(projectDir, ".cortexkit"), { recursive: true });
	writeFileSync(
		join(projectDir, ".cortexkit", "magic-context.jsonc"),
		JSON.stringify({
			mural: { enabled: true },
			memory: { injection_budget_tokens: 500 },
		}),
	);
	const identity = resolveProjectIdentityForSession(projectDir)!;
	// 16 active memories, every one with a hash-current mural cue; the 500-token
	// budget from the profile patch puts the whole pool into the overflow the
	// mural renders.
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
	home?.dispose();
	provider.stop();
	await closeDatabase();
});

describe("V4 live", () => {
	test("the mural ships on the vision route and is a recorded route fact on the text route", async () => {
		// Both runs are fresh sessions: managed writes wait for step 2, so
		// each first turn carries a tool call.
		provider.script([
			{
				toolCalls: [
					{
						name: "read",
						arguments: JSON.stringify({
							path: join(projectDir, "ARCHITECTURE.md"),
						}),
					},
				],
				promptTokens: 600,
			},
			{ text: "recalled", promptTokens: 600 },
			{
				toolCalls: [
					{
						name: "read",
						arguments: JSON.stringify({
							path: join(projectDir, "ARCHITECTURE.md"),
						}),
					},
				],
				promptTokens: 600,
			},
			{ text: "recalled again", promptTokens: 600 },
		]);

		const vision = await home!.runHeadlessAsync("recall the vault rules", {
			cwd: projectDir,
			env: mockProviderEnv(),
		});
		expect(
			vision.status,
			`child failed: ${vision.stderr.slice(0, 1_200)}`,
		).toBe(0);
		expect(vision.stderr).not.toContain("TEST BACKSTOP");

		const onVision = lastBaseline();
		expect(onVision.text).toContain("<memory-mural>");
		expect(onVision.raw).toContain("data:image/png");
		expect(onVision.raw).toContain('"model":"mock-vision"');

		// Same store, same project — only the routed model changes.
		setDefaultModel("mock-text");
		const text = await home!.runHeadlessAsync("recall them again", {
			cwd: projectDir,
			env: mockProviderEnv(),
		});
		expect(text.status, `child failed: ${text.stderr.slice(0, 1_200)}`).toBe(0);

		writeFileSync(
			join(evidenceDir, "request-ledger.json"),
			JSON.stringify(
				provider.requests.map((request) => ({
					model: String(request.body["model"] ?? ""),
					hasBaseline: JSON.stringify(request.body).includes(
						"## Magic Context",
					),
					hasMural: JSON.stringify(request.body).includes("<memory-mural>"),
					hasImage: JSON.stringify(request.body).includes("data:image"),
				})),
				null,
				2,
			),
		);
		const onText = lastBaseline();
		expect(onText.text).toContain("## Magic Context");
		expect(onText.text).not.toContain("<memory-mural>");
		expect(onText.raw).not.toContain("data:image/png");
		expect(onText.raw).toContain('"model":"mock-text"');

		// The skip is a recorded route fact, not a silent no-op.
		const log = muralLogLines();
		expect(log).toContain("mural skipped: routed model lacks image input");

		writeFileSync(join(evidenceDir, "head-vision.txt"), onVision.text);
		writeFileSync(join(evidenceDir, "head-text.txt"), onText.text);
		writeFileSync(join(evidenceDir, "mural-skip-log.txt"), log);
		writeFileSync(
			join(evidenceDir, "route-info.json"),
			JSON.stringify(
				{
					vision: {
						model: "mock-vision",
						input: ["text", "image"],
						carriesMural: onVision.text.includes("<memory-mural>"),
						carriesImageBytes: onVision.raw.includes("data:image/png"),
					},
					text: {
						model: "mock-text",
						input: ["text"],
						carriesMural: onText.text.includes("<memory-mural>"),
						recordedSkip: log.includes("routed model lacks image input"),
					},
				},
				null,
				2,
			),
		);
	}, 300_000);
});
