/**
 * DSH (DeepSeek Harness) adapter.
 *
 * DSH installs Magic Context as a *bundle* inside a per-user profile at
 * `$DSH_HOME/profiles/<name>/` (default `~/.dsh`). Two manifest rows carry the
 * install, and both must be present:
 *
 *   1. the package dependency + bundle row in the profile's `package.json`
 *      (`dependencies["@cortexkit/dsh-magic-context"]` and
 *      `dsh.profile.bundles[]`), and
 *   2. the plugin's own cordis patch layer (shipped inside the bundle) which
 *      inserts the plugin entry and disables the native `compaction-basic`
 *      engine. A profile patch row that re-enables compaction is a conflict:
 *      two compaction engines on one context is a contract violation, so
 *      setup refuses and doctor reports.
 *
 * Unlike Pi/OpenCode there is no implicit "default profile" — every install
 * targets one explicit profile (`--profile` on the command layer,
 * `DSH_PROFILE` for the no-argument adapter contract methods).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import { stringify as stringifyJsonc } from "comment-json";
import { writeFileAtomic } from "../lib/atomic-write";
import { findOnPath, isExecutableFile } from "../lib/find-on-path";
import { readJsoncConfigForUpdate } from "../lib/jsonc-config";
import { envFirstHomeDir, getMagicContextLogPath, isDir } from "../lib/paths";
import type {
    HarnessAdapter,
    HarnessConfigPaths,
    PluginCacheInfo,
    PluginEntryResult,
} from "./types";

/** npm identity of the DSH bundle. */
export const DSH_PACKAGE_NAME = "@cortexkit/dsh-magic-context";
/** Spec used for registry installs (pnpm resolves the bare name from npm). */
export const DSH_PACKAGE_SOURCE = DSH_PACKAGE_NAME;
/**
 * Host versions this bundle supports — mirrors `engines.dsh` in
 * packages/dsh-plugin/package.json. Keep the two in lockstep.
 */
export const DSH_SUPPORTED_RANGE = ">=0.2.2-rc.1 <0.3.0";

export interface DshBinaryInfo {
    path: string;
    source: "path" | "home";
}

interface DshCommandInvocation {
    command: string;
    args: string[];
}

/** Windows command shims are scripts, not executables — run them via ComSpec. */
export function getDshCommandInvocation(dshPath: string, args: string[]): DshCommandInvocation {
    const extension = extname(dshPath).toLowerCase();
    if (extension !== ".cmd" && extension !== ".bat") {
        return { command: dshPath, args };
    }
    const command = process.env.ComSpec?.trim() || process.env.COMSPEC?.trim() || "cmd.exe";
    return { command, args: ["/d", "/s", "/c", dshPath, ...args] };
}

/** `$DSH_HOME`, defaulting to `~/.dsh` (same rule the host uses). */
export function getDshHome(env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env.DSH_HOME?.trim();
    if (fromEnv) return isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
    return join(envFirstHomeDir(), ".dsh");
}

export function getDshProfilesDir(env?: NodeJS.ProcessEnv): string {
    return join(getDshHome(env), "profiles");
}

export function getDshProfileDir(profile: string, env?: NodeJS.ProcessEnv): string {
    return join(getDshProfilesDir(env), profile);
}

/** The profile bundle manifest — dependency + `dsh.profile.bundles` rows. */
export function getDshProfileManifestPath(profile: string, env?: NodeJS.ProcessEnv): string {
    return join(getDshProfileDir(profile, env), "package.json");
}

/** The profile patch layer (`cordis.patch.yml`) applied after all bundle layers. */
export function getDshProfilePatchPath(profile: string, env?: NodeJS.ProcessEnv): string {
    return join(getDshProfileDir(profile, env), "cordis.patch.yml");
}

/**
 * Where the installed bundle's files live for one profile — pnpm materializes
 * the profile's dependencies here, and the bundle's `engines.dsh` fence is
 * read from this package.json by doctor.
 */
export function getDshBundleInstallDir(profile: string, env?: NodeJS.ProcessEnv): string {
    return join(getDshProfileDir(profile, env), "node_modules", ...DSH_PACKAGE_NAME.split("/"));
}

