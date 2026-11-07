/**
 * Tool identity from the durable log (T024 prerequisite).
 *
 * The core's reduction selectors select in TOOL-TAG space: a tag identifies one
 * tool call by the composite `(ownerMessageId, callId)`, carries the tool name
 * (for protected-tool windows and zero-value meta tools), and names the owner
 * message (so "recent" protection is decided on the message that issued the
 * call, not on the result). DSH's projection has the same facts, but scattered:
 *
 * - the CALL lives in the assistant message's `tool-call` content blocks
 *   (`id`, `name`, `arguments`);
 * - the RESULT lives in the following `tool/result` record, which carries
 *   `toolCallId` but not the name or the owner.
 *
 * This index joins them once per pass, so tagging and every lane read one
 * authoritative map instead of re-deriving the pairing.
 */
import type { ContentBlock } from "@deepseek-ai/dsh-llm/types";
import type {
	DshLogMessageRecord,
	DshLogProjection,
} from "../surface/dsh-session-log.js";

/** One tool call, joined with the assistant message that issued it. */
export interface ToolCallIdentity {
	readonly callId: string;
	readonly name: string;
	/** Assistant message that issued the call (the tag's owner). */
	readonly ownerMessageId: string;
	/** Assistant surface seq, for ordering. */
	readonly ownerSeq: number;
	/** Byte length of the serialized arguments (input weight). */
	readonly inputBytes: number;
}

/** The callId → identity index, plus per-result owner resolution. */
export interface ToolIdentityIndex {
	readonly byCallId: ReadonlyMap<string, ToolCallIdentity>;
	/** Identity for one tool-result record, when its call is indexable. */
	forRecord(record: DshLogMessageRecord): ToolCallIdentity | undefined;
}

function toolCallsOf(
	blocks: readonly ContentBlock[] | undefined,
): readonly { id: string; name: string; arguments: string }[] {
	if (blocks === undefined) return [];
	const calls: { id: string; name: string; arguments: string }[] = [];
	for (const block of blocks) {
		if (block.type !== "tool-call") continue;
		calls.push({
			id: String(block.id),
			name: String(block.name),
			arguments: String(block.arguments ?? ""),
		});
	}
	return calls;
}

/**
 * Build the identity index. A later call with the same id wins: the host never
 * reuses a call id within a session, and if one did, the live one is the one
 * whose result exists.
 */
export function indexToolCalls(
	projection: DshLogProjection,
): ToolIdentityIndex {
	const byCallId = new Map<string, ToolCallIdentity>();
	for (const record of projection.records) {
		if (record.role !== "assistant") continue;
		for (const call of toolCallsOf(record.blocks)) {
			byCallId.set(call.id, {
				callId: call.id,
				name: call.name,
				ownerMessageId: record.messageId,
				ownerSeq: record.seq,
				inputBytes: call.arguments.length,
			});
		}
	}
	return {
		byCallId,
		forRecord(record) {
			if (record.role !== "tool" || record.toolCallId === undefined)
				return undefined;
			return byCallId.get(record.toolCallId);
		},
	};
}
