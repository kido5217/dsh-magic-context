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
   protected-tail all key on seq.
9. **DSH-imposed — protected-tail budget halves on emergency passes.** With the core's
   request-time protections (`protected_tokens`, `history_budget_percentage`) mapped onto
   the routed window, a force/refuse pass halves the verbatim budget so pressure can still
   find a foldable window; on request-transform harnesses the same protections apply per
   request without a fold-time tension.
10. **Resolved — the head renders the full injection pipeline.** The head ships guidance,
    tiered history (P1–P4 through the shared m[0]/m[1] builder), project memory, project docs,
    temporal ranges and the capability-gated mural, all through the core renderers; the
    three-segment identity fingerprint covers baseline, model key and fold epoch. See
    "Resolved since the v1 ledger".

11. **Resolved — `/compact` runs an MC fold.** The claim's `compactNow`/`compactRegion`
    delegate to `createMcFold`: historian fold over the live projection, the host-mandated
    durable shape (`compaction/start`, `compaction/summary`, exactly ONE checkpoint-bearing
    surface replacement, `compaction/end`), a full `CompactionResult` with real seqs, and a
    busy guard shared with pressure folds. Evidence: `src/compaction-fold.ts`,
    `test/compaction-fold.test.ts`.

12. **Resolved — tools bind per agent.** Tool handlers resolve the invoking agent's session
    (per-agent binding, T018), not a mount-wide "most recently attached" guess; concurrent
    multi-agent mounts route correctly. Evidence: `test/us2-tools.test.ts`.

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

 14. **Resolved — the dreamer maintenance lane runs on DSH.** The host-session-fork premise
    was replaced by the decided aux-model mechanism, now shipped: one adapter scheduler
    (interval + `ctx.effect` disposer; cordis has no `ctx.interval` service in 0.2.2-rc.1)
    drives the core task logic unchanged over two hidden carriers (single-shot
    `ctx.llm.stream` and a hidden maintenance agent with the tool-loop transport), leases,
    retry caps and `dream_runs` rows included; `dreamer.dsh` takes precedence over
    `dreamer.pi` (schema field added upstream-ably). Evidence: `src/maintenance/`,
    `test/maintenance-*.test.ts`, `test/live-v5.test.ts`, `gate-evidence/v5-maintenance/`.

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
    `src/lanes/emergency.ts`, `test/us1-emergency.test.ts`, and the live proof
    `test/live-v2.test.ts` (a real `dsh` child at the wall folds: a compartment on the
    `is_subagent=1` session and a request-only historian call observed on the wire).

17. **DSH-imposed — reductions are per-node edits, never a span.** A queued drop edits
    each target node on its own: a tool result is rewritten in place (content only,
    identity and tool pairing preserved), a user message is replaced one-for-one, and an
    assistant body goes through the projection lane (entry 15). The earlier v1
    implementation collapsed a drop cluster into one `user/message` replacement covering
    `min…max`, which swallowed every unrelated node between two targets. The host
    permits the span, but the transcript harm is not host-forced, so the coarse form was
    a defect rather than a divergence. Evidence: `src/surface/node-ops.ts`,
    `test/node-ops.test.ts`, `test/us1-long-session.test.ts`.

18. **DSH-imposed — provider reasoning is replayed and cannot be dropped by the adapter.**
    The host reconstructs a historical assistant message's reasoning from the message's own
    replay state, not from the content blocks a plugin supplies, so a projection rewrite
    replaces the visible answer while the reasoning that produced it still goes out. The
    core drops reasoning together with the text it answered (`keepReasoning` distinguishes
    the meaning-preserving case); on DSH no seam expresses either choice. Evidence:
    `specs/002-dsh-full-parity/gate-evidence/spike-reasoning-replay.md` (live: the resumed
    request carries `reasoning_content` verbatim), `packages/dsh-plugin/test/reasoning-replay.test.ts`.
    Effect: a session's reasoning is reclaimed only when the host's own retention drops it
    (route/model switch, TTL, a native compaction); MC's contribution is limited to the
    body. Declared rather than silently skipped.

19. **Declared — the local embedding runtime is not shipped in the DSH bundle.** Semantic
    `ctx_search` and auto-search candidates need an embedding index. The core's local provider
    runs Xenova/all-MiniLM-L6-v2 through onnxruntime plus a worker process
    (`embedding-worker-process.ts`), neither of which this package ships: adding the native
    runtime is a packaging change with per-platform binaries, not a code path. The adapter
    therefore triggers the shared backfill only for REMOTE providers (`openai-compatible`,
    `synapse`), where the core already runs the index off-thread over HTTP, and does nothing
    for `local` (the default) — calling it there would fail on every pass instead of doing
    useful work. Effect on a DSH-only machine with default config: hints and semantic search
    stay empty while `memory.enabled` and the keyword/recency lanes work normally. Follow-up:
    ship `embedding-worker-process.js` plus the onnx dependency, or document a remote provider
    in the setup flow. Evidence: `src/pressure/lanes.ts` (`maybeBackfillEmbeddings`),
    `test/us1-assistance.test.ts` (local/off is never triggered).

20. **DSH-imposed — command dispatch is an interactive-surface behavior.** The plugin
    registers the six `ctx-*` commands on the command runtime (hard-injected `commands`
    bundle); the headless app forwards slash text to the model instead of dispatching
    (observed, 0.2.2-rc.1, spike T013). Interactive surfaces dispatch the registered
    handlers; live proof therefore pins registration (`test/live-v6.test.ts`) and handler
    behavior in-process (`test/commands.test.ts`).
21. **DSH-imposed — the maintenance tick is a plain interval.** Cordis exposes no
    `ctx.interval` service in 0.2.2-rc.1 (verified against the composed profile); the lane
    owns a wall-clock interval whose disposer is registered through `ctx.effect`, so fiber
    teardown still stops it. Semantics (quiet window, jitter, lease discipline) are
    unchanged.
22. **DSH-imposed — self-update applies with a host command and needs a restart.** The
    bundle set is fixed at process start, so an applied update reports
    restart-required; provenance rules (dev/pinned installs are never auto-applied) match
    the shared pinning doctrine. Evidence: `src/maintenance/update-check.ts`,
    `test/update-check.test.ts`.
23. **DSH-imposed — `ctx-status` reports `toolDefinitionTokens: 0`.** DSH does not meter
    tool-schema bytes into the shared store, so the status view's tool-definition row is
    zero rather than a lie; every other field is measured from the store or the per-pass
    counters (`persistStatusMeta`).
24. **Declared — git-context (commit-aware) capability is unscoped here.** The core's
    git sweep is owned by other harnesses' host git surfaces; no DSH task exists in 002
    and no host fact forces a DSH arm. Recorded as census ST-10 `missing` with deferred
    ledger DL-3, not silently dropped.

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
