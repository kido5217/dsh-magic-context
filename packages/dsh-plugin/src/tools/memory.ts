/**
 * DSH wrapper for the `ctx_memory` tool (T029).
 *
 * Primary action surface mirrors the Pi/OpenCode wrappers (dreamer-only
 * actions and `ctx_memory_list` are not registered on DSH):
 *   - write: insert a new memory (dedup on normalized hash bumps seenCount)
 *   - get:   fetch up to 20 memories by id
 *   - update: rewrite one memory's content (re-hashes, re-queues embedding)
 *   - merge: consolidate N memories into a canonical one, supersede the rest
 *   - archive: soft-delete a memory (status = 'archived'), optional reason
 *
 * Memories are PROJECT-scoped via `resolveProjectIdentityForSession(projectDir)`
 * in the shared cortexkit DB — the same write path other harnesses use, so a
 * memory written from DSH is visible to OpenCode/Pi on the same project and
 * vice versa (SC-003). Single workspace identity here: visibility and
 * ownership both collapse to `storedPathBelongsToIdentity`.
 */
import {
	defineTool,
	type ParameterSchemaSpec,
	type ToolDefinition,
} from "@deepseek-ai/dsh-tools";
import {
	archiveMemory,
	getMemoriesByIds,
	getMemoryByHash,
	getMemoryById,
	hasMemoryClassifiedAtColumn,
	hasMemoryShareableColumn,
	insertMemory,
	type Memory,
	type MemoryCategory,
	mergeMemoryStats,
	saveEmbedding,
	supersededMemory,
	updateMemorySeenCount,
	V2_MEMORY_CATEGORIES,
} from "@magic-context/core/features/magic-context/memory";
import {
	embedTextForProject,
	getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { invalidateMemory } from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { computeNormalizedHash } from "@magic-context/core/features/magic-context/memory/normalize-hash";
import {
	normalizeStoredProjectPath,
	resolveProjectIdentityForSession,
	storedPathBelongsToIdentity,
} from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	queueMemoryMutation,
} from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";
import { CTX_MEMORY_DESCRIPTION } from "@magic-context/core/tools/ctx-memory/constants";
import { runImmediateTransaction } from "@magic-context/core/tools/ctx-memory/verification-recording";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import type { ToolSurface } from "./surface";
import {
	stringToolOutput,
	surfaceDescription,
	surfaceParameterDescriptions,
} from "./surface";

const PRIMARY_ACTIONS = ["write", "update", "archive", "merge", "get"] as const;
const GET_MAX_IDS = 20;

export interface CtxMemoryToolDshDeps {
	db: ContextDatabase;
	sessionId: () => string;
	projectDir: string;
	/** Used only when the project has no embedding registration (no snapshot). */
	memoryEnabled?: boolean;
	surface: ToolSurface;
}

