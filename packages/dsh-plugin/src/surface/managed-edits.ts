/**
 * Managed edits — the decision-before-effect wrapper (T009).
 *
 * Every Magic Context surface mutation on DSH runs through
 * `runManagedChange`, in this order:
 *
 *  1. append the `mc/manage-start` log event (opens the durable bracket —
 *     the per-session lock, per the compaction precedent);
 *  2. write the store decision (`opts.decision` — shared-store writes only);
 *  3. apply the surface effect (`opts.effect` — replace/append via the
 *     DshSession, exactly one bracket's worth of shadow bookkeeping);
 *  4. append `mc/manage-end` (closes the bracket, citing the shadowed seqs).
 *
 * One lock bracket per managed change: concurrent `runManagedChange` calls on
 * one session queue behind a per-session mutex, so brackets never interleave.
 * A store busy/error at step 2 closes the bracket with `error` set and the
 * caller sees `StoreUnavailableError` — the decision stays unapplied and
 * replays later; callers implement replay-or-refuse. FR-004: a caller may
 * only send a request when a managed change completed or was refused — an
 * unmanaged request is never an option. `pendingUnapplied()` surfaces
 * start-without-end evidence for crash-resume (a bracket still open means the
 * decision may not have reached the surface).
 */
import type { DshHost, DshSession } from "../host.js";
import type { McManagedChangeKind, McManageEnd } from "./events.js";

/** A shared store that rejected a write because it is busy (SQLITE_BUSY). */
export class StoreBusyError extends Error {
	public override readonly name = "StoreBusyError";
}

/**
 * The managed change could not be committed with its decision backing it.
 * Raised when the store decision fails (busy/unavailable) or the bracket
 * cannot be opened at all. Callers implement replay-or-refuse on this —
 * never an unmanaged request (FR-004).
 */
export class StoreUnavailableError extends Error {
	public override readonly name = "StoreUnavailableError";

	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

/** Shadow bookkeeping produced by an applied surface effect. */
export interface ShadowInfo {
	/** Seq of the replacement node when one was written. */
	readonly replacementSeq?: number;
	/** Surface seqs shadowed by the replacement, in surface position order. */
	readonly shadowedSeqs?: readonly number[];
}

export interface ManagedChangeOptions<T> {
	/** DSH session id; defaults to `mcSession` (for DSH they are the same id). */
	readonly dshSessionId?: string;
	/** Step 2: write the decision to the shared store. Throws ⇒ fail-closed. */
	readonly decision: () => Promise<T>;
	/** Step 3: apply the durable surface effect via the DshSession. */
	readonly effect: (decision: T) => Promise<ShadowInfo>;
}

/** An open (start-without-end) bracket, for crash-resume reconciliation. */
export interface PendingUnapplied {
	readonly changeId: string;
	readonly kind: McManagedChangeKind;
	readonly mcSession: string;
	readonly dshSessionId: string;
	readonly startedAt: number;
}

export class ManagedEdits {
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly pending = new Map<string, PendingUnapplied>();

	constructor(private readonly host: DshHost) {}

	/**
	 * N-06: release the serialization chain of a closed session. Unapplied
	 * brackets are NOT lost: the durable bracket rows are re-discovered and
	 * replayed by the next attach (the pending map is a cache, the store is
	 * the source of truth).
	 */
	forget(sessionId: string): void {
		this.chains.delete(sessionId);
	}

	/**
	 * Run one managed change: bracket, decision, effect, close. Queues behind
	 * any other managed change on the same session (one lock bracket at a
	 * time). Rejects with `StoreUnavailableError` when the decision fails;
	 * effect failures reject with the effect's own error after an error-closed
	 * bracket.
	 */
	runManagedChange<T>(
		kind: McManagedChangeKind,
		changeId: string,
		mcSession: string,
		opts: ManagedChangeOptions<T>,
	): Promise<ShadowInfo> {
		const dshSessionId = opts.dshSessionId ?? mcSession;
		return this.withLock(dshSessionId, () =>
			this.runLocked(kind, changeId, mcSession, dshSessionId, opts),
		);
	}

	/** Brackets opened but not yet closed (in-memory; durable evidence is in the log). */
	pendingUnapplied(): PendingUnapplied[] {
		return [...this.pending.values()];
	}

	/** Unmount teardown: drop the lock chains; open brackets stay reported. */
	close(): void {
		this.chains.clear();
	}

	private async runLocked<T>(
		kind: McManagedChangeKind,
		changeId: string,
		mcSession: string,
		dshSessionId: string,
		opts: ManagedChangeOptions<T>,
	): Promise<ShadowInfo> {
		const session = this.host.getSession(dshSessionId);
		if (!session) {
			throw new StoreUnavailableError(
				`[magic-context] dsh session ${dshSessionId} is not attached; refusing to apply unmanaged change ${changeId} (FR-004)`,
			);
		}
		const startData: Record<string, unknown> = {
			changeId,
			kind,
			mcSession,
			dshSessionId,
			ignorable: true,
		};
		await session.appendLogEvent("mc/manage-start", startData);
		await session.flush();
		this.pending.set(changeId, {
			changeId,
			kind,
			mcSession,
			dshSessionId,
			startedAt: Date.now(),
		});
		let decision: T;
		try {
			decision = await opts.decision();
		} catch (error) {
			await this.closeBracket(session, {
				changeId,
				kind,
				error: describeError(error),
				ignorable: true,
			});
			this.pending.delete(changeId);
			throw error instanceof StoreUnavailableError
				? error
				: new StoreUnavailableError(
						`[magic-context] store decision for managed change ${changeId} failed; decision stays unapplied`,
						{ cause: error },
					);
		}
		let shadow: ShadowInfo;
		try {
			shadow = await opts.effect(decision);
		} catch (error) {
			await this.closeBracket(session, {
				changeId,
				kind,
				error: describeError(error),
				ignorable: true,
			});
			this.pending.delete(changeId);
			throw error;
		}
		await this.closeBracket(session, {
			changeId,
			kind,
			ignorable: true,
			...(shadow.shadowedSeqs !== undefined
				? { shadowedSeqs: shadow.shadowedSeqs }
				: {}),
			...(shadow.replacementSeq !== undefined
				? { replacementSeq: shadow.replacementSeq }
				: {}),
		});
		this.pending.delete(changeId);
		return shadow;
	}

	private async closeBracket(
		session: DshSession,
		data: McManageEnd,
	): Promise<void> {
		await session.appendLogEvent("mc/manage-end", { ...data });
		await session.flush();
	}

	/** Per-session mutex: each change queues on the previous one's settle. */
	private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(sessionId) ?? Promise.resolve();
		const run = previous.then(fn, fn);
		this.chains.set(
			sessionId,
			run.then(
				() => undefined,
				() => undefined,
			),
		);
		return run;
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}
