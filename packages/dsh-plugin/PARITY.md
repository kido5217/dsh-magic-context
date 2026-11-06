# PARITY.md — DSH adapter deviation ledger

Parity doctrine (feature 001, `specs/001-dsh-harness-support` in the sidecar): parity is the
shared core's **host-independent effective behavior** (intent parity). Workarounds that exist
only because of another host's limitations are **not** replicated here. Every divergence is a
numbered entry below, citing the host fact that forces it. An unlisted behavioral difference
found at review is a finding, not a quirk.

Adjudication: the implementer proposes entries; the PR review adjudicates. New entries must
cite a specific host fact (docs section or observed behavior, with DSH version).

## Not ported — host workarounds from other harnesses

1. **Not ported — OpenCode per-step in-place transform.** DSH's assembled loop request is
   deep-frozen at `llm/stream` (reconstructability invariant): rewriting the outbound request
   is not a sanctioned seam. Management is applied as durable Session-log edits instead (the
   mechanism native compaction uses). Product intent — deterministic replay, byte-stable
   defer passes — is met structurally: the log fold replays every past decision byte-for-byte.
2. **Not ported — OpenCode 1 compaction-marker trick.** Superseded by DSH's native
   shadow-range mechanism (`surfaceOp: {op:'replace', startSeq, endSeq}` precedent).
3. **Not ported — OpenCode 2 per-pass tool-description rewrite.** Host-shaped: DSH tool
   declarations are session-log-derived, so a per-pass description rewrite has no seam or
   need; descriptions are sourced from the core prompt-surface source at registration.
4. **N/A — TUI seam, dashboard-specific hooks.** Surface absent on DSH for these
   OpenCode-specific integrations; declared with reason per constitution IV.
5. **N/A — Rust transform mode (ck-mc).** Removed upstream in 0.50.0; no DSH obligation.

## DSH-imposed differences

6. **DSH-imposed — drop/fold effects are managed surface edits, not request rewrites.**
   OpenCode/Pi rewrite in-flight message content inside the transform; DSH freezes the
   assembled request (entry 1), so a queued drop persists through the core
   `applyPendingOperations` `target_absent` baseline (tag `dropped`, `drop_mode` frozen)
   and the surface shows the canonical `[dropped §N§]` node at the shadowed seq range.
   Byte-identical placeholders: the same pure core renderers, so later replays match.
7. **DSH-imposed — refusal notices are their own durable nodes.** DSH's pre-step
   `reject` carries no reason field, so the at-the-wall refusal appends one plugin-sourced
   `user/message` notice per refusal episode (episode closes on any entering pass).
8. **DSH-imposed — coverage coordinates are durable surface seqs.** Compartments store
   `startMessage`/`endMessage` as DSH session-log seqs (the only coordinate that survives
   shadowing); projection positions are per-read. Resume-skip, fold-continuation and the
   protected-tail all key on seq. v1 scope — DSH-imposed only.
9. **DSH-imposed — protected-tail budget halves on emergency passes.** With the core's
   request-time protections (`protected_tokens`, `history_budget_percentage`) mapped onto
   the routed window, a force/refuse pass halves the verbatim budget so pressure can still
   find a foldable window; on request-transform harnesses the same protections apply per
   request without a fold-time tension. v1 scope — DSH-imposed only.
10. **v1 scope — head renders guidance + compartments + facts only.** Aging tiers,
    project-memory blocks and the mural ride the full `renderCompartmentInjection`
    pipeline (core-host-agnostic work, not host-forced); historian v1 publishes one
    flat P1-style compartment per fold with a minimal summarizer prompt (the core
    compartment prompt targets agent runners) and no memory promotion — subagent rule
    sets (`rules.summarizerMemoryWrites`) gate the later enablement. Not a parity gap:
    flagged for a follow-up pass, applies equally to every harness.
11. **DSH-imposed — `/compact` declines while MC manages.** The host's `CompactionResult`
    contract (compaction/start|summary|end event seqs, `@deepseek-ai/dsh-compaction` 0.2.2-rc.1)
    is a request-eraser protocol; an MC pass is a scheduled lane pass, not an eraser run, so
    the claimed backend returns null for command-driven compaction and `/compact` reports
    nothing to do. Pressure-driven folds cover the same need (observed behavior, live gate).
12. **v1 scope — tool session binding resolves to the most recently attached session.**
    Core tools are per-conversation; DSH registers the tool set once per mount, so the
    session a tool call targets comes from the live session last seen by the mapping
    (`SessionMapping.lastAttached()`), refined per agent in the follow-up pass. Single-agent
    hosts (the documented v1 deployment shape) are unaffected.

13. **Managed bracket bookkeeping rides the plugin-record channel, not new event types.**
    The host's reopen validator admits only `KNOWN_SESSION_EVENT_TYPES` or events marked
    `ignorable: true`, and out-of-repo plugin types are outside the known set by
    construction (`packages/core/session` validator comment; observed live on 0.2.2-rc.1 —
    a session carrying a plugin's own non-ignorable event type refuses to reopen). The
    bracket nodes (`mc/manage-start`/`end`) are therefore appended as ignorable plugin
    records — one declared name `plugin:magic-context/manage`, bracket end carried in the
    payload's `kind` — which any build retains and skips and which never enter the surface
    (they never did). Host docs scope plugin records to experimental packages; the
    restriction is a repo-internal gate with no runtime enforcement, and the ignorable
    marker is the documented compatibility mechanism for out-of-repo plugin events.

## Not applicable on DSH (host lacks or does not need the surface)

- **v1 scope — transcript FTS indexing not wired.** The core `message_history_index`/FTS pipeline
  is driven by OpenCode per-message hooks (`message-index-async.ts`); DSH has no equivalent
  message-committed hook wired in v1, so `message_history_index` stays empty for DSH sessions and
  raw-transcript full-text recall is not available. Memory capture, recall, and the whole V3
  cross-harness path are unaffected (proven live: both directions read/write the shared
  `memories` store). Flagged for a follow-up pass; not a parity gap against the *managed* surface.
- Local token estimation: DSH ships a token meter that prices routed models; MC reads the
  meter instead of re-tokenizing (same thresholds — no config divergence).