export function createCtxMemoryTool(
	deps: CtxMemoryToolDshDeps,
): ToolDefinition {
	const parameters = {
		action: {
			type: "string",
			enum: PRIMARY_ACTIONS,
			required: true,
			description: "write | update | archive | merge | get.",
		},
		content: {
			type: "string",
			description:
				"Memory text (write/update/merge). First line becomes the title.",
		},
		category: {
			type: "string",
			enum: V2_MEMORY_CATEGORIES,
			description:
				"PROJECT_RULES | ARCHITECTURE | CONSTRAINTS | CONFIG_VALUES | NAMING (write/merge; update inherits the existing category).",
		},
		ids: {
			type: "array",
			items: { type: "number" },
			description: "Memory IDs for archive/get/update/merge.",
		},
		reason: {
			type: "string",
			description:
				"For archive: one short sentence stating what replacement or new understanding makes this memory obsolete.",
		},
	} satisfies ParameterSchemaSpec;
	surfaceParameterDescriptions("ctx_memory", parameters, deps.surface);

	return defineTool({
		name: "ctx_memory",
		description: surfaceDescription(
			"ctx_memory",
			CTX_MEMORY_DESCRIPTION,
			deps.surface,
		),
		parameters,
		output: stringToolOutput(),
		async execute(rawArgs) {
			const params = unwrapImitatedReducedArgs(
				rawArgs as Record<string, unknown>,
				["action"],
				{
					action: { type: "enum", values: PRIMARY_ACTIONS },
					content: "string",
					category: { type: "enum", values: V2_MEMORY_CATEGORIES },
					ids: { type: "array", items: "number" },
					reason: "string",
				},
			) as {
				action: (typeof PRIMARY_ACTIONS)[number];
				content?: string;
				category?: MemoryCategory;
				ids?: number[];
				reason?: string;
			};

			const projectIdentity = resolveProjectIdentityForSession(deps.projectDir);
			if (!projectIdentity) {
				throw new Error(
					"Error: Could not resolve project identity for memory action.",
				);
			}

			const snapshot = getProjectEmbeddingSnapshot(projectIdentity);
			if (
				snapshot
					? !snapshot.features.memoryEnabled
					: deps.memoryEnabled === false
			) {
				throw new Error(
					snapshot?.memoryDisabledReason ??
						"Cross-session memory is disabled for this project.",
				);
			}
			const sessionId = deps.sessionId();

			// Single identity on this lane: read visibility and write ownership
			// both reduce to the project-identity check.
			const memoryOwnedByTool = (memory: Memory): boolean =>
				storedPathBelongsToIdentity(memory.projectPath, projectIdentity);
			const targetIdentityForStoredPath = (rawProjectPath: string): string =>
				normalizeStoredProjectPath(rawProjectPath);

			if (params.action === "write") {
				const content = params.content?.trim();
				if (!content) {
					throw new Error(
						"Error: 'content' is required when action is 'write'.",
					);
				}
				const rawCategory = params.category;
				if (!rawCategory) {
					throw new Error(
						"Error: 'category' is required when action is 'write'.",
					);
				}

				const existing = getMemoryByHash(
					deps.db,
					projectIdentity,
					rawCategory,
					computeNormalizedHash(content),
				);
				if (existing) {
					updateMemorySeenCount(deps.db, existing.id);
					return `Memory already exists [ID: ${existing.id}] in ${rawCategory} (seen count incremented).`;
				}

				const memory = insertMemory(deps.db, {
					projectPath: projectIdentity,
					category: rawCategory,
					content,
					sourceSessionId: sessionId,
					sourceType: "agent",
				});

				queueEmbedding({ deps, projectIdentity, memoryId: memory.id, content });
				// No m[0]/m[1] cache invalidation: an additive write surfaces via
				// the maxMemoryId watermark (matches OpenCode's write path).
				return `Saved memory [ID: ${memory.id}] in ${rawCategory}.`;
			}

			if (params.action === "get") {
				const getIds = params.ids;
				if (!getIds || getIds.length === 0 || !getIds.every(Number.isInteger)) {
					throw new Error(
						"Error: 'ids' must contain at least one integer memory ID when action is 'get'.",
					);
				}
				if (getIds.length > GET_MAX_IDS) {
					throw new Error(
						`Error: 'ids' must contain at most ${GET_MAX_IDS} memory IDs when action is 'get' (got ${getIds.length}).`,
					);
				}
				// De-dupe preserving first-seen order so each requested id appears once.
				const uniqueIds = [...new Set(getIds)];
				const fetched = getMemoriesByIds(deps.db, uniqueIds);
				const memoriesById = new Map<number, Memory>(
					fetched
						.filter((memory) => memoryOwnedByTool(memory))
						.map((memory) => [memory.id, memory]),
				);
				return formatGetOutput({ requestedIds: uniqueIds, memoriesById });
			}

			if (params.action === "update") {
				const updateIds = params.ids;
				if (updateIds?.length !== 1 || !updateIds.every(Number.isInteger)) {
					throw new Error(
						"Error: 'ids' must contain exactly one integer memory ID when action is 'update'.",
					);
				}
				const updateId = updateIds[0];
				const content = params.content?.trim();
				if (!content) {
					throw new Error(
						"Error: 'content' is required when action is 'update'.",
					);
				}

				const memory = getMemoryById(deps.db, updateId);
				if (!memory || !memoryOwnedByTool(memory)) {
					throw new Error(`Error: Memory with ID ${updateId} was not found.`);
				}
				if (!isPrimaryMutableMemory(memory)) {
					throw new Error(inactiveMemoryError(updateId, "updating"));
				}

				const normalizedHash = computeNormalizedHash(content);
				const targetCategory = params.category ?? memory.category;
				const targetIdentity = targetIdentityForStoredPath(memory.projectPath);
				const duplicate = getMemoryByHash(
					deps.db,
					targetIdentity,
					targetCategory,
					normalizedHash,
				);
				if (duplicate && duplicate.id !== memory.id) {
					throw new Error(
						`Error: Memory content already exists as ID ${duplicate.id}; merge or archive duplicates instead.`,
					);
				}

				runImmediateTransaction(deps.db, () => {
					updateMemoryContentInCurrentTransaction(
						deps.db,
						memory,
						content,
						normalizedHash,
						targetCategory,
					);
					queueMemoryMutation(deps.db, {
						projectPath: targetIdentity,
						mutationType: "update",
						targetMemoryId: memory.id,
						category: targetCategory,
						newContent: content,
					});
				});
				queueEmbedding({
					deps,
					projectIdentity: targetIdentity,
					memoryId: memory.id,
					content,
				});
				return `Updated memory [ID: ${memory.id}] in ${targetCategory}.`;
			}

			if (params.action === "merge") {
				const ids = params.ids;
				if (!ids || ids.length < 2 || !ids.every(Number.isInteger)) {
					throw new Error(
						"Error: 'ids' must include at least two integer memory IDs when action is 'merge'.",
					);
				}
				if (new Set(ids).size !== ids.length) {
					throw new Error(
						"Error: 'ids' must include at least two distinct memory IDs when action is 'merge'.",
					);
				}
				const content = params.content?.trim();
				if (!content) {
					throw new Error(
						"Error: 'content' is required when action is 'merge'.",
					);
				}

				const sourceMemories = ids
					.map((id) => getMemoryById(deps.db, id))
					.filter((memory): memory is Memory => Boolean(memory));
				if (sourceMemories.length !== ids.length) {
					throw new Error("Error: One or more source memories were not found.");
				}
				// Primary lane: no cross-project consolidation.
				const foreign = sourceMemories.find(
					(memory) => !memoryOwnedByTool(memory),
				);
				if (foreign) {
					throw new Error(`Error: Memory with ID ${foreign.id} was not found.`);
				}
				const inactive = sourceMemories.find(
					(memory) => !isPrimaryMutableMemory(memory),
				);
				if (inactive) {
					throw new Error(inactiveMemoryError(inactive.id, "merging"));
				}
				// A fact has exactly one category; cross-category "duplicates" are
				// miscategorized, not merged (structural guard, parity with Pi).
				const sourceCategories = new Set(
					sourceMemories.map((memory) => memory.category),
				);
				if (sourceCategories.size > 1) {
					throw new Error(
						`Error: Cannot merge memories from different categories (${[...sourceCategories].join(", ")}). If they are genuine duplicates, one is miscategorized — archive the redundant one instead of merging across categories.`,
					);
				}
				const category: MemoryCategory | undefined =
					params.category ?? sourceMemories[0]?.category;
				if (!category) {
					throw new Error(
						"Error: A valid category is required when action is 'merge'.",
					);
				}

				const normalizedHash = computeNormalizedHash(content);
				const duplicate = getMemoryByHash(
					deps.db,
					projectIdentity,
					category,
					normalizedHash,
				);
				const canonicalExisting =
					duplicate && ids.includes(duplicate.id) ? duplicate : null;
				if (duplicate && !canonicalExisting) {
					throw new Error(
						`Error: Memory content already exists as ID ${duplicate.id}; update or archive existing duplicates instead.`,
					);
				}

				const mergedSeenCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.seenCount,
					0,
				);
				const mergedRetrievalCount = sourceMemories.reduce(
					(sum, memory) => sum + memory.retrievalCount,
					0,
				);
				// Flatten prior merge chains so lineage stays accurate; stored as
				// a plain JSON id array (core `merged_from` format).
				const mergedFromIds = Array.from(
					new Set(
						sourceMemories.flatMap((memory) => {
							let parsed: unknown[] = [];
							try {
								parsed = memory.mergedFrom ? JSON.parse(memory.mergedFrom) : [];
							} catch {
								parsed = [];
							}
							const priorIds = Array.isArray(parsed)
								? parsed.filter(
										(value): value is number => typeof value === "number",
									)
								: [];
							return [memory.id, ...priorIds];
						}),
					),
				).sort((left, right) => left - right);
				const mergedFrom = JSON.stringify(mergedFromIds);
				const mergedStatus: "active" | "permanent" = sourceMemories.some(
					(memory) => memory.status === "permanent",
				)
					? "permanent"
					: "active";

				let canonicalMemory!: Memory;
				deps.db
					.transaction(() => {
						let canonicalContentChanged = false;
						if (canonicalExisting) {
							canonicalMemory = canonicalExisting;
							canonicalContentChanged =
								canonicalMemory.content !== content ||
								canonicalMemory.normalizedHash !== normalizedHash;
							if (canonicalContentChanged) {
								updateMemoryContentInCurrentTransaction(
									deps.db,
									canonicalMemory,
									content,
									normalizedHash,
									category,
								);
							}
						} else {
							canonicalMemory = insertMemory(deps.db, {
								projectPath: projectIdentity,
								category,
								content,
								sourceSessionId: sessionId,
								sourceType: "agent",
							});
						}

						mergeMemoryStats(
							deps.db,
							canonicalMemory.id,
							mergedSeenCount,
							mergedRetrievalCount,
							mergedFrom,
							mergedStatus,
						);

						for (const memory of sourceMemories) {
							if (memory.id === canonicalMemory.id) {
								continue;
							}
							supersededMemory(deps.db, memory.id, canonicalMemory.id);
							queueMemoryMutation(deps.db, {
								// Normalize the stored path before queueing — the
								// mutation-log reader matches exact project_path.
								projectPath: normalizeStoredProjectPath(memory.projectPath),
								mutationType: "superseded",
								targetMemoryId: memory.id,
								supersededById: canonicalMemory.id,
							});
						}

						if (canonicalExisting && canonicalContentChanged) {
							queueMemoryMutation(deps.db, {
								projectPath: normalizeStoredProjectPath(
									canonicalMemory.projectPath,
								),
								mutationType: "update",
								targetMemoryId: canonicalMemory.id,
								category,
								newContent: content,
							});
						}
					})
					.immediate();

				queueEmbedding({
					deps,
					projectIdentity,
					memoryId: canonicalMemory.id,
					content,
				});
				const supersededIds = sourceMemories
					.map((memory) => memory.id)
					.filter((id) => id !== canonicalMemory.id);
				return `Merged memories [${ids.join(", ")}] into canonical memory [ID: ${canonicalMemory.id}] in ${category}; superseded [${supersededIds.join(", ")}].`;
			}

			if (params.action === "archive") {
				const rawArchiveIds = params.ids;
				if (
					!rawArchiveIds ||
					rawArchiveIds.length === 0 ||
					!rawArchiveIds.every(Number.isInteger)
				) {
					throw new Error(
						"Error: 'ids' must contain at least one integer memory ID when action is 'archive'.",
					);
				}
				// De-dupe (first-seen order): `ids:[42,42]` archives once.
				const archiveIds = [...new Set(rawArchiveIds)];
				// Validate the whole batch BEFORE mutating so a typo'd id can't
				// half-archive a batch (all-or-nothing, matching the transaction).
				for (const memoryId of archiveIds) {
					const memory = getMemoryById(deps.db, memoryId);
					if (!memory || !memoryOwnedByTool(memory)) {
						throw new Error(`Error: Memory with ID ${memoryId} was not found.`);
					}
					if (!isPrimaryMutableMemory(memory)) {
						throw new Error(inactiveMemoryError(memoryId, "archiving"));
					}
				}
				const targets = archiveIds.map((memoryId) => {
					const memory = getMemoryById(deps.db, memoryId);
					if (!memory)
						throw new Error(`validated memory ${memoryId} disappeared`);
					return {
						memoryId,
						projectIdentity: targetIdentityForStoredPath(memory.projectPath),
					};
				});
				runImmediateTransaction(deps.db, () => {
					for (const target of targets) {
						archiveMemory(deps.db, target.memoryId, params.reason);
						queueMemoryMutation(deps.db, {
							projectPath: target.projectIdentity,
							mutationType: "archive",
							targetMemoryId: target.memoryId,
						});
					}
				});
				const reasonSuffix = params.reason ? ` (${params.reason})` : "";
				const idList = archiveIds.join(", ");
				const plural = archiveIds.length > 1 ? "memories" : "memory";
				return `Archived ${plural} [ID: ${idList}]${reasonSuffix}.`;
			}

			throw new Error("Error: Unknown action.");
		},
	});
}

