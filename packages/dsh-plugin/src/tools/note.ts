/**
 * DSH wrapper for the `ctx_note` tool (T028).
 *
 * Action surface mirrors the Pi wrapper (`pi-plugin/src/tools/ctx-note.ts`)
 * and OpenCode's `packages/plugin/src/tools/ctx-note/tools.ts`:
 *   - write: append a session note OR a smart note (when surface_condition is set)
 *   - read: glance of active session notes + smart notes; `filter` for other
 *     statuses; `note_ids` (1–50) for full bodies; limit/offset paging
 *   - dismiss: retire 1–50 notes by id
 *   - update: rewrite one note's content and/or surface_condition
 *
 * Notes are core storage: session notes are scoped to the session (harness
 * column stamped by core from `setHarness("dsh")`), smart notes to the project
 * — visible to every harness on the shared store (SC-003). Smart-note writes
 * are rejected unless the dreamer can evaluate them: a silently parked note
 * could never surface.
 */
import {
	defineTool,
	type ParameterSchemaSpec,
	type ToolDefinition,
	type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { getLastIndexedOrdinal } from "@magic-context/core/features/magic-context/message-index";
import {
	compileSurfaceCondition,
	conditionCompileReplySuffix,
	conditionCompileStorageFields,
} from "@magic-context/core/features/magic-context/smart-notes/condition-compiler";
import { wakePlaneStatus } from "@magic-context/core/features/magic-context/smart-notes/wake-plane";
import type {
	ContextDatabase,
	UpdateNoteOptions,
} from "@magic-context/core/features/magic-context/storage";
import {
	addNote,
	dismissNote,
	dismissNotes,
	getNoteByIdInScope,
	getNotes,
	getPendingSmartNotes,
	getReadySmartNotes,
	getSessionNotes,
	type Note,
	type NoteMutationScope,
	type NoteStatus,
	setNoteLastReadAt,
	updateNote,
} from "@magic-context/core/features/magic-context/storage";
import {
	CTX_NOTE_DESCRIPTION,
	NOTES_FILTER_DESCRIPTION,
	SMART_NOTES_DISABLED_REPLY,
} from "@magic-context/core/tools/ctx-note/constants";
import {
	EMPTY_READ_REPLY,
	formatWriteReply,
	noteTouchedAt,
	renderGlance,
	renderNotesById,
} from "@magic-context/core/tools/ctx-note/render";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import type { ToolSurface } from "./surface";
import {
	stringToolOutput,
	surfaceDescription,
	surfaceParameterDescriptions,
} from "./surface";

const FILTER_VALUES = [
	"active",
	"pending",
	"ready",
	"dismissed",
	"all",
] as const;
type CtxNoteReadFilter = (typeof FILTER_VALUES)[number];

/** Default page size for read (matches the OpenCode/Pi ctx-note glance). */
const DEFAULT_READ_LIMIT = 25;

const DISMISS_FOOTER =
	'\n\nTo dismiss a stale note: ctx_note(action="dismiss", note_ids=[N])';

export interface CtxNoteToolDshDeps {
	db: ContextDatabase;
	sessionId: (exec?: ToolRunContext) => string;
	/** Registration-time project directory; identity resolves per call. */
	projectDir: string;
	smartNotesEnabled?: boolean;
	/** When true, smart notes are accepted and the dreamer will evaluate them. */
	dreamerEnabled?: boolean;
	surface: ToolSurface;
}

export function createCtxNoteTool(deps: CtxNoteToolDshDeps): ToolDefinition {
	const resolveProject = (): string | undefined =>
		resolveProjectIdentityForSession(deps.projectDir);
	// The dreamer evaluates smart-note conditions, so a disabled dreamer hides
	// the smart-note argument and text exactly as smart_notes.enabled=false does.
	const smartNoteSurface =
		deps.smartNotesEnabled !== false && deps.dreamerEnabled !== false;

	const parameters: ParameterSchemaSpec = {
		action: {
			type: "string",
			enum: ["write", "read", "dismiss", "update"],
			required: true,
			description: "write | read | update | dismiss.",
		},
		content: {
			type: "string",
			description:
				"Note text for write/update: first line is the title (under 80 chars), then the detail.",
		},
		note_ids: {
			type: "array",
			items: { type: "integer" },
			description:
				"Note ids: one for update, 1–50 for dismiss, or 1–50 to read those notes in full. Write and a plain read take an empty list.",
		},
		filter: {
			type: "string",
			enum: FILTER_VALUES,
			description:
				"Read filter: all, active, pending (unsurfaced smart notes), ready, dismissed. Omitted, it shows active session notes plus every current smart note (pending included); active shows only notes whose stored status is active.",
		},
		limit: { type: "integer", description: "Rows per read (default 25)." },
		offset: {
			type: "integer",
			description: "Skip this many newest rows (default 0).",
		},
	};
	if (smartNoteSurface) {
		parameters.surface_condition = {
			type: "string",
			description:
				"Makes this a smart note: a condition an outside checker can verify on its own, periodically — repository state, releases, web pages, anything it can look up — never something only this conversation knows. The note is parked until the condition holds.",
		};
	} else {
		// Pi parity: without the dreamer lane the parameter disappears and the
		// filter loses its smart-note wording.
		parameters.filter.description = NOTES_FILTER_DESCRIPTION;
	}
	surfaceParameterDescriptions("ctx_note", parameters, deps.surface);

	return defineTool({
		name: "ctx_note",
		description: surfaceDescription(
			"ctx_note",
			CTX_NOTE_DESCRIPTION,
			deps.surface,
		),
		parameters,
		output: stringToolOutput(),
		async execute(rawArgs, exec) {
			const params = unwrapImitatedReducedArgs(
				rawArgs as Record<string, unknown>,
				["action", "content"],
				{
					action: {
						type: "enum",
						values: ["write", "read", "dismiss", "update"],
					},
					content: "string",
					note_ids: { type: "array", items: "number" },
					filter: { type: "enum", values: FILTER_VALUES },
					limit: "number",
					offset: "number",
					...(smartNoteSurface ? { surface_condition: "string" } : {}),
				},
			) as {
				action?: "write" | "read" | "dismiss" | "update";
				content?: string;
				surface_condition?: string;
				note_ids?: number[];
				filter?: CtxNoteReadFilter;
				limit?: number;
				offset?: number;
			};
			if (
				deps.smartNotesEnabled === false &&
				params.surface_condition !== undefined
			) {
				throw new Error(SMART_NOTES_DISABLED_REPLY);
			}
			const sessionId = deps.sessionId(exec);
			const dreamerEnabled = deps.dreamerEnabled;
			// Infer write only on NON-EMPTY content: required-field providers
			// fill every optional param, so a bare typeof check mis-infers write.
			const action =
				params.action ?? (params.content?.trim() ? "write" : "read");
			// An empty list on read is the plain listing read, not a targeted one.
			const targetedReadIds =
				action === "read" &&
				Array.isArray(params.note_ids) &&
				params.note_ids.length === 0
					? undefined
					: params.note_ids;
			const noteIds =
				action === "dismiss" ||
				action === "update" ||
				(action === "read" && targetedReadIds !== undefined)
					? parseNoteIds(action, targetedReadIds)
					: undefined;
			if (typeof noteIds === "string") throw new Error(noteIds);

			if (action === "write") {
				const content = params.content?.trim();
				if (!content) {
					throw new Error(
						"Error: 'content' is required when action is 'write'.",
					);
				}
				// Anchor the note to the live conversation tail so it can be
				// traced back later via ctx_expand. Best-effort.
				const anchorOrdinal = captureAnchorOrdinal(deps.db, sessionId);

				const surfaceCondition = params.surface_condition?.trim();
				if (surfaceCondition) {
					if ((await wakePlaneStatus()) === "present") {
						const note = addNote(deps.db, "session", {
							sessionId,
							content,
							anchorOrdinal,
						});
						return `${formatWriteReply(note.id, writeTray(deps.db, sessionId), Date.now())}\nwake plane active — create a scheduled wake instead; stored as a plain note.`;
					}
					if (dreamerEnabled !== true) {
						throw new Error(
							"Error: Smart notes require dreamer to be enabled. Enable dreamer in magic-context.jsonc to use surface_condition.",
						);
					}
					const projectIdentity = resolveProject();
					if (!projectIdentity) {
						throw new Error(
							"Error: Could not resolve project identity for smart note.",
						);
					}
					const compilation = await compileSurfaceCondition(surfaceCondition, {
						projectPath: deps.projectDir,
					});
					const note = addNote(deps.db, "smart", {
						content,
						sessionId,
						projectPath: projectIdentity,
						surfaceCondition,
						anchorOrdinal,
						...conditionCompileStorageFields(compilation),
					});
					return `Created smart note #${note.id}. Dreamer will evaluate the condition during nightly runs:\n- Content: ${content}\n- Condition: ${surfaceCondition}${conditionCompileReplySuffix(compilation)}`;
				}

				const note = addNote(deps.db, "session", {
					sessionId,
					content,
					anchorOrdinal,
				});
				return formatWriteReply(
					note.id,
					writeTray(deps.db, sessionId),
					Date.now(),
				);
			}

			if (action === "dismiss") {
				const projectIdentity = resolveProject();
				if (!projectIdentity) {
					throw new Error(
						"Error: Could not resolve project identity for note dismiss.",
					);
				}
				const ids = noteIds as number[];
				const scope: NoteMutationScope = {
					projectPath: projectIdentity,
					sessionId,
				};
				if (ids.length > 1) {
					return formatDismissResults(dismissNotes(deps.db, ids, scope));
				}
				const dismissed = dismissNote(deps.db, ids[0], scope);
				if (!dismissed) {
					throw new Error(
						`Error: Note #${ids[0]} not found in your session/project or already dismissed.`,
					);
				}
				return `Note #${ids[0]} dismissed.`;
			}

			if (action === "update") {
				const noteId = (noteIds as number[])[0];
				const updates: UpdateNoteOptions = {};
				if (params.content?.trim()) updates.content = params.content.trim();
				let compilation:
					| Awaited<ReturnType<typeof compileSurfaceCondition>>
					| undefined;
				if (params.surface_condition?.trim()) {
					const project = resolveProject();
					const existing = project
						? getNoteByIdInScope(deps.db, noteId, {
								projectPath: project,
								sessionId,
							})
						: null;
					if (existing?.type === "session") {
						throw new Error(
							"Error: Only a note created with a condition can have one. Write a new note with surface_condition, and dismiss this one.",
						);
					}
					const surfaceCondition = params.surface_condition.trim();
					updates.surfaceCondition = surfaceCondition;
					compilation = await compileSurfaceCondition(surfaceCondition, {
						projectPath: deps.projectDir,
					});
					Object.assign(updates, conditionCompileStorageFields(compilation));
				}
				if (!updates.content && !updates.surfaceCondition) {
					throw new Error(
						"Error: Provide 'content' and/or 'surface_condition' to update.",
					);
				}
				const projectIdentity = resolveProject();
				if (!projectIdentity) {
					throw new Error(
						"Error: Could not resolve project identity for note update.",
					);
				}
				const updated = updateNote(deps.db, noteId, updates, {
					projectPath: projectIdentity,
					sessionId,
				});
				if (!updated) {
					throw new Error(
						`Error: Note #${noteId} not found in your session/project.`,
					);
				}
				const parts: string[] = [];
				if (updates.content) parts.push(`content: ${updates.content}`);
				if (updates.surfaceCondition)
					parts.push(`condition: ${updates.surfaceCondition}`);
				return `Updated note #${noteId}\n- ${parts.join("\n- ")}${compilation ? conditionCompileReplySuffix(compilation) : ""}`;
			}

			// read — `undefined` filter is the default mixed view marker (OpenCode
			// parity): active session notes + every smart note, parked included.
			const limit =
				typeof params.limit === "number" && params.limit > 0
					? Math.floor(params.limit)
					: DEFAULT_READ_LIMIT;
			const offset =
				typeof params.offset === "number" && params.offset > 0
					? Math.floor(params.offset)
					: 0;
			const projectIdentity = Array.isArray(noteIds)
				? resolveProject()
				: undefined;
			if (Array.isArray(noteIds) && !projectIdentity) {
				throw new Error(
					"Error: Could not resolve project identity for note read.",
				);
			}
			const nowMs = Date.now();
			const body = Array.isArray(noteIds)
				? renderNotesById(
						noteIds.map((noteId) => ({
							noteId,
							note: getNoteByIdInScope(deps.db, noteId, {
								projectPath: projectIdentity as string,
								sessionId,
							}),
						})),
						nowMs,
					)
				: renderGlance(
						readGlanceNotes({
							db: deps.db,
							sessionId,
							projectIdentity: resolveProject(),
							filter: params.filter,
						}),
						{ limit, offset, nowMs },
					);

			// Best-effort watermark so future nudge logic can suppress reminders.
			try {
				setNoteLastReadAt(deps.db, sessionId);
			} catch {
				// ignore — watermark is a hint, not correctness
			}

			if (body === EMPTY_READ_REPLY) {
				return EMPTY_READ_REPLY;
			}
			// Only surface the anchor hint when at least one note carries one.
			const anchorHint = body.includes("↳ @msg ")
				? "\n\n↳ @msg N marks the conversation tail when a note was written. To see what led to it: ctx_expand(start=N-x, end=N) (pick x for how far back to look)."
				: "";
			return `${body}${anchorHint}${DISMISS_FOOTER}`;
		},
	});
}

/** Live-tail anchor for write: best-effort, null when nothing is indexed yet. */
function captureAnchorOrdinal(
	db: ContextDatabase,
	sessionId: string,
): number | null {
	try {
		const ordinal = getLastIndexedOrdinal(db, sessionId);
		return ordinal > 0 ? ordinal : null;
	} catch {
		return null;
	}
}

/** Tray line appended to a write reply: note count + age of the oldest one. */
function writeTray(
	db: ContextDatabase,
	sessionId: string,
): { activeCount: number; oldestTouchedAt: number | null } {
	const active = getSessionNotes(db, sessionId);
	const oldest = active.reduce<number | null>((min, note) => {
		const touchedAt = noteTouchedAt(note);
		return min === null || touchedAt < min ? touchedAt : min;
	}, null);
	return { activeCount: active.length, oldestTouchedAt: oldest };
}

function formatDismissResults(
	results: Array<{ noteId: number; outcome: string }>,
): string {
	const dismissedCount = results.filter(
		(result) => result.outcome === "dismissed",
	).length;
	return `Dismissed ${dismissedCount} of ${results.length} notes.\n${results
		.map(
			(result) =>
				`- Note #${result.noteId}: ${result.outcome === "not_owned" ? "not_found" : result.outcome}`,
		)
		.join("\n")}`;
}

/** Parse `note_ids` for targeted reads and mutations (Pi/OpenCode parity). */
function parseNoteIds(action: string, value: unknown): number[] | string {
	const max = action === "update" ? 1 : 50;
	if (
		!Array.isArray(value) ||
		value.length < 1 ||
		value.length > max ||
		value.some(
			(id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0,
		)
	) {
		return action === "update"
			? "Error: 'note_ids' must contain exactly one positive integer id when action is 'update'."
			: `Error: 'note_ids' must contain 1 to 50 positive integer ids when action is '${action}'.`;
	}
	return value;
}

/**
 * Default mixed view (filter undefined): active session notes + every smart
 * note, ready or still parked — the "what should I act on now?" view. An
 * explicit filter applies one status to BOTH types (matches OpenCode parity).
 */
function readGlanceNotes(args: {
	db: ContextDatabase;
	sessionId: string;
	projectIdentity: string | undefined;
	filter: CtxNoteReadFilter | undefined;
}): Note[] {
	if (args.filter === undefined) {
		const sessionNotes = getSessionNotes(args.db, args.sessionId);
		const readySmartNotes = args.projectIdentity
			? getReadySmartNotes(args.db, args.projectIdentity)
			: [];
		const pendingSmartNotes = args.projectIdentity
			? getPendingSmartNotes(args.db, args.projectIdentity)
			: [];
		return [...sessionNotes, ...readySmartNotes, ...pendingSmartNotes];
	}

	const statusByFilter: Record<CtxNoteReadFilter, NoteStatus | NoteStatus[]> = {
		active: "active",
		all: ["active", "pending", "ready", "dismissed"],
		dismissed: "dismissed",
		pending: "pending",
		ready: "ready",
	};
	const status = statusByFilter[args.filter];

	const sessionNotes = getNotes(args.db, {
		sessionId: args.sessionId,
		type: "session",
		status,
	});
	const smartNotes = args.projectIdentity
		? getNotes(args.db, {
				projectPath: args.projectIdentity,
				type: "smart",
				status,
			})
		: [];
	return [...sessionNotes, ...smartNotes];
}
