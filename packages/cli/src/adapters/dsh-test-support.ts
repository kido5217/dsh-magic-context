/**
 * Shared test scaffolding for the DSH adapter/setup/doctor suites:
 *
 *   - a temp HOME + DSH_HOME with a fake `dsh` binary on an isolated PATH,
 *   - a MockPrompts implementation of PromptIO,
 *   - env save/restore so suites stay hermetic.
 *
 * The fake `dsh` is a bun script (shebang pinned to the running bun so an
 * isolated PATH cannot break it). It records every invocation's argv as a
 * JSON line in DSH_FAKE_LOG and behaves per DSH_FAKE_MODE:
 *
 *   "ok"        `plugin --profile <p> add <spec>` reconciles the profile
 *               manifest exactly like the real host command does (dependency +
 *               dsh.profile.bundles rows).
 *   "nochange"  exits 0 without touching the manifest (host half-reconciled).
 *   "fail"      the plugin command fails (setup must fall back to rows).
 *   "noversion" `--version` fails (doctor/setup must not guess a version).
 *
 * Version output is taken from DSH_FAKE_VERSION (default 0.2.2-rc.1).
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PromptIO, PromptSpinner, SelectOption } from "../lib/prompts";

const SAVED_KEYS = [
    "DSH_HOME",
    "DSH_PROFILE",
    "PATH",
    "HOME",
    "XDG_DATA_HOME",
    "MAGIC_CONTEXT_LOG_PATH",
    "MAGIC_CONTEXT_STORAGE_DIR",
    "DSH_FAKE_MODE",
    "DSH_FAKE_VERSION",
    "DSH_FAKE_LOG",
] as const;

const FAKE_VERSION_DEFAULT = "0.2.2-rc.1";

export const PKG = "@cortexkit/dsh-magic-context";

export interface DshTestEnv {
    home: string;
    dshHome: string;
    binDir: string;
    fakeDshPath: string;
    callLogPath: string;
    /** Create `$DSH_HOME/profiles/<name>` with the given package.json. */
    addProfile(name: string, manifest: Record<string, unknown>): string;
    writeProfilePatch(name: string, yaml: string): void;
    /** Install a fake bundle package.json under a profile's node_modules. */
    addInstalledBundle(name: string, pkg: Record<string, unknown>): string;
    readManifest(name: string): Record<string, unknown>;
    /** Every recorded invocation as JSON strings (argv array per line). */
    calls(): string[];
    /** Only `plugin …` invocations (version probes excluded), as JSON strings. */
    pluginCalls(): string[];
    setMode(mode: string): void;
    setVersion(version: string): void;
    removeFakeDsh(): void;
    cleanup(): void;
}

export function createDshTestEnv(initialMode = "ok"): DshTestEnv {
    const saved = new Map<string, string | undefined>();
    for (const key of SAVED_KEYS) saved.set(key, process.env[key]);

    const home = mkdtempSync(join(tmpdir(), "mc-dsh-test-"));
    const dshHome = join(home, ".dsh");
    const profilesDir = join(dshHome, "profiles");
    const binDir = join(home, "bin");
    mkdirSync(profilesDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const fakeDshPath = join(binDir, "dsh");
    writeFileSync(fakeDshPath, fakeDshScript(process.execPath), "utf-8");
    chmodSync(fakeDshPath, 0o755);

    const callLogPath = join(home, "dsh-calls.log");
    writeFileSync(callLogPath, "");

    process.env.HOME = home;
    process.env.DSH_HOME = dshHome;
    process.env.PATH = binDir;
    process.env.DSH_FAKE_LOG = callLogPath;
    process.env.DSH_FAKE_MODE = initialMode;
    process.env.DSH_FAKE_VERSION = FAKE_VERSION_DEFAULT;
    delete process.env.DSH_PROFILE;
    delete process.env.MAGIC_CONTEXT_LOG_PATH;
    delete process.env.MAGIC_CONTEXT_STORAGE_DIR;

    let cleaned = false;
    const cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        for (const key of SAVED_KEYS) {
            const value = saved.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        rmSync(home, { recursive: true, force: true });
    };

    return {
        home,
        dshHome,
        binDir,
        fakeDshPath,
        callLogPath,
        addProfile(name, manifest) {
            const dir = join(profilesDir, name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2));
            return dir;
        },
        writeProfilePatch(name, yaml) {
            const dir = join(profilesDir, name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "cordis.patch.yml"), yaml);
        },
        addInstalledBundle(name, pkg) {
            const dir = join(profilesDir, name, "node_modules", ...PKG.split("/"));
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
            return dir;
        },
        readManifest(name) {
            return JSON.parse(
                readFileSync(join(profilesDir, name, "package.json"), "utf-8"),
            ) as Record<string, unknown>;
        },
        calls() {
            return readFileSync(callLogPath, "utf-8")
                .split("\n")
                .filter((line) => line.trim().length > 0);
        },
        pluginCalls() {
            return this.calls().filter((line) => line.startsWith('["plugin"'));
        },
        setMode(mode) {
            process.env.DSH_FAKE_MODE = mode;
        },
        setVersion(version) {
            process.env.DSH_FAKE_VERSION = version;
        },
        removeFakeDsh() {
            rmSync(fakeDshPath, { force: true });
        },
        cleanup,
    };
}