/** Read a `--profile <name>` flag out of an argv list (null when absent). */
export function getDshProfileFlag(argv: string[]): string | null {
    const idx = argv.indexOf("--profile");
    if (idx === -1) return null;
    const value = argv[idx + 1];
    if (!value || value.startsWith("--")) return null;
    return value;
}

/** Every directory under `$DSH_HOME/profiles`, with its bundle state. */
export interface DshProfileInfo {
    name: string;
    dir: string;
    manifestPath: string;
    patchPath: string;
    /** Both the dependency row and the `dsh.profile.bundles` row are present. */
    hasBundleEntry: boolean;
    /** The dependency spec installed for the bundle, when present. */
    bundleSpec: string | null;
}

export function listDshProfiles(env?: NodeJS.ProcessEnv): DshProfileInfo[] {
    const profilesDir = getDshProfilesDir(env);
    if (!isDir(profilesDir)) return [];
    const profiles: DshProfileInfo[] = [];
    for (const name of readdirSync(profilesDir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? [entry.name] : [],
    )) {
        const dir = join(profilesDir, name);
        const state = readDshBundleEntryState(name, env);
        profiles.push({
            name,
            dir,
            manifestPath: getDshProfileManifestPath(name, env),
            patchPath: getDshProfilePatchPath(name, env),
            hasBundleEntry: state.hasBundleEntry,
            bundleSpec: state.bundleSpec,
        });
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function profileHasBundleEntry(profile: string, env?: NodeJS.ProcessEnv): boolean {
    return readDshBundleEntryState(profile, env).hasBundleEntry;
}

export interface DshBundleEntryState {
    hasDependency: boolean;
    hasBundleRow: boolean;
    hasBundleEntry: boolean;
    /** Dependency spec (npm name, `link:…`, `file:…`) when a dependency row exists. */
    bundleSpec: string | null;
    /** Number of times the bundle appears in `dsh.profile.bundles`. */
    bundleRowCount: number;
    /** Spec when the bundle is declared in more than one dependency section. */
    duplicateDependencySpecs: string[];
}

interface ProfileManifestLike {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    optionalDependencies?: Record<string, unknown>;
    dsh?: { profile?: { bundles?: unknown } };
    [k: string]: unknown;
}

/** Read the profile manifest and report the bundle rows without mutating it. */
export function readDshBundleEntryState(
    profile: string,
    env?: NodeJS.ProcessEnv,
): DshBundleEntryState {
    const empty: DshBundleEntryState = {
        hasDependency: false,
        hasBundleRow: false,
        hasBundleEntry: false,
        bundleSpec: null,
        bundleRowCount: 0,
        duplicateDependencySpecs: [],
    };
    const manifest = readProfileManifest(profile, env);
    if (!manifest) return empty;

    const specs: string[] = [];
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
        const spec = manifest[section]?.[DSH_PACKAGE_NAME];
        if (typeof spec === "string") specs.push(spec);
    }
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
        ? (manifest.dsh.profile.bundles as unknown[])
        : [];
    const bundleRowCount = bundles.filter((row) => row === DSH_PACKAGE_NAME).length;
    const hasDependency = specs.length > 0;
    return {
        hasDependency,
        hasBundleRow: bundleRowCount > 0,
        hasBundleEntry: hasDependency && bundleRowCount > 0,
        bundleSpec: specs[0] ?? null,
        bundleRowCount,
        duplicateDependencySpecs: specs.slice(1),
    };
}

/**
 * Add (or repoint) the bundle dependency + `dsh.profile.bundles` row in the
 * profile manifest, preserving every other field, key order, and comments.
 * Idempotent: an existing identical row is `already_present`.
 */
export function ensureDshBundleRow(
    profile: string,
    spec: string = DSH_PACKAGE_SOURCE,
    env?: NodeJS.ProcessEnv,
): PluginEntryResult {
    const manifestPath = getDshProfileManifestPath(profile, env);
    try {
        const manifest = readJsoncConfigForUpdate(manifestPath) as ProfileManifestLike;
        const state = inspectManifest(manifest);
        if (state.hasBundleEntry && state.bundleSpec === spec) {
            return {
                ok: true,
                action: "already_present",
                message: `${DSH_PACKAGE_NAME} already registered in profile "${profile}" (${manifestPath}).`,
                configPath: manifestPath,
            };
        }
        const dependencies =
            manifest.dependencies && typeof manifest.dependencies === "object"
                ? manifest.dependencies
                : {};
        const changedSpec = dependencies[DSH_PACKAGE_NAME];
        dependencies[DSH_PACKAGE_NAME] = spec;
        manifest.dependencies = dependencies;

        const dsh =
            manifest.dsh && typeof manifest.dsh === "object"
                ? (manifest.dsh as Record<string, unknown>)
                : {};
        const profileSection =
            dsh.profile && typeof dsh.profile === "object"
                ? (dsh.profile as Record<string, unknown>)
                : {};
        const bundles = Array.isArray(profileSection.bundles)
            ? (profileSection.bundles as unknown[])
            : [];
        if (!bundles.includes(DSH_PACKAGE_NAME)) bundles.push(DSH_PACKAGE_NAME);
        profileSection.bundles = bundles;
        dsh.profile = profileSection;
        manifest.dsh = dsh;

        writeFileAtomic(manifestPath, `${stringifyJsonc(manifest, null, 2)}\n`);
        return {
            ok: true,
            action: changedSpec === undefined || changedSpec === spec ? "added" : "updated",
            message:
                changedSpec === undefined
                    ? `Added ${DSH_PACKAGE_NAME} (${spec}) to profile "${profile}" (${manifestPath}).`
                    : `Repointed ${DSH_PACKAGE_NAME} from "${changedSpec}" to "${spec}" in profile "${profile}" (${manifestPath}).`,
            configPath: manifestPath,
        };
    } catch (err) {
        return {
            ok: false,
            action: "error",
            message: `Failed to update ${manifestPath}: ${(err as Error).message}`,
            configPath: manifestPath,
        };
    }
}

/** Remove the bundle dependency + bundle row from the profile manifest. */
export function removeDshBundleRow(profile: string, env?: NodeJS.ProcessEnv): PluginEntryResult {
    const manifestPath = getDshProfileManifestPath(profile, env);
    try {
        const manifest = readJsoncConfigForUpdate(manifestPath) as ProfileManifestLike;
        let removed = false;
        for (const section of [
            "dependencies",
            "devDependencies",
            "optionalDependencies",
        ] as const) {
            const record = manifest[section];
            if (record && Object.hasOwn(record, DSH_PACKAGE_NAME)) {
                delete record[DSH_PACKAGE_NAME];
                removed = true;
            }
        }
        const profileSection = manifest.dsh?.profile;
        const bundles = profileSection?.bundles;
        if (profileSection && Array.isArray(bundles)) {
            const kept = bundles.filter((row) => row !== DSH_PACKAGE_NAME);
            if (kept.length !== bundles.length) {
                profileSection.bundles = kept;
                removed = true;
            }
        }
        if (!removed) {
            return {
                ok: true,
                action: "already_present",
                message: `${DSH_PACKAGE_NAME} not registered in profile "${profile}" (${manifestPath}).`,
                configPath: manifestPath,
            };
        }
        writeFileAtomic(manifestPath, `${stringifyJsonc(manifest, null, 2)}\n`);
        return {
            ok: true,
            action: "updated",
            message: `Removed ${DSH_PACKAGE_NAME} from profile "${profile}" (${manifestPath}).`,
            configPath: manifestPath,
        };
    } catch (err) {
        return {
            ok: false,
            action: "error",
            message: `Failed to update ${manifestPath}: ${(err as Error).message}`,
            configPath: manifestPath,
        };
    }
}

function readProfileManifest(profile: string, env?: NodeJS.ProcessEnv): ProfileManifestLike | null {
    try {
        const raw = readFileSync(getDshProfileManifestPath(profile, env), "utf-8");
        const parsed = JSON.parse(raw) as unknown;
        return parsed && typeof parsed === "object" ? (parsed as ProfileManifestLike) : null;
    } catch {
        return null;
    }
}

function inspectManifest(manifest: ProfileManifestLike): {
    hasBundleEntry: boolean;
    bundleSpec: string | null;
} {
    const spec = manifest.dependencies?.[DSH_PACKAGE_NAME];
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
        ? (manifest.dsh.profile.bundles as unknown[])
        : [];
    return {
        hasBundleEntry: typeof spec === "string" && bundles.includes(DSH_PACKAGE_NAME),
        bundleSpec: typeof spec === "string" ? spec : null,
    };
}

// ----------------------------------------------------------------------------
// Profile patch analysis (native-compaction conflict)
// ----------------------------------------------------------------------------

/**
 * State of the native `compaction-basic` engine as shaped by the profile's own
 * patch layer (applied after every bundle layer, so it can re-enable what the
 * bundle patch disabled).
 *
 *   "disabled"   — the profile patch explicitly keeps it disabled (`disabled: true`)
 *   "re-enabled" — a profile patch row targets compaction-basic without
 *                  `disabled: true`, i.e. it overrides the bundle's disable row
 *   "absent"     — the profile patch says nothing; the bundle's own disable row decides
 */
export type DshCompactionState = "disabled" | "re-enabled" | "absent";

export function readDshCompactionState(
    profile: string,
    env?: NodeJS.ProcessEnv,
): DshCompactionState {
    return parseDshCompactionState(readFileSyncSafe(getDshProfilePatchPath(profile, env)));
}

/** Parse a profile `cordis.patch.yml` text for compaction-basic rows. Exported for tests. */
export function parseDshCompactionState(patchYaml: string | null): DshCompactionState {
    if (patchYaml === null) return "absent";
    let sawRow = false;
    let sawDisable = false;
    let inTargetEntry = false;

    // The patch format is a top-level YAML sequence of flat patch entries
    // (`- id: …` followed by indented `key: value` lines). A tiny line-based
    // scan is enough to answer the only question we ask: does any entry target
    // compaction-basic, and does it carry `disabled: true`?
    for (const rawLine of patchYaml.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+$/, "");
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        if (/^- /.test(line)) {
            inTargetEntry = /^-\s+id:\s*["']?compaction-basic["']?\s*$/.test(line);
            if (inTargetEntry) sawRow = true;
            continue;
        }
        if (/^\s+/.test(line)) {
            if (!inTargetEntry) continue;
            if (/^(disabled|enabled)\s*:\s*true\b/.test(trimmed)) sawDisable = true;
            continue;
        }
        inTargetEntry = false;
    }

    if (!sawRow) return "absent";
    return sawDisable ? "disabled" : "re-enabled";
}

function readFileSyncSafe(path: string): string | null {
    try {
        return readFileSync(path, "utf-8");
    } catch {
        return null;
    }
}

// ----------------------------------------------------------------------------
// Version fence (small semver subset — no dependency on `semver`)
// ----------------------------------------------------------------------------

interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    prerelease: string[] | null;
}

