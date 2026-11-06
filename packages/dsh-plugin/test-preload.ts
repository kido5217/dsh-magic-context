// Test-isolation guard — runs ONCE before any test file is imported (wired via
// bunfig.toml `[test] preload`). Forces XDG data home to a throwaway temp tree
// so no test can read or migrate the user's real shared cortexkit DB
// (~/.local/share/cortexkit/magic-context/context.db), which this adapter
// shares with OpenCode/Pi via the core's getDataDir() =
// `XDG_DATA_HOME ?? ~/.local/share`. MAGIC_CONTEXT_STORAGE_DIR pins the store
// below the temp root so no per-test override can escape isolation. Same
// discipline as packages/plugin and packages/pi-plugin (2026-06-01 incident).
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "dsh-mc-test-"));
process.env.XDG_DATA_HOME = join(root, "share");
process.env.XDG_CONFIG_HOME = join(root, "config");
process.env.MAGIC_CONTEXT_STORAGE_DIR = join(root, "share", "cortexkit", "magic-context");

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});