function queueEmbedding(args: {
	deps: CtxMemoryToolDshDeps;
	projectIdentity: string;
	memoryId: number;
	content: string;
}): void {
	const snapshot = getProjectEmbeddingSnapshot(args.projectIdentity);
	if (!snapshot?.enabled) return;
	void (async () => {
		try {
			const result = await embedTextForProject(
				args.projectIdentity,
				args.content,
			);
			if (!result) {
				log(
					`[magic-context-dsh] embedding skipped for memory ${args.memoryId}: provider unavailable.`,
				);
				return;
			}
			saveEmbedding(args.deps.db, args.memoryId, result.vector, result.modelId);
		} catch (error) {
			log(
				`[magic-context-dsh] embedding failed for memory ${args.memoryId}:`,
				error,
			);
		}
	})();
}

function isPrimaryMutableMemory(memory: Memory): boolean {
	return (
		(memory.status === "active" || memory.status === "permanent") &&
		memory.supersededByMemoryId === null
	);
}

function inactiveMemoryError(
	id: number,
	action: "updating" | "merging" | "archiving",
): string {
	return `Error: Memory with ID ${id} is archived or superseded; restore it before ${action}.`;
}

// Shared not-found wording for hidden and missing ids (no existence oracle).
const getNotVisibleMessage = (id: number): string =>
	`id ${id}: not found or not visible from this project`;

