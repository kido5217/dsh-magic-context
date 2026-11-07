/**
 * Durable session-log → core raw-history projection (T015).
 *
 * The core reads a session's raw history through a per-session
 * `RawMessageProvider` (`@magic-context/core/hooks/magic-context/read-session-chunk`,
 * iface at read-session-chunk.ts:142). OpenCode reads its own DB; Pi converts
 * `sessionManager.getBranch()`. Here the source is the DSH Session log: every
 * surface-producing event (`user/message`, `assistant/message`, `tool/result`,
 * and this adapter's own replacement/notice nodes) projects to one
 * `RawMessage` in surface position order; log-only records (`mc/manage-*`,
 * `turn/*`, …) carry no surface and project to nothing.
 *
 * Ordinal space: 1-based positions in the surface projection (the DSH analogue
 * of the host branch position Pi anchors on). `seqByMessageId` maps a tag's
 * `messageId` (the durable DSH event/message id) back to its surface seq so
 * drop/fold effects can cite the exact shadowed nodes.
 *
 * Registration mirrors Pi (`context-handler.ts:8078`): wrap the provider in
 * core's `setRawMessageProvider(sessionId, provider)` for the session's
 * managed lifetime; the returned disposer unregisters.
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type {
	RawMessage,
	RawMessageParts,
} from "@magic-context/core/hooks/magic-context/read-session-raw";

/** One surface-visible message read off the DSH session log. */
export interface DshLogMessageRecord {
	/** Durable surface seq of the event carrying this message. */
	readonly seq: number;
	/** Durable message id (tag `messageId` space). */
	readonly messageId: string;
	readonly role: string;
	/** Concatenated text content of the message's content blocks. */
	readonly text: string;
	readonly createdAt?: number;
	/**
	 * Full provider-neutral content blocks, preserving reasoning, tool calls and
	 * image/file references. Optional so narrow doubles can project text only;
	 * production always fills it. Lane code must treat an absent value as
	 * text-only rather than reconstructing structure from `text`.
	 */
	readonly blocks?: readonly ContentBlock[];
	/** Tool call this message answers (`role === "tool"`). */
	readonly toolCallId?: string;
	/** True when a reasoning block carries a provider replay signature. */
	readonly reasoningSigned?: boolean;
	/** Tool failure marker for tool-result messages. */
	readonly isError?: boolean;
}

/** Host seam: read the current surface-visible message records of a session. */
export type DshSessionLogReader = (
	dshSessionId: string,
) => readonly DshLogMessageRecord[] | undefined;

/** Projection of one session's surface log into the core's raw-history shape. */
export interface DshLogProjection {
	readonly rawMessages: RawMessage[];
	/** Projection position (1-based ordinal) per message, keyed by durable id. */
	readonly byMessageId: ReadonlyMap<
		string,
		{ readonly ordinal: number; readonly seq: number; readonly bytes: number }
	>;
	readonly records: readonly DshLogMessageRecord[];
}

const PROJECTED_ROLES = new Set(["user", "assistant", "tool", "system"]);

/**
 * Durable ids of nodes this adapter appends (replacements, notices, head).
 * They project as history for core readers, but never become reclaim targets:
 * dropping a `[dropped §N§]` node or the head would erase the evidence of a
 * completed reduction.
 */
export function isAdapterSurfaceId(messageId: string): boolean {
	return messageId.startsWith("mc-");
}

function recordText(record: DshLogMessageRecord): string {
	return record.text;
}

/** Project surface message records (seq/position order) into the core RawMessage shape. */
export function projectDshSessionLog(
	records: readonly DshLogMessageRecord[],
): DshLogProjection {
	const rawMessages: RawMessage[] = [];
	const byMessageId = new Map<
		string,
		{ ordinal: number; seq: number; bytes: number }
	>();
	let ordinal = 0;
	for (const record of records) {
		if (!PROJECTED_ROLES.has(record.role)) continue;
		ordinal += 1;
		const text = recordText(record);
		rawMessages.push({
			ordinal,
			id: record.messageId,
			role: record.role,
			parts: text.length > 0 ? [{ type: "text", text }] : [],
			...(record.createdAt !== undefined
				? { createdAt: record.createdAt }
				: {}),
		});
		byMessageId.set(record.messageId, {
			ordinal,
			seq: record.seq,
			bytes: text.length,
		});
	}
	return { rawMessages, byMessageId, records };
}

/** Build the core `RawMessageProvider` over a live projection supplier. */
export function createDshRawMessageProvider(
	project: () => DshLogProjection,
): RawMessageProvider {
	return {
		readMessages: () => project().rawMessages,
		getMessageCount: () => project().rawMessages.length,
		hasMessageById: (messageId: string) => project().byMessageId.has(messageId),
		readMessageById: (messageId: string) =>
			project().rawMessages.find((message) => message.id === messageId) ?? null,
		readMessagePartsById: (messageId: string): RawMessageParts | null => {
			const message = project().rawMessages.find(
				(candidate) => candidate.id === messageId,
			);
			return message ?? null;
		},
		readMessageOrdinalById: (messageId: string) =>
			project().byMessageId.get(messageId)?.ordinal ?? null,
		readMessageIdOrdinals: () => {
			const map = new Map<string, number>();
			for (const [messageId, entry] of project().byMessageId)
				map.set(messageId, entry.ordinal);
			return map;
		},
	};
}

/**
 * Register the provider for one session the way Pi does — core
 * `setRawMessageProvider` — and return the disposer. Core helpers
 * (readSessionChunk, the historian trigger, ctx_expand) then read DSH durable
 * history instead of the OpenCode DB default.
 */
export function registerDshRawHistoryProvider(
	dshSessionId: string,
	project: () => DshLogProjection,
): () => void {
	return setRawMessageProvider(
		dshSessionId,
		createDshRawMessageProvider(project),
	);
}