export function parseDshVersion(text: string): ParsedVersion | null {
    const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] ? match[4].split(".") : null,
    };
}

function comparePrereleaseId(a: string, b: string): number {
    const aNum = /^\d+$/.test(a);
    const bNum = /^\d+$/.test(b);
    if (aNum && bNum) return Number(a) - Number(b);
    if (aNum) return -1; // numeric identifiers rank below alphanumeric ones
    if (bNum) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver compare with prerelease rules. Returns null when either side is unparseable. */
export function compareDshVersions(a: string, b: string): number | null {
    const left = parseDshVersion(a);
    const right = parseDshVersion(b);
    if (!left || !right) return null;
    for (const field of ["major", "minor", "patch"] as const) {
        if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
    }
    if (!left.prerelease && !right.prerelease) return 0;
    if (!left.prerelease) return 1; // a release outranks any prerelease
    if (!right.prerelease) return -1;
    for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
        const l = left.prerelease[i];
        const r = right.prerelease[i];
        if (l === undefined && r === undefined) return 0;
        if (l === undefined) return -1; // shorter set ranks lower
        if (r === undefined) return 1;
        const cmp = comparePrereleaseId(l, r);
        if (cmp !== 0) return cmp;
    }
    return 0;
}

/**
 * Evaluate a space-separated `engines.dsh`-style range (`>=x.y.z <a.b.c`,
 * single comparators, optional `=`) against a concrete version. Unparseable
 * inputs return false — the caller reports "cannot verify" rather than guessing.
 */