function formatGetOutput(args: {
	requestedIds: number[];
	memoriesById: Map<number, Memory>;
}): string {
	const parts: string[] = [];
	for (const id of args.requestedIds) {
		const memory = args.memoriesById.get(id);
		if (!memory) {
			parts.push(getNotVisibleMessage(id));
		} else {
			parts.push(formatMemoryList([memory]));
		}
	}
	return parts.join("\n\n");
}

/** Mirrors the Pi wrapper's in-transaction content rewrite (re-classify, drop stale embedding). */
function updateMemoryContentInCurrentTransaction(
	db: ContextDatabase,
	memory: Memory,
	content: string,
	normalizedHash: string,
	category: MemoryCategory,
): void {
	db.prepare(
		"UPDATE memories SET content = ?, normalized_hash = ?, category = ?, updated_at = ? WHERE id = ?",
	).run(content, normalizedHash, category, Date.now(), memory.id);
	// The classify `shareable` verdict was scored against the OLD content;
	// new content invalidates it. Fail closed → private.
	if (hasMemoryShareableColumn(db)) {
		db.prepare("UPDATE memories SET shareable = 0 WHERE id = ?").run(memory.id);
	}
	if (hasMemoryClassifiedAtColumn(db)) {
		db.prepare("UPDATE memories SET classified_at = NULL WHERE id = ?").run(
			memory.id,
		);
	}
	db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(
		memory.id,
	);
	invalidateMemory(memory.projectPath, memory.id);
}

