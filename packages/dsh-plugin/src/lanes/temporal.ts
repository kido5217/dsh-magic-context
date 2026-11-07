/**
 * Time-marker lane (T030).
 *
 * The model has no clock: without a marker it cannot tell whether the last
 * exchange happened two minutes or three days ago, and it guesses wrong in the
 * expensive direction (assuming "just now" and re-running stale work). The
 * core prefixes the entering user message with a compact elapsed-time marker
 * (`<!-- +2h -->`) computed from the previous message's completion time.
 *
 * The selector is the core's `injectTemporalMarkers`, which mutates a
 * host-shaped message array. This module supplies the DSH adapter: it maps the
 * durable projection into that shape, runs the selector, and diffs the texts
 * back out as node operations. No marker format, gap threshold or
 * idempotency rule is re-implemented here — including the rule that an
 * existing marker is never re-injected, which is what keeps a deferred pass
 * byte-identical.
 *
 * Markers are inserted AFTER any `§N§` tag prefix by the core, so a node that
 * was already dropped and re-rendered still round-trips.
 */
import { injectTemporalMarkers } from "@magic-context/core/hooks/magic-context/temporal-awareness";
import type { NodeOpRequest } from "../surface/node-ops.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

/** The host-shaped message the core selector reads and mutates. */
interface TemporalMessage {
	info: {
		id: string;
		role: string;
		time: { created: number; completed?: number };
	};
	parts: { type: string; text: string }[];
}

/**
 * Build the selector input. `completed` is unknown on DSH (the log records the
 * message's own time), so the gap is measured from the PREVIOUS message's
 * creation — slightly conservative, never negative.
 */
export function temporalMessages(context: LaneContext): {
	messages: TemporalMessage[];
	messageIdByIndex: string[];
} {
	const messages: TemporalMessage[] = [];
	const messageIdByIndex: string[] = [];
	for (const record of context.projection.records) {
		if (record.role !== "user" && record.role !== "assistant") continue;
		// A structured body (images, tool blocks) is not a text target; the
		// marker belongs in front of prose only.
		if (
			record.blocks !== undefined &&
			(record.blocks.length !== 1 || record.blocks[0]?.type !== "text")
		)
			continue;
		messages.push({
			info: {
				id: record.messageId,
				role: record.role,
				time: { created: record.createdAt ?? 0 },
			},
			parts: [{ type: "text", text: record.text }],
		});
		messageIdByIndex.push(record.messageId);
	}
	return { messages, messageIdByIndex };
}

/** Pure selector: node edits for every message the core marked. */
export function selectTemporalMarkers(context: LaneContext): NodeOpRequest[] {
	if (context.config.temporal_awareness !== true) return [];
	const { messages, messageIdByIndex } = temporalMessages(context);
	const before = messages.map((message) => message.parts[0]?.text ?? "");
	injectTemporalMarkers(messages);
	const requests: NodeOpRequest[] = [];
	for (const [index, message] of messages.entries()) {
		const after = message.parts[0]?.text ?? "";
		if (after === before[index]) continue;
		requests.push({
			messageId: messageIdByIndex[index]!,
			content: [{ type: "text", text: after }],
		});
	}
	return requests;
}

export const temporalLane: Lane = {
	name: "temporal",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const requests = selectTemporalMarkers(context);
		return {
			requests,
			...(requests.length > 0
				? {
						reason: `marked ${String(requests.length)} message(s) with elapsed time`,
					}
				: {}),
		};
	},
};
