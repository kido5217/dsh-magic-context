/**
 * DSH setup flow.
 *
 * Deliberately leaner than the Pi/OpenCode wizards: the shared Magic Context
 * config (historian/dreamer/embedding) is harness-independent and already
 * written by any other harness's wizard, and DSH has no model-list seam to
 * offer here. What IS DSH-specific and lives here:
 *
 *   - an explicit `--profile` (there is no default profile; a wrong profile
 *     silently means "bundle never loads"),
 *   - install through the host command (`dsh plugin --profile <p> add <spec>`)
 *     so pnpm + the host reconcile dependencies and bundle rows, falling back
 *     to direct manifest rows when the host command is unavailable,
 *   - a dev `link:` install (`--link <dir>`),
 *   - the native-compaction conflict check (the bundle disables compaction-basic
 *     itself; a profile patch row that re-enables it is refused).
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
    DSH_PACKAGE_NAME,
    DSH_PACKAGE_SOURCE,
    DSH_SUPPORTED_RANGE,
    detectDshBinary,
    dshPluginAddArgs,
    ensureDshBundleRow,
    getDshHome,
    getDshProfileDir,
    getDshProfileFlag,
    getDshVersion,
    listDshProfiles,
    profileHasBundleEntry,
    readDshCompactionState,
    runDshCommand,
    satisfiesDshRange,
} from "../adapters/dsh";
import { type PromptIO, promptIO } from "../lib/prompts";

export interface RunDshSetupOptions {
    argv: string[];
    prompts?: PromptIO;
    dryRun?: boolean;
}

function formatProfileList(): string {
    const profiles = listDshProfiles();
    if (profiles.length === 0) {
        return `no profiles exist yet under ${join(getDshHome(), "profiles")} — boot \`${"dsh --profile <name> --dump-config"}\` once to create one`;
    }
    return `available profiles: ${profiles.map((profile) => profile.name).join(", ")}`;
}

function resolveInstallSpec(argv: string[]): { spec: string; error?: string } {
    const linkIdx = argv.indexOf("--link");
    if (linkIdx === -1) return { spec: DSH_PACKAGE_SOURCE };
    const value = argv[linkIdx + 1];
    if (!value || value.startsWith("--")) {
        return { spec: "", error: "--link needs a directory containing the dsh plugin package." };
    }
    const dir = isAbsolute(value) ? value : resolve(process.cwd(), value);
    if (!existsSync(dir)) {
        return { spec: "", error: `--link directory does not exist: ${dir}` };
    }
    let name: unknown;
    try {
        name = (
            JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as Record<string, unknown>
        ).name;
    } catch {
        return { spec: "", error: `--link directory has no readable package.json: ${dir}` };
    }
    if (name !== DSH_PACKAGE_NAME) {
        return {
            spec: "",
            error: `--link directory is "${name ?? "unnamed"}", not ${DSH_PACKAGE_NAME}.`,
        };
    }
    return { spec: `link:${dir}` };
}

export async function runSetup(options: RunDshSetupOptions): Promise<number> {
    const { argv } = options;
    const prompts = options.prompts ?? promptIO;
    const dryRun = options.dryRun === true;

    if (dryRun) prompts.log.warn("Dry run — no files will be written and no install will run.");

    const binary = detectDshBinary();
    if (!binary) {
        prompts.log.error(
            "Could not find the `dsh` binary on PATH or in common install locations.",
        );
        prompts.log.message(
            "Install DeepSeek Harness first, then rerun setup. (DSH_HOME is read from the environment; default ~/.dsh.)",
        );
        return 1;
    }
    const version = getDshVersion(binary.path);
    if (version) {
        const clean = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(version)?.[1] ?? version;
        if (!satisfiesDshRange(clean, DSH_SUPPORTED_RANGE)) {
            prompts.log.error(
                `dsh ${clean} is outside the supported range ${DSH_SUPPORTED_RANGE} — ` +
                    `the host would skip the ${DSH_PACKAGE_NAME} bundle (engines.dsh fence).`,
            );
            return 1;
        }
        prompts.log.info(`dsh ${clean} detected at ${binary.path}`);
    } else {
        prompts.log.warn(`dsh detected at ${binary.path}, but the version probe failed.`);
    }

    const profile = getDshProfileFlag(argv);
    if (!profile) {
        prompts.log.error(
            `A DSH profile must be given explicitly with --profile <name> — DSH has no default profile. ${formatProfileList()}.`,
        );
        return 1;
    }
    if (!existsSync(getDshProfileDir(profile))) {
        prompts.log.error(
            `Profile "${profile}" not found under ${join(getDshHome(), "profiles")}. ${formatProfileList()}.`,
        );
        return 1;
    }

    // Conflict check BEFORE touching anything: the bundle's own patch layer
    // disables the native compaction-basic engine; a profile patch row that
    // re-enables it would put two compaction engines on one context.
    const compaction = readDshCompactionState(profile);
    if (compaction === "re-enabled") {
        prompts.log.error(
            `Profile "${profile}" re-enables the native compaction-basic engine in its cordis.patch.yml. ` +
                `Magic Context owns folding and ships a disable row for compaction-basic; two engines are a contract violation. ` +
                `Remove the compaction-basic override (or set \`disabled: true\` on it) and rerun setup.`,
        );
        return 1;
    }

    const { spec, error } = resolveInstallSpec(argv);
    if (error) {
        prompts.log.error(error);
        return 1;
    }

    if (dryRun) {
        prompts.log.message(
            `[dry-run] would run: dsh ${dshPluginAddArgs(profile, spec).join(" ")} ` +
                `(or write the ${DSH_PACKAGE_NAME} dependency + bundle rows into profile "${profile}")`,
        );
        return 0;
    }

    const manifestOnly = argv.includes("--manifest-only");
    let installedVia = "manifest rows";
    if (!manifestOnly) {
        const out = runDshCommand(binary.path, dshPluginAddArgs(profile, spec));
        if (out !== null) {
            installedVia = "host command";
        } else {
            prompts.log.warn(
                `\`dsh plugin --profile ${profile} add ${spec}\` failed — writing the profile manifest rows directly instead.`,
            );
        }
    }

    if (manifestOnly || installedVia === "manifest rows" || !profileHasBundleEntry(profile)) {
        // Also (re)write the rows when the host command may have only half
        // reconciled: the write is idempotent and content-preserving.
        const entry = ensureDshBundleRow(profile, spec);
        if (!entry.ok) {
            prompts.log.error(entry.message);
            return 1;
        }
        prompts.log.info(entry.message);
    }

    if (!profileHasBundleEntry(profile)) {
        prompts.log.error(
            `Profile "${profile}" still lacks the ${DSH_PACKAGE_NAME} dependency/bundle rows — install incomplete.`,
        );
        return 1;
    }

    prompts.note(
        [
            `Profile: ${profile} (${getDshProfileDir(profile)})`,
            `Installed via: ${installedVia}`,
            `Spec: ${spec}`,
        ].join("\n"),
        "DSH installation",
    );
    prompts.log.success(
        `Next: restart any running \`${"dsh --profile " + profile}\` session so the bundle loads, then verify with \`magic-context doctor --harness dsh --profile ${profile}\`.`,
    );
    return 0;
}
