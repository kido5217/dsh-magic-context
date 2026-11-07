/**
 * DSH doctor.
 *
 * The DSH host ships no plugin doctor, and a bundle that fails its
 * `engines.dsh` fence mounts NOTHING while its profile row remains — a silent
 * failure. So every DSH-specific way this install can quietly break gets an
 * explicit check here:
 *
 *   - `dsh` binary present, version inside the supported range;
 *   - profile bundle rows (dependency + `dsh.profile.bundles`) present;
 *   - the installed bundle's `engines.dsh` fence satisfied by the detected
 *     host version — i.e. the bundle is NOT headed for `skippedBundles`
 *     (bundle files read from the profile's node_modules under $DSH_HOME when
 *     present; skipped with a note when the host never installed them);
 *   - shared store writable + schema fence healthy (shared CLI helpers);
 *   - exactly one compaction engine (profile patch may re-enable
 *     compaction-basic, which the bundle disables);
 *   - duplicate-install detection (doubled bundle rows / multi-section deps);
 *   - plugin log freshness.
 *
 * Safe fixes (behind the existing `--fix` convention): add missing bundle rows
 * to the selected profile. Everything else is reported for a manual fix.
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import { SqliteRuntimeUnavailableError } from "@magic-context/core/shared/sqlite";
import {
    DSH_PACKAGE_NAME,
    DSH_PACKAGE_SOURCE,
    DSH_SUPPORTED_RANGE,
    type DshProfileInfo,
    detectDshBinary,
    ensureDshBundleRow,
    getDshBundleInstallDir,
    getDshProfileDir,
    getDshProfileFlag,
    getDshVersion,
    listDshProfiles,
    readDshBundleEntryState,
    readDshCompactionState,
    readInstalledBundleEngines,
    satisfiesDshRange,
} from "../adapters/dsh";
import { openExistingContextDatabase } from "../lib/database-access";
import { getMagicContextLogPath } from "../lib/paths";
import { type PromptIO, promptIO } from "../lib/prompts";
import {
    checkStorageVersionFence,
    formatStorageVersions,
    readStorageVersions,
} from "../lib/storage-versions";

type CheckStatus = "pass" | "warn" | "fail" | "info";

interface CheckResult {
    status: CheckStatus;
    message: string;
}

export interface RunDshDoctorOptions {
    argv: string[];
    fix?: boolean;
    prompts?: PromptIO;
}

const STALE_LOG_MS = 7 * 24 * 60 * 60 * 1000;

function check(status: CheckStatus, message: string): CheckResult {
    return { status, message };
}

/**
 * The profiles to diagnose: the explicit `--profile`, else every profile that
 * carries the bundle (the "which profiles carry the bundle" report doubles as
 * the no-flag result).
 */
function selectProfiles(
    argv: string[],
    results: CheckResult[],
): { profile: string | null; profiles: DshProfileInfo[] } {
    const all = listDshProfiles();
    const flag = getDshProfileFlag(argv);
    if (flag !== null) {
        if (!existsSync(getDshProfileDir(flag))) {
            results.push(
                check(
                    "fail",
                    `Profile "${flag}" not found under $DSH_HOME/profiles (found: ${
                        all.map((p) => p.name).join(", ") || "none"
                    }).`,
                ),
            );
            return { profile: null, profiles: [] };
        }
        const entry = all.find((p) => p.name === flag);
        return { profile: flag, profiles: entry ? [entry] : [] };
    }
    const carrying = all.filter((p) => p.hasBundleEntry);
    if (carrying.length === 0) {
        results.push(
            check(
                "fail",
                `No profile carries ${DSH_PACKAGE_NAME}. Run \`setup --harness dsh --profile <name>\` (${
                    all.map((p) => p.name).join(", ") || "no profiles yet"
                }).`,
            ),
        );
        return { profile: null, profiles: [] };
    }
    for (const p of carrying) {
        results.push(
            check("info", `Profile "${p.name}" carries the bundle (spec: ${p.bundleSpec}).`),
        );
    }
    // Checks that need ONE profile use the first carrier; the flag picks
    // precisely, matching setup's rule.
    return { profile: carrying[0]?.name ?? null, profiles: carrying };
}