export function satisfiesDshRange(version: string, range: string): boolean {
    const comparators = range
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0);
    if (comparators.length === 0) return false;
    for (const part of comparators) {
        const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(part);
        if (!match) return false;
        const op = match[1] ?? "=";
        const cmp = compareDshVersions(version, match[2] ?? "");
        if (cmp === null) return false;
        const ok =
            (op === ">=" && cmp >= 0) ||
            (op === "<=" && cmp <= 0) ||
            (op === ">" && cmp > 0) ||
            (op === "<" && cmp < 0) ||
            (op === "=" && cmp === 0);
        if (!ok) return false;
    }
    return true;
}

// ----------------------------------------------------------------------------
// Binary detection / commands
// ----------------------------------------------------------------------------

/**
 * Find the `dsh` binary: PATH first (Node-only walker, same reasoning as the
 * Pi helper), then common user-level install locations.
 */
export function detectDshBinary(env: NodeJS.ProcessEnv = process.env): DshBinaryInfo | null {
    const fromPath = findOnPath("dsh");
    if (fromPath) return { path: fromPath, source: "path" };

    const candidates = [
        join(getDshHome(env), "bin", "dsh"),
        join(envFirstHomeDir(), ".local", "bin", "dsh"),
    ];
    for (const candidate of candidates) {
        if (isExecutableFile(candidate)) return { path: candidate, source: "home" };
    }
    return null;
}