function fakeDshScript(bunPath: string): string {
    return [
        `#!${bunPath}`,
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv.slice(2);",
        "const logPath = process.env.DSH_FAKE_LOG || '';",
        "if (logPath) fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');",
        "const mode = process.env.DSH_FAKE_MODE || 'ok';",
        "if (args.length === 1 && args[0] === '--version') {",
        "  if (mode === 'noversion') process.exit(3);",
        "  console.log(process.env.DSH_FAKE_VERSION || '0.2.2-rc.1');",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'plugin') {",
        "  if (mode === 'fail') process.exit(1);",
        "  if (mode === 'ok') {",
        "    const home = process.env.DSH_HOME || '';",
        "    const pIdx = args.indexOf('--profile');",
        "    const aIdx = args.indexOf('add');",
        "    if (home && pIdx !== -1 && aIdx !== -1) {",
        "      const profile = args[pIdx + 1];",
        "      const spec = args[aIdx + 1];",
        "      const manifestPath = path.join(home, 'profiles', profile, 'package.json');",
        "      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));",
        "      manifest.dependencies = manifest.dependencies || {};",
        "      manifest.dependencies['@cortexkit/dsh-magic-context'] = spec;",
        "      manifest.dsh = manifest.dsh || {};",
        "      manifest.dsh.profile = manifest.dsh.profile || {};",
        "      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles || [];",
        "      if (!manifest.dsh.profile.bundles.includes('@cortexkit/dsh-magic-context')) {",
        "        manifest.dsh.profile.bundles.push('@cortexkit/dsh-magic-context');",
        "      }",
        "      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));",
        "    }",
        "  }",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
        "",
    ].join("\n");
}

/** PromptIO double that records every rendered line, prefixed by channel. */
export class MockPrompts implements PromptIO {
    readonly messages: string[] = [];

    readonly log = {
        info: (message: string) => this.messages.push(`info:${message}`),
        success: (message: string) => this.messages.push(`success:${message}`),
        warn: (message: string) => this.messages.push(`warn:${message}`),
        error: (message: string) => this.messages.push(`error:${message}`),
        message: (message: string) => this.messages.push(`message:${message}`),
        step: (message: string) => this.messages.push(`step:${message}`),
    };

    private readonly spinnerStub: PromptSpinner = {
        start: () => {},
        stop: () => {},
        message: () => {},
    };

    intro(message: string): void {
        this.messages.push(`intro:${message}`);
    }
    outro(message: string): void {
        this.messages.push(`outro:${message}`);
    }
    note(message: string, title?: string): void {
        this.messages.push(`note[${title ?? ""}]:${message}`);
    }
    spinner(): PromptSpinner {
        return this.spinnerStub;
    }
    async confirm(_message: string, defaultYes = false): Promise<boolean> {
        return defaultYes;
    }
    async text(message: string): Promise<string> {
        throw new Error(`unexpected prompt: ${message}`);
    }
    async selectOne(message: string): Promise<string> {
        throw new Error(`unexpected prompt: ${message}`);
    }
    async selectMany(message: string): Promise<string[]> {
        throw new Error(`unexpected prompt: ${message}`);
    }
    async selectAutocomplete(message: string): Promise<string> {
        throw new Error(`unexpected prompt: ${message}`);
    }
}

export function baseProfileManifest(): Record<string, unknown> {
    return {
        name: "dsh-profile-alpha",
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
    };
}

export type { SelectOption };
