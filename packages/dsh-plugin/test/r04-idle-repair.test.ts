/**
 * R-04 (fresh review #2): the dropped-but-unmaterialized repair must GATE
 * the pass, not just enrich one. A crash between persisting the drop
 * decision and rewriting the surface leaves a tag `dropped` in the store
 * while the surface still serves full bytes; the tag is then neither queued
 * (drained) nor active (decided), so a session that goes quiet after the
 * crash has zero candidates — before the fix, `candidates.size === 0`
 * returned early and the stale bytes survived until some unrelated queue
 * event started a pass.
 */
import { beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { openDatabaseAsync } from "@magic-context/core/features/magic-context/storage-db";
import { DropApplier } from "../src/surface/apply-operations.js";
import { projectDshSessionLog } from "../src/surface/dsh-session-log.js";
import { ManagedEdits } from "../src/surface/managed-edits.js";
import { TestDshHost } from "./double.js";

let db: ContextDatabase;

beforeAll(async () => {
	db = (await openDatabaseAsync({
		dbPath: join(mkdtempSync(join(tmpdir(), "mc-r04-")), "context.db"),
		nativeTurnDeadlines: true,
	}))!;
});

/** Three live surface nodes; the store believes seq 0's tag §7§ is dropped
 * (queue drained, surface never rewritten) — the crash-window residue. */
function crashResidue(id: string) {
	const host = new TestDshHost();
	const session = host.addSession({ id }, [0, 1, 2]);
	session.seedMessage(0, "u-old", "old question about the store", "user");
	session.seedMessage(1, "a-old", "the old answer", "assistant");
	session.seedMessage(2, "u-new", "the newest question", "user");
	db.prepare(
		"INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number) VALUES (?, 'u-old', 'message', 'dropped', 42, 7)",
	).run(id);
	return { host, session };
}

test("an idle session with zero candidates still runs the repair pass", async () => {
	const { host, session } = crashResidue("r04-repair");
	const applier = new DropApplier(db, new ManagedEdits(host));
	const result = await applier.applyQueuedDrops({
		session,
		mcSession: "r04-repair",
		projection: projectDshSessionLog(session.logRecords()),
		autoQueue: false,
		protectedTailTokens: 10_000,
	});
	expect(result).not.toBeNull();
	expect(result!.tagIds).toEqual([7]);
	// The placeholder landed on the surface node.
	const rewritten = session.rewrittenUserMessages.at(-1);
	expect(JSON.stringify(rewritten)).toContain("§7§");
});

test("the repair pass is idempotent: a materialized drop returns null", async () => {
	const { host, session } = crashResidue("r04-idem");
	const applier = new DropApplier(db, new ManagedEdits(host));
	const first = await applier.applyQueuedDrops({
		session,
		mcSession: "r04-idem",
		projection: projectDshSessionLog(session.logRecords()),
		autoQueue: false,
		protectedTailTokens: 10_000,
	});
	expect(first).not.toBeNull();
	const second = await applier.applyQueuedDrops({
		session,
		mcSession: "r04-idem",
		projection: projectDshSessionLog(session.logRecords()),
		autoQueue: false,
		protectedTailTokens: 10_000,
	});
	expect(second).toBeNull();
});
