# @cortexkit/dsh-magic-context

Magic Context adapter for the DeepSeek Harness (DSH). A thin host plugin over the shared
transform core (same core as the OpenCode and Pi adapters): self-managing sessions, the five
`ctx_*` knowledge tools, the six `/ctx-*` slash commands, and the shared machine-wide store
with `harness='dsh'` attribution.

- Parity doctrine and every divergence: [PARITY.md](PARITY.md)
- Feature spec, contracts, and validation guide (V1–V7): sidecar repository,
  `specs/001-dsh-harness-support/` (the fork's contributing workspace for this feature)

## Host compatibility

Supported DSH versions are declared in `package.json` as `engines.dsh` — currently
`>=0.2.2-rc.1 <0.3.0` (plugin API as documented in 0.2.2). The DSH plugin-API packages
are declared as `peerDependencies` pinned to the minimum supported host version. Raising
that range (minimum or ceiling) on a breaking DSH API change is itself a recorded
compatibility decision — it lands as a deliberate change here, not a silent dependency bump.

## Configuration

No DSH-only knobs: all behavior is configured through the shared Magic Context configuration
(`~/.config/cortexkit/magic-context.jsonc` + `<project>/.cortexkit/magic-context.jsonc`,
the same file and schema every harness uses; see [CONFIGURATION.md](../../CONFIGURATION.md)).
A config that fails schema validation falls back to the schema defaults with a warning —
the same fail-open posture as the other loaders. The only value read from the DSH plugin
registration itself is the optional `cwd` project hint passed to the plugin entry point.

DSH reads the maintenance model from the `dreamer` block: **`dreamer.dsh` when you wrote
one, otherwise `dreamer.pi`** — both carry the "host without a visible session list"
semantics that DSH's hidden carriers are (see below). Note: the shared schema currently
declares `dreamer.opencode` / `.pi` / `.omp` but not `dreamer.dsh`, so schema validation
strips a `dreamer.dsh` block from the parsed config; today `dreamer.pi` is the effective
block on DSH until the core schema records the `dsh` entry.

## Commands

Six user-facing slash commands, registered through the host command registry and dispatched
by interactive surfaces against the agent that received them:

| Command | What it does |
|---|---|
| `/ctx-status` | Magic Context pressure, history and maintenance state (shared view, DSH-fed counters). |
| `/ctx-flush` | Apply pending context operations (drops, pins) now, bypassing the cache TTL. |
| `/ctx-embed` | `start` kicks this session's compartment embedding backfill; anything else prints usage. With no embeddable runtime for the configured `embedding.provider`, answers honestly that embeddings are off for this project. |
| `/ctx-recomp` | Rebuild the compressed history from the raw session log (full rebuild). |
| `/ctx-wrapup [n]` | Fold the conversation now, keeping the newest `n` messages raw (default 10). |
| `/ctx-dream [task]` | Run maintenance tasks now (all enabled, or one named task). Refuses with `Maintenance is not running for this project` when the lane has no dreamer model block. |

Headless-dispatch caveat: the adapter registers all six commands even in a headless boot
(the mount prints `commands registered: …` to stderr as the proof), but slash-command
**dispatch is surface-side** — a headless run has no interactive surface to dispatch them,
so the handlers only run when an interactive surface sends the command.

## Compaction coexistence (`/compact`)

While Magic Context manages a session, exactly one provider folds it. The adapter supplies
the `ctx.compaction` backend (`McCompactionClaim`, a sanctioned `CompactionEngine`
subclass); the bundle patch (`cordis.patch.yml`) disables the host's `compaction-basic`
row so no second engine shares the slot. Policy: automatic pressure triggers on managed
sessions are deferred (Magic Context folds through its own lane pass, and the deferral is
logged); an explicit `/compact` (`compactNow`) or region compaction on a managed session
performs one real Magic Context fold — the same bracketed fold the pass would do, serialized
against `/ctx-recomp`/`/ctx-wrapup`; non-managed sessions are no-ops.

## Maintenance lane (dreamer)

Background maintenance runs on two hidden DSH carriers (single-shot aux completions for
one-shot tasks, a hidden parentless agent for tool-loop tasks) driven by the shared core
task logic. The lane starts only when a dreamer model block enables it: `dreamer.dsh`
preferred, `dreamer.pi` fallback, and not disabled (see the schema caveat under
Configuration).

The hidden tool-loop agent gets a fixed tool allowlist —
`["read", "grep", "glob", "edit", "write", "ctx_memory", "ctx_search"]`
(`DEFAULT_MAINTENANCE_TOOLS`). `bash` is deliberately excluded: the carrier is a parentless
session with no user who could approve arbitrary command execution, and no dream task
needs a shell — file reads, searches, edits, writes and the two knowledge tools cover the
task set, so the background lane stays side-effect-scoped to the project files and the
Magic Context store.

The npm update check rides the lane start (one check per boot, announced through the core
log, always restart-required, applied via `dsh plugin --profile <name> add <pkg>@<version>`).
It honors `auto_update: false` and never applies to dev (`link:`/`file:`) or user-pinned
installs.

## Test-only environment seams

These variables are seams for the test suite and the live-gate runs; none of them is set
in production use.

| Variable | Effect |
|---|---|
| `MAGIC_CONTEXT_TEST_NO_QUIET=1` | Drops the maintenance mount's fixed boot-quiet period to 0 (pure latency for live evidence runs). |
| `MAGIC_CONTEXT_TEST_TICK_MS` | Maintenance scheduler tick interval in ms. |
| `MAGIC_CONTEXT_TEST_JITTER_MS` | Maintenance scheduler jitter slot in ms. |
| `MAGIC_CONTEXT_TEST_DATA_DIR` | Storage isolation marker honored by the core's data-path resolver (set by the test preloads); it additionally suppresses the npm update check so no test mount touches the network or the real bundle cache. |
| `MAGIC_CONTEXT_NO_AUTO_UPDATE=1` | User-facing opt-out: never run the npm update check (also implied by the test marker above). |

## Configuration-key parity, mechanically

`test/config-parity.test.ts` scans `src/` for every config-key read and asserts each maps
to the shared schema (or is a documented host plugin option), so a future DSH-only knob
fails CI until it is either moved into the shared schema or recorded as a decision.