/** `dsh --version` output (e.g. `0.2.2-rc.1`); null when the probe fails. */
export function getDshVersion(dshPath: string): string | null {
    try {
        const invocation = getDshCommandInvocation(dshPath, ["--version"]);
        const result = spawnSync(invocation.command, invocation.args, {
            windowsHide: true,
            encoding: "utf-8",
            timeout: 10_000,
            // Same as Node's default inheritance; spelled explicitly because
            // some runtimes (Bun's test runner) hand children a stale env
            // snapshot, silently hiding DSH_HOME overrides.
            env: { ...process.env },
        });
        const stdout = result.stdout?.trim();
        if (stdout) return stdout;
        const stderr = result.stderr?.trim();
        if (stderr) return stderr;
        return null;
    } catch {
        return null;
    }
}

/** Run a dsh subcommand, returning trimmed stdout; null on any failure. */
export function runDshCommand(dshPath: string, args: string[], timeout = 120_000): string | null {
    try {
        const invocation = getDshCommandInvocation(dshPath, args);
        const result = spawnSync(invocation.command, invocation.args, {
            windowsHide: true,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout,
            env: { ...process.env },
        });
        if (result.error || result.status !== 0) return null;
        return result.stdout?.trim() ?? "";
    } catch {
        return null;
    }
}

/** Host install command for one profile (`dsh plugin --profile <p> add <spec>`). */
export function dshPluginAddArgs(profile: string, spec: string): string[] {
    return ["plugin", "--profile", profile, "add", spec];
}

function newestVersion(a: string, b: string): string {
    const cmp = compareDshVersions(a, b);
    if (cmp === null) return a;
    return cmp >= 0 ? a : b;
}

/**
 * Latest bundle version installed in any profile's node_modules (the DSH
 * "bundle cache" for this install layout).
 */
export function getDshInstalledBundleVersions(env?: NodeJS.ProcessEnv): string[] {
    const versions: string[] = [];
    for (const profile of listDshProfiles(env)) {
        const version = readInstalledBundleVersion(profile.name, env);
        if (version) versions.push(version);
    }
    return versions;
}