function checkBundleRows(
    profile: string,
    fix: boolean | undefined,
    prompts: PromptIO,
    results: CheckResult[],
): void {
    const state = readDshBundleEntryState(profile);
    if (!state.hasBundleEntry) {
        if (fix) {
            const entry = ensureDshBundleRow(profile, DSH_PACKAGE_SOURCE);
            if (entry.ok) {
                prompts.log.success(`--fix: ${entry.message}`);
                results.push(check("pass", `Profile "${profile}": bundle rows repaired.`));
                return;
            }
            results.push(check("fail", `--fix failed: ${entry.message}`));
            return;
        }
        results.push(
            check(
                "fail",
                `Profile "${profile}" is missing the ${DSH_PACKAGE_NAME} ${
                    state.hasDependency && !state.hasBundleRow
                        ? "`dsh.profile.bundles` row"
                        : state.hasBundleRow && !state.hasDependency
                          ? "dependency row"
                          : "dependency + bundle rows"
                } in its package.json (fix: setup --harness dsh --profile ${profile}, or doctor --fix).`,
            ),
        );
        return;
    }
    if (state.bundleRowCount > 1) {
        results.push(
            check(
                "fail",
                `Profile "${profile}": ${state.bundleRowCount} duplicate ${DSH_PACKAGE_NAME} rows in dsh.profile.bundles — the host loads the bundle once but the manifest is corrupted (deduplicate by hand).`,
            ),
        );
        return;
    }
    if (state.duplicateDependencySpecs.length > 0) {
        results.push(
            check(
                "fail",
                `Profile "${profile}": ${DSH_PACKAGE_NAME} is declared in multiple dependency sections (${state.duplicateDependencySpecs.join(", ")}) — a duplicate install; keep exactly one dependency row.`,
            ),
        );
        return;
    }
    results.push(
        check("pass", `Profile "${profile}": bundle rows present (spec: ${state.bundleSpec}).`),
    );
}

function checkSkippedBundles(
    profile: string,
    hostVersion: string | null,
    results: CheckResult[],
): void {
    const engines = readInstalledBundleEngines(profile);
    if (engines === null) {
        results.push(
            check(
                "info",
                `engines.dsh fence not evaluated for profile "${profile}": no installed bundle package.json under ${getDshBundleInstallDir(profile)} yet (boot the profile or rerun \`dsh plugin --profile ${profile} add ${DSH_PACKAGE_NAME}\`).`,
            ),
        );
        return;
    }
    if (hostVersion === null) {
        results.push(
            check(
                "warn",
                `Cannot verify the ${DSH_PACKAGE_NAME} engines.dsh fence: dsh version unknown.`,
            ),
        );
        return;
    }
    if (satisfiesDshRange(hostVersion, engines)) {
        results.push(
            check(
                "pass",
                `engines.dsh "${engines}" satisfied by dsh ${hostVersion} — bundle will not be skipped.`,
            ),
        );
        return;
    }
    results.push(
        check(
            "fail",
            `Installed bundle declares engines.dsh "${engines}" but the host is dsh ${hostVersion} — the host will SKIP the bundle (skippedBundles) and Magic Context will load nothing. Update the bundle or the host.`,
        ),
    );
}

function checkStore(results: CheckResult[]): void {
    const storeDir = getMagicContextStorageDir();
    if (!existsSync(storeDir)) {
        try {
            mkdirSync(storeDir, { recursive: true });
        } catch {
            results.push(
                check("fail", `Store directory ${storeDir} does not exist and cannot be created.`),
            );
            return;
        }
    }
    try {
        // Writability probe: touch a probe file (cheap, no DB involvement).
        const probe = join(storeDir, ".doctor-dsh-probe");
        writeFileSync(probe, "probe");
        rmSync(probe, { force: true });
    } catch {
        results.push(check("fail", `Store directory ${storeDir} is not writable.`));
        return;
    }
    const dbPath = join(storeDir, "context.db");
    let db: ReturnType<typeof openExistingContextDatabase> = null;
    try {
        db = openExistingContextDatabase(dbPath, { readonly: true });
    } catch (error) {
        if (error instanceof SqliteRuntimeUnavailableError) {
            // Read-only opens of a clean context.db need node:sqlite (or a
            // WAL sidecar). A CLI running on an older Bun can still validate
            // everything else, so this is a skip, not a verdict.
            results.push(
                check(
                    "warn",
                    `Schema fence skipped for ${dbPath}: this runtime cannot open the database read-only (${error.message})`,
                ),
            );
            return;
        }
        results.push(
            check(
                "fail",
                `Schema fence refused ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
        return;
    }
    if (db === null) {
        results.push(
            check("fail", `Shared store missing: ${dbPath} — run \`magic-context setup\` first.`),
        );
        return;
    }
    try {
        const versions = readStorageVersions(db);
        const fence = checkStorageVersionFence(versions);
        if (fence.alarm) results.push(check("fail", fence.message));
        else
            results.push(
                check(
                    "pass",
                    `Store healthy. ${fence.message} (${formatStorageVersions(versions)})`,
                ),
            );
    } catch (error) {
        results.push(
            check(
                "fail",
                `Schema fence check failed for ${dbPath}: ${error instanceof Error ? error.message : String(error)}`,
            ),
        );
    } finally {
        db.close();
    }
}

