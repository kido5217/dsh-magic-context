/**
 * DSH tool registration seam (T031).
 *
 * Registers the five ctx_* tools over a `DshHost` and returns ONE aggregated
 * disposer (unregister all five). Subagent sessions get the same five tools —
 * FR-005 gives them no special surface, so there is no session-kind branching
 * here; the caller passes the subagent's own `sessionId()`.
 *
 * Descriptions/preset behavior come from the core prompt surface via
 * `promptSurfaceRuntime.resolveRegistration`; nothing here forks copy.
 */
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { PromptSurfaceConfig } from "@magic-context/core/config/schema/magic-context";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import type { PromptSurfaceRuntime } from "@magic-context/core/shared/prompt-surface-runtime";
import type { DshHost } from "../host.js";
import { createCtxExpandTool } from "./expand.js";
import { createCtxMemoryTool } from "./memory.js";
import { createCtxNoteTool } from "./note.js";
import { createCtxReduceTool } from "./reduce.js";
import { createCtxSearchTool } from "./search.js";
import type { ToolSurface } from "./surface.js";
import {
	stringToolOutput,
	surfaceDescription,
	surfaceParameterDescriptions,
} from "./surface.js";

export interface RegisterMagicContextToolsDshOptions {
	db: ContextDatabase;
	/** Resolved per call so a shared registration can follow session switches. */
	sessionId: () => string;
	/** Workspace directory; project identity for memories/search resolves from it. */
	projectDir: string;
	/** Recent-tag protection window (enforced by the core release pass). */
	protectedTags: number;
	/** Reranker connection file for the search lane, when configured. */
	rerankConnectionFile?: string;
	/** Core prompt-surface runtime; source of truth for descriptions. */
	promptSurfaceRuntime: PromptSurfaceRuntime;
	/** Prompt-surface config (`surface`/`surfaces`); undefined → preset "full". */
	promptSurface?: PromptSurfaceConfig;
	/** Model key for per-model surface epochs. */
	modelKey?: string;
	/** Feature gates mirroring the plugin config (all default ON). */
	smartNotesEnabled?: boolean;
	dreamerEnabled?: boolean;
	memoryEnabled?: boolean;
	gitCommitsEnabled?: boolean;
	/** Per-tool render templates for ctx_expand verbose ranges. */
	expandTools?: Record<string, string | false>;
}

/**
 * Per-call session resolution (T018): the calling agent owns the session.
 * `opts.sessionId` is only a test/double fallback; production passes a resolver
 * that throws when a tool runs outside an agent turn.
 */
function sessionIdForCall(
	opts: { readonly sessionId: () => string },
	exec?: ToolRunContext,
): string {
	const agentId = exec?.agent?.id;
	if (agentId !== undefined) return String(agentId);
	return opts.sessionId();
}

export function registerMagicContextToolsDsh(
	host: DshHost,
	opts: RegisterMagicContextToolsDshOptions,
): () => void {
	const registration = opts.promptSurfaceRuntime.resolveRegistration(
		opts.promptSurface,
		opts.modelKey,
	);
	// Smart-note writes need the dreamer lane to eventually wake them; with
	// either off, the parameter is dropped and the description is stripped
	// (Pi parity: never park a note that could never surface).
	const smartNotesAvailable =
		opts.smartNotesEnabled !== false && opts.dreamerEnabled !== false;
	const surface: ToolSurface = { registration, smartNotesAvailable };

	const disposers: Array<() => void> = [
		host.registerTool(
			createCtxSearchTool({
				db: opts.db,
				sessionId: (exec?: ToolRunContext) => sessionIdForCall(opts, exec),
				projectDir: opts.projectDir,
				memoryEnabled: opts.memoryEnabled,
				gitCommitsEnabled: opts.gitCommitsEnabled,
				rerankConnectionFile: opts.rerankConnectionFile,
				surface,
			}),
		),
		host.registerTool(
			createCtxMemoryTool({
				db: opts.db,
				sessionId: (exec?: ToolRunContext) => sessionIdForCall(opts, exec),
				projectDir: opts.projectDir,
				memoryEnabled: opts.memoryEnabled,
				surface,
			}),
		),
		host.registerTool(
			createCtxNoteTool({
				db: opts.db,
				sessionId: (exec?: ToolRunContext) => sessionIdForCall(opts, exec),
				projectDir: opts.projectDir,
				smartNotesEnabled: opts.smartNotesEnabled,
				dreamerEnabled: opts.dreamerEnabled,
				surface,
			}),
		),
		host.registerTool(
			createCtxExpandTool({
				db: opts.db,
				sessionId: (exec?: ToolRunContext) => sessionIdForCall(opts, exec),
				expandTools: opts.expandTools,
				surface,
			}),
		),
		host.registerTool(
			createCtxReduceTool({
				db: opts.db,
				sessionId: (exec?: ToolRunContext) => sessionIdForCall(opts, exec),
				protectedTags: opts.protectedTags,
				surface,
			}),
		),
	];

	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		// Reverse registration order, each disposer runs even if one throws.
		const errors: unknown[] = [];
		for (let i = disposers.length - 1; i >= 0; i--) {
			try {
				disposers[i]();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0)
			throw new AggregateError(errors, "ctx_* tool teardown failed");
	};
}

export type { ToolSurface };
export {
	createCtxExpandTool,
	createCtxMemoryTool,
	createCtxNoteTool,
	createCtxReduceTool,
	createCtxSearchTool,
	stringToolOutput,
	surfaceDescription,
	surfaceParameterDescriptions,
};
