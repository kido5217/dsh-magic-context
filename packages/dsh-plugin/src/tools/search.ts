/**
 * DSH wrapper for the `ctx_search` tool (T030).
 *
 * Core `unifiedSearch()` is harness-agnostic: it runs the lexical (FTS5),
 * semantic, memory, note and git-commit lanes over the shared SQLite store.
 * This wrapper only translates DSH tool args into the search-options shape,
 * resolves the session id / project identity, and formats results with core
 * `formatSearchResults` — the same reply text OpenCode and Pi produce, so a
 * memory seeded by another harness on the same project comes back verbatim
 * (SC-003 cross-harness continuity).
 */
import {
	defineTool,
	type ParameterSchemaSpec,
	type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import type { RerankConfig } from "@magic-context/core/config/schema/magic-context";
import { getLastCompartmentEndMessage } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import {
	directoryHasGitMetadata,
	resolveProjectIdentityForSession,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	createUnifiedSearchDiagnostics,
	formatSearchResults,
	parseIdShapedQuery,
	resolveMemoriesByIdsForSearch,
	unifiedSearch,
} from "@magic-context/core/features/magic-context/search";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { CTX_SEARCH_DESCRIPTION } from "@magic-context/core/tools/ctx-search/constants";
import {
	parseSearchDateRange,
	SearchDateRangeError,
} from "@magic-context/core/tools/ctx-search/date-range";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import type { ToolSurface } from "./surface";
import {
	stringToolOutput,
	surfaceDescription,
	surfaceParameterDescriptions,
} from "./surface";

const DEFAULT_LIMIT = 10;
const SOURCE_VALUES = [
	"memory",
	"message",
	"git_commit",
	"primer",
	"note",
] as const;
type CtxSearchSource = (typeof SOURCE_VALUES)[number];

export interface CtxSearchToolDshDeps {
	db: ContextDatabase;
	sessionId: () => string;
	projectDir: string;
	memoryEnabled?: boolean;
	embeddingEnabled?: boolean;
	gitCommitsEnabled?: boolean;
	rerankConnectionFile?: string;
	rerankConfig?: RerankConfig;
	surface: ToolSurface;
}

export function createCtxSearchTool(
	deps: CtxSearchToolDshDeps,
): ToolDefinition {
	const parameters = {
		query: {
			type: "string",
			description:
				"A natural-language question carrying the exact terms you expect in the answer.",
		},
		limit: { type: "number", description: "Maximum results (default 10)." },
		from: {
			type: "string",
			description: "Earliest date, YYYY-MM-DD (inclusive).",
		},
		to: {
			type: "string",
			description: "Latest date, YYYY-MM-DD (inclusive; default open).",
		},
		sources: {
			type: "array",
			items: { type: "string", enum: SOURCE_VALUES },
			description:
				"Restrict to these sources; omitting it or passing [] searches every source.",
		},
	} satisfies ParameterSchemaSpec;
	surfaceParameterDescriptions("ctx_search", parameters, deps.surface);

	return defineTool({
		name: "ctx_search",
		description: surfaceDescription(
			"ctx_search",
			CTX_SEARCH_DESCRIPTION,
			deps.surface,
		),
		parameters,
		output: stringToolOutput(),
		async execute(rawArgs, exec) {
			const params = unwrapImitatedReducedArgs(
				rawArgs as Record<string, unknown>,
				["query"],
				{
					query: "string",
					limit: "number",
					from: "string",
					to: "string",
					sources: {
						type: "array",
						items: "string",
						values: SOURCE_VALUES,
					},
				},
			) as {
				query?: string;
				limit?: number;
				from?: string;
				to?: string;
				sources?: CtxSearchSource[];
			};
			const query = params.query?.trim();
			if (!query) {
				throw new Error("Error: 'query' is required.");
			}
			let dateRange: ReturnType<typeof parseSearchDateRange>;
			try {
				dateRange = parseSearchDateRange(params.from, params.to);
			} catch (error) {
				if (!(error instanceof SearchDateRangeError)) throw error;
				throw new Error(`Error: ${error.message}`);
			}

			const sessionId = deps.sessionId();
			const projectIdentity = resolveProjectIdentityForSession(deps.projectDir);
			if (!projectIdentity) {
				throw new Error(
					"Error: Could not resolve project identity for search.",
				);
			}
			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			const memoryEnabled =
				snapshot?.features.memoryEnabled ?? deps.memoryEnabled;
			// Query embedding follows the provider alone; each lane applies its
			// own feature gate, and history search ignores `memory.enabled`.
			const embeddingEnabled = snapshot
				? snapshot.historyEnabled
				: deps.embeddingEnabled;
			const gitCommitsEnabled =
				snapshot?.gitCommitEnabled ?? deps.gitCommitsEnabled ?? false;

			// Only search message history up to the last compartment boundary —
			// anything after that (the live tail) is still in context. With no
			// compartment yet the boundary is 0: every 1-based indexed ordinal is
			// live-tail and must be excluded (issue #131 parity).
			const lastCompartmentEnd = getLastCompartmentEndMessage(
				deps.db,
				sessionId,
			);
			const messageOrdinalCutoff =
				lastCompartmentEnd >= 0 ? lastCompartmentEnd : 0;

			// Hard-filter memories already rendered in <session-history>.
			const visibleMemoryIds = getVisibleMemoryIds(deps.db, sessionId);
			const diagnostics = createUnifiedSearchDiagnostics();

			// ID-shaped short-circuit (parity with OpenCode/Pi): when the whole
			// query is memory ids, look them up directly; fall through to the
			// text lanes when nothing resolves.
			const idShape = parseIdShapedQuery(query);
			if (idShape && memoryEnabled) {
				const idResults = resolveMemoriesByIdsForSearch({
					db: deps.db,
					projectPath: projectIdentity,
					ids: idShape,
					limit: Math.max(normalizeLimit(params.limit), idShape.length),
					visibleMemoryIds,
					diagnostics,
					...dateRange,
				});
				if (
					idResults !== null ||
					diagnostics.suppressedVisibleMemoryIds.length > 0
				) {
					return formatSearchResults(
						query,
						idResults ?? [],
						sessionId,
						diagnostics,
					);
				}
			}

			let rerankSkipped = "";
			const results = await unifiedSearch(
				deps.db,
				sessionId,
				projectIdentity,
				query,
				{
					limit: normalizeLimit(params.limit),
					memoryEnabled,
					embeddingEnabled,
					embedQuery: async (text, signal) => {
						const result = await embedTextForProject(
							projectIdentity,
							text,
							signal,
							"query",
						);
						return result?.vector ?? null;
					},
					isEmbeddingRuntimeEnabled: () => embeddingEnabled === true,
					maxMessageOrdinal: messageOrdinalCutoff,
					gitCommitsEnabled,
					sources:
						params.sources && params.sources.length > 0
							? params.sources
							: undefined,
					visibleMemoryIds,
					diagnostics,
					gitRepositoryAvailable: directoryHasGitMetadata(deps.projectDir),
					// Explicit agent search → literal-probe multi-query recall
					// (parity with OpenCode's ctx_search).
					explicitSearch: true,
					rerankConnectionFile: deps.rerankConnectionFile,
					rerankConfig: deps.rerankConfig,
					signal: exec.signal,
					onRerankSkipped: (line) => {
						rerankSkipped = line;
					},
					...dateRange,
				},
			);

			return (
				formatSearchResults(query, results, sessionId, diagnostics) +
				(rerankSkipped ? `\n${rerankSkipped}` : "")
			);
		},
	});
}

function normalizeLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit === 0) {
		return DEFAULT_LIMIT;
	}
	return Math.max(1, Math.floor(limit));
}
