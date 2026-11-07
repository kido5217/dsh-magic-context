/**
 * Synthetic todo lane (T034).
 *
 * The agent's todo list is state, not conversation: it lives in log-only
 * `todo/write` events, so it never enters the message projection and the model
 * loses it the moment the step that wrote it scrolls out of view. The fix on
 * every harness is the same — re-surface the CURRENT list at a work boundary —
 * and the DSH constraint is that it must not be re-injected on every pass
 * (that would rewrite the tail for no new information).
 *
 * So this lane is revision-driven: it delivers the list once per `todo/write`
 * revision. The rendering mirrors the `todo/write` tool's own line format, so
 * the model sees the same shape it wrote.
 */

import type { TodoItem } from "../host.js";
import type { McReplacementContent } from "../surface/events.js";
import type { Lane, LaneContext, LaneSelection } from "./engine.js";

/** One delivery per todo revision, per session. */
export class TodoDelivery {
	private readonly deliveredSeq = new Map<string, number>();

	/** Claim delivery for this revision; false when already delivered. */
	claim(sessionId: string, seq: number): boolean {
		const seen = this.deliveredSeq.get(sessionId);
		if (seen !== undefined && seen >= seq) return false;
		this.deliveredSeq.set(sessionId, seq);
		return true;
	}

	/**
	 * N-15: per-session re-arm. One session's below-execute episode end must
	 * not re-deliver ANOTHER session's current todo revision mid-episode.
	 */
	forget(sessionId: string): void {
		this.deliveredSeq.delete(sessionId);
	}

	detachAll(): void {
		this.deliveredSeq.clear();
	}
}

export const todoDelivery = new TodoDelivery();

/** Render a todo list the way `todo/write` writes it. */
export function renderTodoList(items: readonly TodoItem[]): string {
	const lines = items.map(
		(item) => `- [${item.status === "completed" ? "x" : " "}] ${item.content}`,
	);
	return `Current todo list:\n${lines.join("\n")}`;
}

export function selectTodo(
	context: LaneContext,
	delivery: TodoDelivery = todoDelivery,
): McReplacementContent | undefined {
	const todo = context.todo;
	if (todo === undefined || todo.items.length === 0) return undefined;
	if (!delivery.claim(context.mcSession, todo.seq)) return undefined;
	return [{ type: "text", text: renderTodoList(todo.items) }];
}

export const todoLane: Lane = {
	name: "todo",
	frequency: "routine",
	changeKind: "drop",
	select(context: LaneContext): LaneSelection {
		const content = selectTodo(context);
		if (content === undefined) return { requests: [] };
		return {
			requests: [],
			tail: content,
			reason: "re-surfaced the current todo list",
		};
	},
};
