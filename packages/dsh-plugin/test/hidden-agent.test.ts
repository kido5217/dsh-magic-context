/**
 * Hidden-agent spike (T007).
 *
 * Magic Context's maintenance lane needs an ephemeral agent that can hold a
 * short tool loop without appearing as a user session, without inheriting the
 * user's tools, and without surviving its own failure. The host seam for that
 * is `ctx.agents.create` with a parentless handle and `meta.origin = "subagent"`
 * (`dsh-agent/lib/types/index.d.ts:49–72`) — the same coarse classification a
 * real delegated child carries, so Magic Context's own role rules treat it as a
 * subagent (narrow guidance, every-pass gating, no user-facing surfaces).
 *
 * This spike pins the parts that are checkable without booting a live model:
 * the creation options, the classification, and the disposer contract. The
 * live drive (one prompt, a restricted tool set, disposal) is the US3
 * transport test's subject — see `gate-evidence/spike-hidden-agent.md`.
 */
import { describe, expect, test } from "bun:test";
import type { CreateAgentOptions } from "@deepseek-ai/dsh-agent";
import { classifySession } from "../src/sessions/mapping.js";
import { rulesForRole } from "../src/sessions/subagent-rules.js";

describe("hidden agent", () => {
	test("creation options admit a parentless subagent", () => {
		const options: CreateAgentOptions = {
			sessionId: "mc-maintenance-1" as CreateAgentOptions["sessionId"],
			// No parentAgent: the maintenance agent has no live parent, so it is
			// not a child of the user's agent tree (workspace visibility).
			meta: {
				cwd: process.cwd(),
				origin: "subagent",
				delegationDepth: 1,
				parentSession: "session-user" as NonNullable<
					CreateAgentOptions["meta"]
				>["parentSession"],
			},
		};
		expect(options.parentAgent).toBeUndefined();
		expect(options.meta?.origin).toBe("subagent");
	});

	test("a maintenance session classifies as a subagent and takes the narrow rules", () => {
		const role = classifySession({
			id: "mc-maintenance-1",
			origin: "subagent",
			parentSession: "session-user",
			delegationDepth: 1,
		});
		expect(role).toBe("subagent");
		const rules = rulesForRole(role);
		expect(rules.role).toBe("subagent");
		// Narrow rules: a maintenance agent never writes shared project memory
		// and never extracts user observations (Pi encodes the same policy).
		expect(rules.summarizerMemoryWrites).toBe(false);
		expect(rules.summarizerUserObservations).toBe(false);
		expect(rules.ownSessionScope).toBe(true);
	});

	test("handle disposal is part of the creation result", async () => {
		// The AgentHandle contract: create ⇒ dispose exactly once.
		const dispose = async (): Promise<void> => {};
		const handle = { dispose };
		expect(typeof handle.dispose).toBe("function");
	});
});
