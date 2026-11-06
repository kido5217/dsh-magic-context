/**
 * DSH wrapper for the `ctx_reduce` tool (T026).
 *
 * Mirrors the Pi wrapper (`pi-plugin/src/tools/ctx-reduce.ts`) and OpenCode's
 * `packages/plugin/src/tools/ctx-reduce/tools.ts`. Marking QUEUES content for
 * release; it stays visible until a managed change releases it, which may be
 * the next turn or many turns later. Protection (`protectedTags`) is honored
 * by the core release path (`applyPendingOperations`), not at stamp time —
 * stamping recent/protected output is harmless, so this stays queue-only.
 */
import {
	defineTool,
	type ParameterSchemaSpec,
	type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import { parseRangeString } from "@magic-context/core/features/magic-context/range-parser";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getInertWhitespaceAssistantTagsByNumbers } from "@magic-context/core/features/magic-context/storage-tags";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import {
	CTX_REDUCE_DESCRIPTION,
	formatCtxReduceReply,
} from "@magic-context/core/tools/ctx-reduce/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import type { ToolSurface } from "./surface";
import {
	stringToolOutput,
	surfaceDescription,
	surfaceParameterDescriptions,
} from "./surface";

export interface CtxReduceToolDshDeps {
	db: ContextDatabase;
	/** Resolved at call time: drops are written against the CURRENT session. */
	sessionId: () => string;
	/** Kept for surface parity with Pi; enforcement lives in the core release pass. */
	protectedTags?: number;
	surface: ToolSurface;
}

export function createCtxReduceTool(
	deps: CtxReduceToolDshDeps,
): ToolDefinition {
	const parameters = {
		drop: {
			type: "string",
			description: 'Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".',
		},
	} satisfies ParameterSchemaSpec;
	surfaceParameterDescriptions("ctx_reduce", parameters, deps.surface);

	return defineTool({
		name: "ctx_reduce",
		description: surfaceDescription(
			"ctx_reduce",
			CTX_REDUCE_DESCRIPTION,
			deps.surface,
		),
		parameters,
		output: stringToolOutput(),
		async execute(rawArgs) {
			const params = unwrapImitatedReducedArgs(
				rawArgs as Record<string, unknown>,
				["drop"],
				{ drop: "string" },
			) as { drop?: string };
			const sessionId = deps.sessionId();

			if (!params.drop) {
				throw new Error(
					`Error: 'drop' must be provided as a string of tag numbers, for example {"drop": "3-5,8"}.`,
				);
			}

			let dropIds: number[] = [];
			try {
				dropIds = parseRangeString(params.drop);
			} catch (e) {
				throw new Error(`Error: Invalid range syntax. ${(e as Error).message}`);
			}

			const allIds = [...new Set(dropIds)];

			const allTags = getTagsBySession(deps.db, sessionId);
			const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
			const unknownIds = allIds.filter((id) => !foundSet.has(id));
			if (unknownIds.length > 0) {
				throw new Error(
					`Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`,
				);
			}

			const ctxReduceSelfStampIds = new Set(
				allTags
					.filter((tag) => tag.toolName?.toLowerCase() === "ctx_reduce")
					.map((tag) => tag.tagNumber),
			);
			const ctxReduceSelfStampCount = new Set(
				dropIds.filter((id) => ctxReduceSelfStampIds.has(id)),
			).size;
			dropIds = dropIds.filter((id) => !ctxReduceSelfStampIds.has(id));

			const tagStatusMap = new Map(
				allTags.map((tag) => [tag.tagNumber, tag.status]),
			);
			// Only membership of the requested tags is consulted below, so look
			// up just those instead of every inert tag in the session.
			const inertWhitespaceTagNumbers = new Set(
				getInertWhitespaceAssistantTagsByNumbers(
					deps.db,
					sessionId,
					dropIds,
				).map((tag) => tag.tagNumber),
			);
			const inertDropIds = [
				...new Set(dropIds.filter((id) => inertWhitespaceTagNumbers.has(id))),
			];
			const inertNote =
				inertDropIds.length > 0
					? `Skipped: ${inertDropIds
							.map((id) => `§${id}§ is provider framing, nothing to reclaim`)
							.join("; ")}.`
					: "";

			const pendingOps = getPendingOps(deps.db, sessionId);
			const pendingMap = new Map(
				pendingOps.map((op) => [op.tagId, op.operation]),
			);

			// Reject drops on compaction-survivor tags (parity with the Pi/OpenCode
			// guards): those tags are synthesized survivors and cannot be dropped.
			const conflicts: string[] = [];
			for (const id of dropIds) {
				if (
					tagStatusMap.get(id) === "compacted" &&
					!inertWhitespaceTagNumbers.has(id)
				) {
					conflicts.push(`§${id}§ is from before compaction`);
				}
			}
			if (conflicts.length > 0) {
				throw new Error(
					`Error: Conflicting operations — ${conflicts.join("; ")}.`,
				);
			}

			const stampedCount = new Set(
				dropIds.filter((id) => !inertWhitespaceTagNumbers.has(id)),
			).size;
			// Retry idempotence: already-dropped or already-queued tags are skipped,
			// and `queuePendingOp` itself is a single idempotent statement.
			dropIds = dropIds.filter(
				(id) =>
					!inertWhitespaceTagNumbers.has(id) &&
					tagStatusMap.get(id) !== "dropped" &&
					pendingMap.get(id) !== "drop",
			);

			if (dropIds.length === 0) {
				const reply = formatCtxReduceReply(
					stampedCount,
					ctxReduceSelfStampCount,
				);
				if (reply) return `${reply}${inertNote ? ` ${inertNote}` : ""}`;
				if (inertNote) return inertNote;
				return "No new action is needed.";
			}

			try {
				deps.db
					.transaction(() => {
						const now = Date.now();
						for (const id of dropIds) {
							queuePendingOp(deps.db, sessionId, id, "drop", now);
						}
					})
					.immediate();
			} catch (error) {
				throw new Error(
					`Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
				);
			}

			const currentInputTokens = getOrCreateSessionMeta(
				deps.db,
				sessionId,
			).lastInputTokens;
			updateSessionMeta(deps.db, sessionId, {
				lastNudgeTokens: currentInputTokens,
			});

			const reply = formatCtxReduceReply(stampedCount, ctxReduceSelfStampCount);
			return `${reply}${inertNote ? ` ${inertNote}` : ""}`;
		},
	});
}

function formatIds(ids: number[]): string {
	return ids.map((id) => `§${id}§`).join(", ");
}
