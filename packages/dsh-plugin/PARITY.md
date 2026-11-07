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
10. **v1 scope — head renders guidance + compartments + facts + project memory +
    temporal ranges.** The head block is built through the same core renderers as the
    full injection pipeline (`buildCompartmentBlock` with the memory block, budget trim,
    rendered-id capture and cache snapshot, plus date ranges resolved from durable-log
    timestamps), so `ctx_search` hard-filtering behaves identically. What remains
    deferred is the v2 tiered render (P1–P4 aging) and the mural: the DSH historian
    publishes one flat P1-style compartment per fold with a minimal summarizer prompt
    (the core compartment prompt targets agent runners) and no memory promotion — tier
    aging is dreamer-maintained work and rides entry 14. Not a host-forced gap: flagged
    for a follow-up pass, applies equally to every harness once the dreamer lane runs.
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

 14. **Declared — dreamer maintenance does not run on DSH (v1).** The core dreamer is a
     host-driven maintenance lane: `features/magic-context/dreamer/` schedules its passes
     through the OpenCode plugin lifecycle (`cron.ts`) and runs them as hidden *host
     sessions* (the host forks a conversation and the dreamer prompt steers it) — a surface
     DSH does not offer at that seam: there is no session-fork API, and a plugin cannot
     spawn a durable conversation without user-visible surface effects. The decided
     follow-up mechanism (plan `sessions/` decision) is an aux-model lane: a scheduler off
     the pre-step pass running `ctx.llm.stream()` directly (the historian summarizer's
     shape), keyed off the historian cadence, reusing the core classify/curate/verify
     prompts unchanged. Effect on DSH-only fleets: compartment tier aging, memory
     promotion/curation and expiry sweeps do not run — memories stay exactly as tools and
     folds wrote them. Cross-harness fleets are unaffected in the read direction: DSH
     sessions render and search what an OpenCode dreamer maintains (shared store).
     Declared per spec edge case 3 ("silence is not an option"), not silently skipped.

15. **Resolved — assistant-body reduction is available (projection lane).** The v1 plan
    treated edits *inside* an assistant message as host-blocked (a replacement must cite
    every shadowed node, and `assistant/message` forbids `sourceEventSeqs`). That is true
    of the surface REPLACE path, and false of the host's message-projection seam: an
    ignorable, plugin-owned event plus a registered pure interpreter
    (`ctx.sessions.registerMessageProjection`) rewrites an existing message's content
    without changing node membership or identity (`packages/core/session/src/surface.ts`:
    `planSurfaceEvent` consults registered projections before `surfaceOp`;
    `applySurfacePlan`'s `kind:"project"` branch). The rewrite is durable while the
    plugin is loaded and degrades to the original content — never a refusal — when it is
    not, because unknown ignorable events are skipped by the reopen validator. Evidence:
    `specs/002-dsh-full-parity/gate-evidence/spike-projection.md`,
    `packages/dsh-plugin/test/projection.test.ts`. Consequence: reasoning clearing,
    caveman compression of assistant prose and injection stripping inside assistant
    content are all expressible; the previous "not applicable" class is withdrawn.

16. **DSH-imposed — a subagent at the refuse wall takes one historian fold.** When a
    child session is at the wall and no open reclaim lane can act (no queued drops, no
    aged tool output, nothing superseded), the adapter runs one fold instead of refusing
    the step. The fold PRESERVES the content as a summary rather than deleting it, and it
    costs one aux model call. Rationale: a child has no user to negotiate with and its
    caller is blocked on the answer; refusing would deadlock the delegation. On the other
    harnesses the child's request is rewritten in place, so this situation does not
    arise. Evidence: `src/pressure/lanes.ts` (refuse band, subagent branch),
    `src/lanes/emergency.ts`, `test/us1-emergency.test.ts`.

17. **DSH-imposed — reductions are per-node edits, never a span.** A queued drop edits
    each target node on its own: a tool result is rewritten in place (content only,
    identity and tool pairing preserved), a user message is replaced one-for-one, and an
    assistant body goes through the projection lane (entry 15). The earlier v1
    implementation collapsed a drop cluster into one `user/message` replacement covering
    `min…max`, which swallowed every unrelated node between two targets. The host
    permits the span, but the transcript harm is not host-forced, so the coarse form was
    a defect rather than a divergence. Evidence: `src/surface/node-ops.ts`,
    `test/node-ops.test.ts`, `test/us1-long-session.test.ts`.

## Resolved since the v1 ledger was written

- **Transcript FTS indexing — wired through the pass lane (T045).** The core
  `message-index-async.ts` pipeline needs a message-committed hook; DSH has none, so the
  pass feeds it instead: after each pass projects the log, the adapter reconciles the
  projected messages (append-only revision = projected length) and incrementally schedules
  every newly projected message. `ctx_search`'s history lane answers on DSH sessions; the
  rows carry `harness='dsh'`. The two coordinate systems are distinct: FTS rows store
  projection-position ordinals (renumbered by folds), while compartments store durable
  surface seqs — which is why the lane gates by visibility, not by boundary (next bullet).
- **History-lane boundary gate is visibility-based on DSH (T046).** Core gates the raw
  history lane with `message_ordinal ≤ lastCompartmentEnd`, sound where ordinals and
  boundaries share one domain (OpenCode's message list). On DSH the stored ordinals are
  stale snapshot positions once a fold shadows messages out, so no cutoff value names the
  live tail. The wrapper instead searches all indexed messages and passes core's
  `liveMessageGate`, which suppresses hits whose message id is still on the session
  surface (the same intent issue #131 protects). Consequence: the "already in your
  context" note fires from live-visibility suppression; on other harnesses it still
  counts cutoff-suppressed rows.
- Local token estimation: DSH ships a token meter that prices routed models; MC reads the
  meter instead of re-tokenizing (same thresholds — no config divergence).
