/**
 * DSH wrapper for the `ctx_expand` tool (T027).
 *
 * Delegates to the same core read/render path as the Pi/OpenCode wrappers:
 * `resolveCtxExpandMode` → `renderItemByTag` / `renderMessageByOrdinal` /
 * `renderSearchArchive` / `readSessionChunk`, so recovered originals are
 * byte-identical to storage (SC-002) — no reformatting in the adapter.
 *
 * Unlike Pi (which installs `readPiSessionMessages` for one call), DSH keeps
 * per-session `RawMessageProvider` registration in the sessions layer; this
 * tool only checks the provider is present and reads through it.
 */
import {
	defineTool,
	type ParameterSchemaSpec,
	type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	hasRawMessageProvider,
	readSessionChunk,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { ToolExpansionMap } from "@magic-context/core/shared/historian-tool-template";
import {
	CTX_EXPAND_DESCRIPTION,
	CTX_EXPAND_TOKEN_BUDGET,
} from "@magic-context/core/tools/ctx-expand/constants";
import { resolveCtxExpandMode } from "@magic-context/core/tools/ctx-expand/mode";
import {
	renderItemByTag,
	renderMessageByOrdinal,
	renderVerboseRangeForTool,
} from "@magic-context/core/tools/ctx-expand/render";
import { renderSearchArchive } from "@magic-context/core/tools/ctx-expand/search-archive";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import type { ToolSurface } from "./surface";
import {
	stringToolOutput,
	surfaceDescription,
	surfaceParameterDescriptions,
} from "./surface";

export interface CtxExpandToolDshDeps {
	db: ContextDatabase;
	sessionId: () => string;
	expandTools?: Record<string, string | false>;
	surface: ToolSurface;
}

export function createCtxExpandTool(
	deps: CtxExpandToolDshDeps,
): ToolDefinition {
	const parameters = {
		tag: {
			oneOf: [{ type: "number" }, { type: "string" }],
			description:
				"Tag number from a §N§ tag or a [dropped §N§] placeholder, not a message ordinal. Returns that one item in full. Use alone.",
		},
		start: {
			type: "number",
			description:
				"First message ordinal of the range (a <session-history> heading's start, or a ctx_search hit), not a tag number.",
		},
		end: {
			type: "number",
			description:
				"Last message ordinal of the range, inclusive, not a tag number.",
		},
		verbose: {
			type: "boolean",
			description:
				"With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
		},
		message: {
			type: "number",
			description:
				"Message ordinal from a <session-history> heading or a ctx_search hit, not a tag number. Returns that one message in full. Use alone.",
		},
	} satisfies ParameterSchemaSpec;
	surfaceParameterDescriptions("ctx_expand", parameters, deps.surface);

	return defineTool({
		name: "ctx_expand",
		description: surfaceDescription(
			"ctx_expand",
			CTX_EXPAND_DESCRIPTION,
			deps.surface,
		),
		parameters,
		output: stringToolOutput(),
		async execute(rawArgs) {
			const args = unwrapImitatedReducedArgs(
				rawArgs as Record<string, unknown>,
				["tag", "message", "start"],
				{
					start: "number",
					end: "number",
					verbose: "boolean",
					message: "number",
				},
			);
			const sessionId = deps.sessionId();
			if (!hasRawMessageProvider(sessionId)) {
				throw new Error(
					"Error: this session has no raw-history source registered yet; retry ctx_expand shortly.",
				);
			}
			const mode = resolveCtxExpandMode(args, "positive");
			if (mode.kind === "error") throw new Error(mode.message);

			if (mode.kind === "tag") {
				// `text` domain: the adapter's provider + core tagTranscript number
				// text parts, mirroring the Pi lane.
				return renderItemByTag(deps.db, sessionId, mode.tag, "text");
			}

			const archivedForMessage =
				mode.kind === "message"
					? renderSearchArchive(
							deps.db,
							sessionId,
							mode.message,
							mode.message,
							CTX_EXPAND_TOKEN_BUDGET,
						)
					: null;

			if (mode.kind === "message") {
				return (
					archivedForMessage ?? renderMessageByOrdinal(sessionId, mode.message)
				);
			}

			const { start, verbose } = mode;
			// Clamp to the last compartment boundary (parity with OpenCode): past
			// that point the tail is already visible in context.
			const lastCompartmentEnd = getLastCompartmentEndMessage(
				deps.db,
				sessionId,
			);
			if (lastCompartmentEnd >= 0 && start > lastCompartmentEnd) {
				return `Range ${start}-${mode.end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`;
			}
			const effectiveEnd =
				lastCompartmentEnd >= 0
					? Math.min(mode.end, lastCompartmentEnd)
					: mode.end;
			if (verbose) {
				return renderVerboseRangeForTool(
					sessionId,
					start,
					effectiveEnd,
					CTX_EXPAND_TOKEN_BUDGET,
					deps.expandTools as ToolExpansionMap | undefined,
				);
			}
			const archived = renderSearchArchive(
				deps.db,
				sessionId,
				start,
				effectiveEnd,
				CTX_EXPAND_TOKEN_BUDGET,
			);
			if (archived) {
				return archived;
			}

			const chunk = readSessionChunk(
				sessionId,
				CTX_EXPAND_TOKEN_BUDGET,
				start,
				effectiveEnd + 1, // readSessionChunk uses exclusive end
				{ expand: false },
			);

			if (!chunk.text || chunk.messageCount === 0) {
				return `No messages found in range ${start}-${effectiveEnd}. The range may be outside this session's history.`;
			}

			const lines: string[] = [];
			lines.push(
				`Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
			);
			lines.push("");
			lines.push(chunk.text);

			if (chunk.endIndex < effectiveEnd) {
				lines.push("");
				lines.push(
					`Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
				);
			}

			return lines.join("\n");
		},
	});
}