function formatMemoryList(memories: Memory[]): string {
	if (memories.length === 0) return "No active memories found.";

	const rows = memories.map((m) => ({
		id: String(m.id),
		category: m.category,
		status: m.status,
		verification: m.verificationStatus,
		updated: new Date(m.updatedAt).toISOString(),
		content: m.content.replace(/\s+/g, " ").trim(),
	}));
	const headers = {
		id: "ID",
		category: "CATEGORY",
		status: "STATUS",
		verification: "VERIFY",
		updated: "UPDATED",
		content: "CONTENT",
	};
	const widths = {
		id: Math.max(headers.id.length, ...rows.map((r) => r.id.length)),
		category: Math.max(
			headers.category.length,
			...rows.map((r) => r.category.length),
		),
		status: Math.max(
			headers.status.length,
			...rows.map((r) => r.status.length),
		),
		verification: Math.max(
			headers.verification.length,
			...rows.map((r) => r.verification.length),
		),
		updated: Math.max(
			headers.updated.length,
			...rows.map((r) => r.updated.length),
		),
	};
	const fmt = (r: (typeof rows)[number] | typeof headers) =>
		[
			r.id.padEnd(widths.id),
			r.category.padEnd(widths.category),
			r.status.padEnd(widths.status),
			r.verification.padEnd(widths.verification),
			r.updated.padEnd(widths.updated),
			r.content,
		].join(" | ");
	// `get` returns rows of any status; claim "active" only when every row is.
	const allActive = memories.every((memory) => memory.status === "active");
	return [
		`Found ${rows.length} ${allActive ? "active " : ""}${rows.length === 1 ? "memory" : "memories"}:`,
		"",
		fmt(headers),
		[
			"-".repeat(widths.id),
			"-".repeat(widths.category),
			"-".repeat(widths.status),
			"-".repeat(widths.verification),
			"-".repeat(widths.updated),
			"-------",
		].join("-+-"),
		...rows.map(fmt),
	].join("\n");
}
