/**
 * DSH raw-history providers for the dreamer (T061).
 *
 * `retrospective` reads OTHER project sessions' genuine user friction, and
 * `refresh-primers` renders the orientation seed from a historical session —
 * both through host-supplied raw providers, because the core default reads
 * the OpenCode DB. Here the source is the DSH durable session log: sessions
 * are enumerated by working directory through `ctx.sessionQuery`, and one
 * session's history is its surface projection (the same projection the
 * surface lane reads, so the adapter's own injected nodes appear exactly as
 * the model saw them — but PRIVACY still applies: only genuine typed user
 * text carries content; tool rows carry metadata only).
 */
import type { Context } from "@deepseek-ai/cordis";
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import { deriveEventMessage, isSurfaceEvent } from "@deepseek-ai/dsh-session";
import { SessionId } from "@deepseek-ai/dsh-session/types";
import type {
	RetrospectiveProjectSession,
	RetrospectiveRawMessage,
	RetrospectiveRawProvider,
	RetrospectiveSinceRead,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import {
	RETROSPECTIVE_MAX_USER_MESSAGE_CHARS,
	RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import type { RawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import {
	cleanUserText,
	hasMeaningfulUserText,
} from "@magic-context/core/hooks/magic-context/read-session-chunk";
import type { DshLogMessageRecord } from "../surface/dsh-session-log.js";
import { createDshRawMessageProvider } from "../surface/dsh-session-log.js";

/** Host seam: the two durable reads the providers need, testable in isolation. */
export interface DshSessionHistorySource {
	listProjectSessions(
		cwd: string,
	): Promise<readonly RetrospectiveProjectSession[]>;
	readSessionRecords(
		sessionId: string,
	): Promise<readonly DshLogMessageRecord[]>;
}

function clampHeadTail(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = RETROSPECTIVE_MESSAGE_TRUNCATION_MARKER;
	const keep = Math.max(0, limit - marker.length);
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

function genuineUserText(record: DshLogMessageRecord): string {
	const blocks = (record.blocks ?? []) as unknown as Array<
		Record<string, unknown>
	>;
	const texts = blocks
		.filter(
			(block) =>
				block["type"] === "text" &&
				block["synthetic"] !== true &&
				block["ignored"] !== true &&
				typeof block["text"] === "string",
		)
		.map((block) => (block["text"] as string).trim());
	// Text fallback only for narrow doubles without blocks; a record WITH
	// blocks whose text all filters out (e.g. all synthetic) is genuinely
	// empty — falling back to `record.text` would leak synthetic content.
	const candidates =
		record.blocks === undefined && record.text.trim().length > 0
			? [record.text.trim()]
			: texts;
	if (candidates.length === 0) return "";
	if (
		!hasMeaningfulUserText(candidates.map((text) => ({ type: "text", text })))
	)
		return "";
	return candidates
		.map((text) => cleanUserText(text))
		.filter((text) => text.length > 0)
		.join("\n")
		.trim();
}

/**
 * Tool NAMES live on the assistant `tool-call` blocks (id + name); the tool
 * RESULT message only carries the correlation id and the error flag. The
 * projection pre-indexes call ids across the whole log so friction rows see
 * the real tool name.
 */
function indexToolNames(
	records: readonly DshLogMessageRecord[],
): Map<string, string> {
	const names = new Map<string, string>();
	for (const record of records) {
		for (const block of (record.blocks ?? []) as unknown as Array<
			Record<string, unknown>
		>) {
			if (block["type"] !== "tool-call") continue;
			const id = block["id"];
			const name = block["name"];
			if (typeof id === "string" && typeof name === "string")
				names.set(id, name);
		}
	}
	return names;
}

/** Surface records → retrospective rows (user text + tool metadata only). */
export function projectRetrospectiveRows(
	sessionId: string,
	records: readonly DshLogMessageRecord[],
): RetrospectiveRawMessage[] {
	const rows: RetrospectiveRawMessage[] = [];
	const toolNames = indexToolNames(records);
	let ordinal = 0;
	let seenAssistantReply = false;
	for (const record of records) {
		if (isAdapterInjected(record)) continue;
		const ordinalNow = ++ordinal;
		const ts = record.createdAt ?? 0;
		if (record.role === "user") {
			const text = genuineUserText(record);
			if (text.length > 0)
				rows.push({
					sessionId,
					ordinal: ordinalNow,
					role: "user",
					text: clampHeadTail(text, RETROSPECTIVE_MAX_USER_MESSAGE_CHARS),
					ts,
					...(seenAssistantReply ? { followsAssistantReply: true } : {}),
				});
		} else if (record.role === "assistant") {
			seenAssistantReply = true;
		} else if (record.role === "tool") {
			const correlated =
				record.toolCallId !== undefined
					? toolNames.get(record.toolCallId)
					: undefined;
			rows.push({
				sessionId,
				ordinal: ordinalNow,
				role: "tool",
				text: "",
				toolName: correlated ?? "tool",
				isError: record.isError === true,
				ts,
			});
		}
	}
	return rows;
}

/** Adapter-injected nodes (mc-*) are friction-free plumbing, not user history. */
function isAdapterInjected(record: DshLogMessageRecord): boolean {
	return record.messageId.startsWith("mc-");
}

export function createDshRetrospectiveRawProvider(
	source: DshSessionHistorySource,
	projectCwd: string,
): RetrospectiveRawProvider {
	const cache = new Map<string, Promise<RetrospectiveRawMessage[]>>();
	const rowsFor = (sessionId: string): Promise<RetrospectiveRawMessage[]> => {
		let rows = cache.get(sessionId);
		if (rows === undefined) {
			rows = source
				.readSessionRecords(sessionId)
				.then((records) => projectRetrospectiveRows(sessionId, records));
			cache.set(sessionId, rows);
		}
		return rows;
	};
	return {
		async listProjectSessions() {
			const sessions = await source.listProjectSessions(projectCwd);
			// Maintenance children are transient plumbing, never friction sources.
			return sessions
				.filter((session) => !session.sessionId.startsWith("session-mc-maint-"))
				.map((session) => ({ ...session }));
		},
		async readUserMessagesSince(
			sessionId: string,
			sinceMs: number,
			capPerSession: number,
		): Promise<RetrospectiveSinceRead> {
			const rows = (await rowsFor(sessionId)).filter((row) => row.ts > sinceMs);
			return {
				messages: rows.slice(0, capPerSession),
				truncated: rows.length > capPerSession,
			};
		},
		async readOldestMessageTimesSince(sessionIds, sinceMs) {
			const times = new Map<string, number>();
			for (const sessionId of sessionIds) {
				const rows = await rowsFor(sessionId);
				let oldest: number | undefined;
				for (const row of rows)
					if (row.ts > sinceMs && (oldest === undefined || row.ts < oldest))
						oldest = row.ts;
				if (oldest !== undefined) times.set(sessionId, oldest);
			}
			return times;
		},
		async readUserMessagesBefore(sessionId, beforeMs, count) {
			const rows = (await rowsFor(sessionId)).filter(
				(row) => row.role === "user" && row.ts <= beforeMs,
			);
			return rows.slice(Math.max(0, rows.length - count));
		},
		dispose: () => {
			cache.clear();
		},
	};
}

/** Orientation-seed provider for refresh-primers, per historical session. */
export function createDshPrimerRawProviderFactory(
	source: DshSessionHistorySource,
): (sessionId: string) => Promise<RawMessageProvider | null> {
	return async (sessionId: string) => {
		const records = await source.readSessionRecords(sessionId);
		if (records.length === 0) return null;
		let cached: { records: readonly DshLogMessageRecord[] } | undefined;
		return createDshRawMessageProvider(() => {
			cached ??= { records };
			const rawMessages = projectRetrospectiveRaw(sessionId, cached.records);
			return {
				rawMessages,
				byMessageId: new Map(),
				byOrdinal: new Map(
					rawMessages.map((message) => [message.ordinal, message.id]),
				),
				records: cached.records,
			};
		});
	};
}

function projectRetrospectiveRaw(
	sessionId: string,
	records: readonly DshLogMessageRecord[],
) {
	const raw = [];
	let ordinal = 0;
	for (const record of records) {
		if (!["user", "assistant", "tool"].includes(record.role)) continue;
		ordinal += 1;
		raw.push({
			ordinal,
			id: record.messageId,
			role: record.role,
			parts:
				record.role === "user"
					? (() => {
							const text = genuineUserText(record);
							return text.length > 0 ? [{ type: "text" as const, text }] : [];
						})()
					: record.role === "assistant"
						? record.text.trim().length > 0
							? [
									{
										type: "text" as const,
										text: record.text,
									},
								]
							: []
						: [],
			...(record.createdAt !== undefined
				? { createdAt: record.createdAt }
				: {}),
		});
	}
	void sessionId;
	return raw;
}

/** Production history source over the live Cordis context. */
export function createCordisSessionHistorySource(
	ctx: Context,
): DshSessionHistorySource {
	return {
		async listProjectSessions(cwd) {
			const records = await ctx.sessionQuery.filterSessions([
				{ kind: "cwd", values: [cwd] },
			]);
			return records
				.filter(
					(record) =>
						record.header.origin !== "subagent" &&
						record.header.id !== undefined,
				)
				.map((record) => ({
					sessionId: String(record.header.id),
					updatedAt: record.header.createdAt,
				}));
		},
		async readSessionRecords(sessionId) {
			const snapshot = await ctx.sessionQuery.readSurface(SessionId(sessionId));
			const out: DshLogMessageRecord[] = [];
			for (const event of snapshot.events) {
				if (!isSurfaceEvent(event)) continue;
				if (event.type === "system/message") continue;
				const message = deriveEventMessage(event);
				if (message === null) continue;
				const text = (message.content as ContentBlock[])
					.filter(
						(block): block is { type: "text"; text: string } =>
							block.type === "text",
					)
					.map((block) => block.text)
					.join("\n");
				out.push({
					seq: Number(event.seq),
					messageId: String(message.id),
					role: message.role,
					text,
					createdAt: event.time,
					blocks: message.content as ContentBlock[],
					...(message.role === "tool"
						? {
								toolCallId: String(
									(message as { toolCallId?: unknown }).toolCallId,
								),
								...(message.isError === true ? { isError: true } : {}),
							}
						: {}),
				});
			}
			return out;
		},
	};
}
