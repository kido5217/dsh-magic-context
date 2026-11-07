import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    baseProfileManifest,
    createDshTestEnv,
    type DshTestEnv,
    MockPrompts,
    PKG,
} from "../adapters/dsh-test-support";
import { runDoctor } from "./doctor-dsh";
import { runDoctorStoreInit } from "./doctor-store";

let env: DshTestEnv | null = null;
const prompts = new MockPrompts();

/** Point the shared store at an isolated XDG_DATA_HOME and (optionally) init it. */
function setupStore(opts: { init: boolean }): string {
    const xdg = mkdtempSync(join(tmpdir(), "mc-dsh-doctor-xdg-"));
    process.env.XDG_DATA_HOME = xdg;
    if (opts.init) {
        expect(runDoctorStoreInit(() => {})).toBe(0);
        // A WAL-mode database only gets its immutable read-only open once the
        // WAL sidecars are gone; that path needs node:sqlite, which older Bun
        // builds lack. A zero-byte -wal keeps the read-only open on the
        // portable path so the fence check runs under every runtime.
        writeFileSync(join(xdg, "cortexkit", "magic-context", "context.db-wal"), "");
    }
    return xdg;
}

function freshLog(): string {
    const file = join(mkdtempSync(join(tmpdir(), "mc-dsh-doctor-log-")), "magic-context.log");
    writeFileSync(file, "line\n");
    process.env.MAGIC_CONTEXT_LOG_PATH = file;
    return file;
}

function healthyProfile(e: DshTestEnv): void {
    e.addProfile("alpha", {
        ...baseProfileManifest(),
        dependencies: { [PKG]: "0.49.35" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", PKG] } },
    });
    e.addInstalledBundle("alpha", {
        name: PKG,
        version: "0.49.35",
        engines: { dsh: ">=0.2.2-rc.1 <0.3.0" },
    });
}

afterEach(() => {
    env?.cleanup();
    env = null;
    prompts.messages.length = 0;
    delete process.env.XDG_DATA_HOME;
    delete process.env.MAGIC_CONTEXT_LOG_PATH;
});

describe("doctor-dsh", () => {
    it("passes a fully healthy install", async () => {
        env = createDshTestEnv();
        healthyProfile(env);
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(0);
        const text = prompts.messages.join("\n");
        expect(text).toContain("inside the supported range");
        expect(text).toContain("will not be skipped");
        expect(text).toContain("Exactly one compaction engine");
        expect(text).toContain("Store healthy");
        expect(text).toContain("log is fresh");
    });

    it("fails when the binary is missing", async () => {
        env = createDshTestEnv();
        env.removeFakeDsh();
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("dsh binary not found");
    });

    it("fails when the host version is outside the supported range", async () => {
        env = createDshTestEnv();
        env.setVersion("0.1.0");
        healthyProfile(env);
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("outside the supported range");
    });

    it("fails when the installed bundle's engines.dsh fence is unsatisfied (skippedBundles)", async () => {
        env = createDshTestEnv();
        healthyProfile(env);
        env.addInstalledBundle("alpha", {
            name: PKG,
            version: "0.49.35",
            engines: { dsh: ">=9.0.0" },
        });
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("skippedBundles");
    });

    it("skips the engines fence with a note when the bundle is not on disk yet", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", {
            ...baseProfileManifest(),
            dependencies: { [PKG]: "0.49.35" },
            dsh: { profile: { bundles: [PKG] } },
        });
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(0);
        expect(prompts.messages.join("\n")).toContain("engines.dsh fence not evaluated");
    });

    it("fails on missing bundle rows and repairs them with --fix", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });
        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("missing the @cortexkit/dsh-magic-context");

        prompts.messages.length = 0;
        const fixed = await runDoctor({ argv: ["--profile", "alpha"], fix: true, prompts });
        expect(fixed).toBe(0);
        expect(
            readFileSync(join(env.dshHome, "profiles", "alpha", "package.json"), "utf-8"),
        ).toContain(PKG);
    });

    it("fails when the profile re-enables compaction-basic", async () => {
        env = createDshTestEnv();
        healthyProfile(env);
        env.writeProfilePatch("alpha", "- id: compaction-basic\n  config:\n    x: 1\n");
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("re-enables compaction-basic");
    });

    it("fails on duplicate bundle rows", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", {
            ...baseProfileManifest(),
            dependencies: { [PKG]: "0.49.35" },
            dsh: { profile: { bundles: [PKG, PKG] } },
        });
        env.addInstalledBundle("alpha", {
            name: PKG,
            version: "0.49.35",
            engines: { dsh: ">=0.2.2-rc.1 <0.3.0" },
        });
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("duplicate");
    });

    it("fails when the shared store database is missing", async () => {
        env = createDshTestEnv();
        healthyProfile(env);
        setupStore({ init: false });
        freshLog();

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("Shared store missing");
    });

    it("warns on a stale plugin log", async () => {
        env = createDshTestEnv();
        healthyProfile(env);
        setupStore({ init: true });
        const file = freshLog();
        const old = new Date(Date.now() - 30 * 86_400_000);
        utimesSync(file, old, old);

        const code = await runDoctor({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(0); // warn only
        expect(prompts.messages.join("\n")).toContain("day(s) old");
    });

    it("reports every profile carrying the bundle when --profile is absent", async () => {
        env = createDshTestEnv();
        healthyProfile(env);
        env.addProfile("web", baseProfileManifest());
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: [], prompts });

        expect(code).toBe(0);
        expect(prompts.messages.join("\n")).toContain('Profile "alpha" carries the bundle');
    });

    it("fails fast when no profile carries the bundle", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());
        setupStore({ init: true });
        freshLog();

        const code = await runDoctor({ argv: [], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain(`No profile carries ${PKG}`);
    });
});
