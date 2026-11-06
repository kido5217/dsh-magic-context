# @cortexkit/dsh-magic-context

Magic Context adapter for the DeepSeek Harness (DSH). A thin host plugin over the shared
transform core (same core as the OpenCode and Pi adapters): self-managing sessions, the five
`ctx_*` knowledge tools, and the shared machine-wide store with `harness='dsh'` attribution.

- Parity doctrine and every divergence: [PARITY.md](PARITY.md)
- Feature spec, contracts, and validation guide (V1–V7): sidecar repository,
  `specs/001-dsh-harness-support/` (the fork's contributing workspace for this feature)

## Host compatibility

Supports DSH host **0.2.x** (plugin API as documented in 0.2.2). The DSH plugin-API packages
are declared as `peerDependencies` pinned to the minimum supported host version. Raising that
minimum on a breaking DSH API change is itself a recorded compatibility decision — it lands
as a deliberate change here, not a silent dependency bump.

## Configuration

No DSH-only knobs: all behavior is configured through the shared Magic Context configuration
(the same file and schema every harness uses).