function checkCompaction(
    profiles: DshProfileInfo[],
    chosenProfile: string | null,
    results: CheckResult[],
): void {
    const targets = chosenProfile ? [chosenProfile] : profiles.map((p) => p.name);
    if (targets.length === 0) return;
    for (const profile of targets) {
        const state = readDshCompactionState(profile);
        if (state === "re-enabled") {
            results.push(
                check(
                    "fail",
                    `Profile "${profile}" re-enables compaction-basic in cordis.patch.yml — two compaction engines would share one context. Remove the override so the bundle's disable row stands.`,
                ),
            );
        } else {
            results.push(
                check(
                    "pass",
                    `Exactly one compaction engine for profile "${profile}" (compaction-basic ${
                        state === "disabled"
                            ? "explicitly disabled by the profile patch"
                            : "disabled by the bundle patch"
                    }).`,
                ),
            );
        }
    }
}

function checkLogFreshness(results: CheckResult[]): void {
    const logPath = getMagicContextLogPath("dsh");
    if (!existsSync(logPath)) {
        results.push(
            check(
                "warn",
                `No Magic Context log yet at ${logPath} — start a DSH session with the bundle loaded.`,
            ),
        );
        return;
    }
    try {
        const age = Date.now() - statSync(logPath).mtimeMs;
        if (age > STALE_LOG_MS) {
            results.push(
                check(
                    "warn",
                    `Magic Context log is ${Math.round(age / 86_400_000)} day(s) old (${logPath}) — the plugin may not be loading.`,
                ),
            );
        } else {
            results.push(check("pass", `Magic Context log is fresh (${logPath}).`));
        }
    } catch {
        results.push(check("warn", `Cannot stat the Magic Context log at ${logPath}.`));
    }
}

export async function runDoctor(options: RunDshDoctorOptions): Promise<number> {
    const { argv } = options;
    const prompts = options.prompts ?? promptIO;
    const results: CheckResult[] = [];

    const binary = detectDshBinary();
    if (!binary) {
        results.push(
            check(
                "fail",
                "dsh binary not found on PATH or in common install locations (install DeepSeek Harness first).",
            ),
        );
    } else {
        results.push(check("pass", `dsh binary found at ${binary.path}`));
    }

    const rawVersion = binary ? getDshVersion(binary.path) : null;
    const hostVersion = rawVersion
        ? (/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(rawVersion)?.[1] ?? null)
        : null;
    if (binary) {
        if (hostVersion === null) {
            results.push(
                check(
                    "warn",
                    "dsh version probe failed — cannot verify the supported-version range.",
                ),
            );
        } else if (satisfiesDshRange(hostVersion, DSH_SUPPORTED_RANGE)) {
            results.push(
                check(
                    "pass",
                    `dsh ${hostVersion} is inside the supported range ${DSH_SUPPORTED_RANGE}.`,
                ),
            );
        } else {
            results.push(
                check(
                    "fail",
                    `dsh ${hostVersion} is outside the supported range ${DSH_SUPPORTED_RANGE} — upgrade the host.`,
                ),
            );
        }
    }

    const { profile, profiles } = selectProfiles(argv, results);
    let effectiveProfiles = profiles;
    if (profile !== null) {
        checkBundleRows(profile, options.fix, prompts, results);
        const entry = listDshProfiles().find((p) => p.name === profile);
        effectiveProfiles = entry ? [entry] : profiles;
        checkSkippedBundles(profile, hostVersion, results);
    }

    checkStore(results);
    checkCompaction(effectiveProfiles, profile, results);
    checkLogFreshness(results);

    // Duplicate-install cross-check: the same bundle version installed under
    // two DIFFERENT profiles is normal (profiles are independent installs);
    // only an intra-profile duplicate (above) is a fault. Nothing further here.

    let failed = 0;
    let warned = 0;
    for (const result of results) {
        const rendered = `[${result.status.toUpperCase()}] ${result.message}`;
        if (result.status === "fail") {
            failed += 1;
            prompts.log.error(rendered);
        } else if (result.status === "warn") {
            warned += 1;
            prompts.log.warn(rendered);
        } else if (result.status === "pass") {
            prompts.log.success(rendered);
        } else {
            prompts.log.info(rendered);
        }
    }
    prompts.note(
        `${results.length - failed - warned} pass, ${warned} warn, ${failed} fail`,
        "DSH doctor",
    );
    return failed > 0 ? 1 : 0;
}
