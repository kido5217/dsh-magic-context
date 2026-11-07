/**
 * [T068] `/ctx-status` for DSH: the shared status view model, fed from the
 * shared store. Pressure counters are persisted by the lanes every pass
 * (`persistStatusMeta`); the breakdown is measured from the store, which is
 * the single source of truth every host writes to.
 */
import type { MagicContextConfig } from "@magic-context/core/config/schema/magic-context";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta-session";
import { getPendingOpsCount } from "@magic-context/core/features/magic-context/storage-ops";
import {
	buildStatusView,
	type StatusSection,
	type StatusView,
} from "@magic-context/core/shared/status-view";
import { checkStatusViewSource } from "@magic-context/core/shared/status-view-check";

export interface StatusCommandExtras {
	/** Plugin version shown beside the title. */
	readonly version: string;
	/** Dreamer lane state: undefined = lane off; null = on but never ran. */
	readonly dreamer?: {
		readonly lastRunAt: number | null;
		readonly unsupportedTasks: readonly string[];
		/** Set when the schedule state could not be read at all: "never ran"
		 *  and "cannot tell" are different facts (N-06). */
		readonly stateError?: string;
	};
}

/** Rough but monotone token estimate for store-measured breakdowns. */
function approxTokens(bytes: number): number {
	return Math.ceil(bytes / 4);
}

function measure(
	db: ContextDatabase,
	mcSession: string,
): Record<string, number> {
	const num = (sql: string, ...args: unknown[]): number => {
		try {
			const row = db.prepare(sql).get(...args) as
				| { n?: number | null }
				| undefined;
			return typeof row?.n === "number" ? row.n : 0;
		} catch {
			return 0;
		}
	};
	const compartmentTokens = num(
		"SELECT COALESCE(SUM(LENGTH(coalesce(content, '')) + LENGTH(coalesce(events, ''))), 0) AS n FROM compartments WHERE session_id = ?",
		mcSession,
	);
	const compartmentCount = num(
		"SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
		mcSession,
	);
	const memoryTokens = num(
		"SELECT COALESCE(SUM(LENGTH(coalesce(content, ''))), 0) AS n FROM memories",
	);
	const memoryBlockCount = num("SELECT COUNT(*) AS n FROM memories");
	const activeTags = num(
		"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'active'",
		mcSession,
	);
	const droppedTags = num(
		"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'dropped'",
		mcSession,
	);
	const totalTags = num(
		"SELECT COUNT(*) AS n FROM tags WHERE session_id = ?",
		mcSession,
	);
	const activeBytes = num(
		"SELECT COALESCE(SUM(bytes), 0) AS n FROM tags WHERE session_id = ? AND status = 'active'",
		mcSession,
	);
	const protectedTagCount = num(
		"SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND protected = 1",
		mcSession,
	);
	return {
		compartmentTokens: approxTokens(compartmentTokens),
		compartmentCount,
		memoryTokens: approxTokens(memoryTokens),
		memoryBlockCount,
		activeTags,
		droppedTags,
		totalTags,
		activeBytes,
		protectedTagCount,
		memoryCount: memoryBlockCount,
	};
}

function renderView(view: StatusView): string {
	const lines: string[] = [`## ${view.title}`, ""];
	lines.push(`${view.headline.left.text}  ${view.headline.right.text}`);
	if (view.windowLine !== null) lines.push(view.windowLine);
	if (view.breakdown.length > 0) {
		lines.push("", "### Breakdown");
		for (const row of view.breakdown) {
			lines.push(`${row.label}: ${row.value}`);
		}
	}
	for (const section of view.sections as readonly StatusSection[]) {
		lines.push("", `### ${section.title}`);
		for (const row of section.rows) {
			lines.push(`${row.label}: ${row.value}`);
		}
	}
	if (view.warnings.length > 0) {
		lines.push("", "### Warnings");
		for (const warning of view.warnings) lines.push(warning.text);
	}
	if (view.footer !== "") lines.push("", view.footer);
	return lines.join("\n");
}

export function buildStatusText(
	db: ContextDatabase,
	mcSession: string,
	config: MagicContextConfig,
	extras: StatusCommandExtras,
): string {
	const meta = getOrCreateSessionMeta(db, mcSession);
	const measured = measure(db, mcSession);
	const limit = meta.lastUsageContextLimit || 0;
	const threshold =
		typeof config.execute_threshold_percentage === "number"
			? config.execute_threshold_percentage
			: (config.execute_threshold_percentage?.default ?? 75);
	const cacheTtl =
		typeof config.cache_ttl === "string"
			? config.cache_ttl
			: (config.cache_ttl?.default ?? "5m");
	const now = Date.now();
	const source: Record<string, unknown> = {
		usagePercentage: meta.lastContextPercentage,
		inputTokens: meta.lastInputTokens,
		contextLimit: limit,
		executeThreshold: threshold,
		systemPromptTokens: meta.systemPromptTokens,
		conversationTokens: meta.conversationTokens,
		toolCallTokens: meta.toolCallTokens,
		// DSH advertises its tool schemas outside the shared store; the view
		// treats 0 as "host does not meter tool definitions".
		toolDefinitionTokens: 0,
		docsTokens: 0,
		factTokens: 0,
		profileTokens: 0,
		historyBlockTokens: 0,
		lastNudgeTokens: meta.lastNudgeTokens,
		// N-13: the real queue depth — drops strip in the NEXT pass, and the
		// user needs to see that (other hosts show this via the same view).
		pendingOpsCount: getPendingOpsCount(db, mcSession) ?? 0,
		cacheTtl,
		lastResponseTime: meta.lastResponseTime,
		cacheRemainingMs:
			meta.lastResponseTime > 0
				? Math.max(0, meta.lastResponseTime + ttlMs(cacheTtl) - now)
				: 0,
		cacheExpired:
			meta.lastResponseTime > 0 &&
			now - meta.lastResponseTime >= ttlMs(cacheTtl),
		isSubagent: meta.isSubagent,
		...measured,
	};
	if (extras.dreamer !== undefined) {
		source.lastDreamerRunAt = extras.dreamer.lastRunAt;
		source.dreamerUnsupportedTasks = extras.dreamer.unsupportedTasks;
	}
	const check = checkStatusViewSource(source);
	if (!check.ok) {
		return `## Magic Context Status\n\n(status fields missing: ${check.fields.join(", ")})`;
	}
	const view = buildStatusView(check.source, {
		version: extras.version,
		now,
	});
	const rendered = renderView(view);
	const stateError = extras.dreamer?.stateError;
	return stateError === undefined
		? rendered
		: `${rendered}\n\n(warning) dream schedule state unreadable: ${stateError}`;
}

function ttlMs(ttl: string): number {
	const match = /^(\d+)\s*([smhd])$/.exec(ttl.trim());
	if (match === null) return 300_000;
	const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
		match[2] ?? "m"
	];
	return Number(match[1]) * (unit ?? 60_000);
}