/** The installed bundle's version for one profile, or null when not on disk. */
export function readInstalledBundleVersion(
    profile: string,
    env?: NodeJS.ProcessEnv,
): string | null {
    try {
        const pkg = JSON.parse(
            readFileSync(join(getDshBundleInstallDir(profile, env), "package.json"), "utf-8"),
        ) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
        return null;
    }
}

/** The installed bundle's `engines.dsh` range for one profile, or null. */
export function readInstalledBundleEngines(
    profile: string,
    env?: NodeJS.ProcessEnv,
): string | null {
    try {
        const pkg = JSON.parse(
            readFileSync(join(getDshBundleInstallDir(profile, env), "package.json"), "utf-8"),
        ) as { engines?: Record<string, unknown> };
        const range = pkg.engines?.dsh;
        return typeof range === "string" ? range : null;
    } catch {
        return null;
    }
}

// ----------------------------------------------------------------------------
// Adapter
// ----------------------------------------------------------------------------

export class DshAdapter implements HarnessAdapter {
    readonly kind = "dsh" as const;
    readonly displayName = "DSH";
    readonly pluginPackageName = DSH_PACKAGE_NAME;

    isInstalled(): boolean {
        return detectDshBinary() !== null;
    }

    /**
     * With `DSH_PROFILE` set, that profile decides; otherwise the plugin is
     * considered registered when ANY profile carries the bundle rows.
     */
    hasPluginEntry(): boolean {
        const profile = process.env.DSH_PROFILE?.trim();
        if (profile) return profileHasBundleEntry(profile);
        return listDshProfiles().some((entry) => entry.hasBundleEntry);
    }

    getConfigPaths(): HarnessConfigPaths {
        const profile = process.env.DSH_PROFILE?.trim();
        const profilesDir = getDshProfilesDir();
        return {
            configDir: profilesDir,
            // DSH has no single plugin config file — registration lives per
            // profile. Point at the named profile's manifest when we have one,
            // else at the profiles root where every manifest lives.
            pluginConfigPath: profile
                ? getDshProfileManifestPath(profile)
                : join(profilesDir, "<profile>", "package.json"),
            magicContextConfigPath: resolveCortexKitUserConfigPath(),
            secondaryConfigPath: profile ? getDshProfilePatchPath(profile) : null,
        };
    }

    async ensurePluginEntry(): Promise<PluginEntryResult> {
        const profile = this.requireProfile();
        if (!profile) return DshAdapter.noProfileResult(join(getDshProfilesDir(), "*"));
        return ensureDshBundleRow(profile, DSH_PACKAGE_SOURCE);
    }

    async removePluginEntry(): Promise<PluginEntryResult> {
        const profile = this.requireProfile();
        if (!profile) return DshAdapter.noProfileResult(join(getDshProfilesDir(), "*"));
        return removeDshBundleRow(profile);
    }

    getInstallHint(): string {
        return "Install DeepSeek Harness so the `dsh` binary is on PATH (npm: @deepseek-ai/dsh — see the DSH documentation).";
    }

    getPluginCacheInfo(): PluginCacheInfo[] {
        // A profile's node_modules is a pnpm install, not a disposable cache —
        // `doctor --clear` removing it would silently unregister the bundle.
        // Reporting "no cache" keeps the picker honest.
        return [{ path: null, exists: false, sizeBytes: 0 }];
    }

    getLogPath(): string {
        return getMagicContextLogPath("dsh");
    }

    getInstalledPluginVersion(): string | null {
        let newest: string | null = null;
        for (const version of getDshInstalledBundleVersions()) {
            newest = newest === null ? version : newestVersion(newest, version);
        }
        return newest;
    }

    private requireProfile(): string | null {
        const profile = process.env.DSH_PROFILE?.trim();
        if (!profile) return null;
        if (!existsSync(join(getDshProfilesDir(), profile))) return null;
        return profile;
    }

    private static noProfileResult(configPath: string): PluginEntryResult {
        return {
            ok: false,
            action: "error",
            message:
                "DSH has no default profile: set DSH_PROFILE to the profile to configure (profiles live under the profiles directory).",
            configPath,
        };
    }
}
