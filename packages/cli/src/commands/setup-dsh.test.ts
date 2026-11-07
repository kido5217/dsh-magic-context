import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    baseProfileManifest,
    createDshTestEnv,
    type DshTestEnv,
    MockPrompts,
    PKG,
} from "../adapters/dsh-test-support";
import { runSetup } from "./setup-dsh";

let env: DshTestEnv | null = null;
const prompts = new MockPrompts();

afterEach(() => {
    env?.cleanup();
    env = null;
    prompts.messages.length = 0;
});

describe("setup-dsh", () => {
    it("installs through the host command and reconciles the profile", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());

        const code = await runSetup({
            argv: ["--harness", "dsh", "--profile", "alpha"],
            prompts,
        });

        expect(code).toBe(0);
        expect(env.pluginCalls()).toContain(
            JSON.stringify(["plugin", "--profile", "alpha", "add", PKG]),
        );
        const manifest = env.readManifest("alpha");
        expect((manifest.dependencies as Record<string, string>)[PKG]).toBe(PKG);
        expect((manifest.dsh as { profile: { bundles: string[] } }).profile.bundles).toContain(PKG);
        expect(
            prompts.messages.some((m) => m.includes(`doctor --harness dsh --profile alpha`)),
        ).toBe(true);
    });

    it("errors listing the available profiles when --profile is missing", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());
        env.addProfile("web", baseProfileManifest());

        const code = await runSetup({ argv: [], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("available profiles: alpha, web");
        expect(env.pluginCalls()).toEqual([]);
    });

    it("errors listing the available profiles when the named profile is unknown", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());

        const code = await runSetup({ argv: ["--profile", "nope"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("available profiles: alpha");
    });

    it("falls back to writing manifest rows when the host command fails", async () => {
        env = createDshTestEnv("fail");
        env.addProfile("alpha", {
            ...baseProfileManifest(),
            scripts: { keep: "me" },
        });

        const code = await runSetup({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(0);
        expect(prompts.messages.some((m) => m.startsWith("warn:"))).toBe(true);
        const manifest = env.readManifest("alpha");
        expect((manifest.dependencies as Record<string, string>)[PKG]).toBe(PKG);
        expect(manifest.scripts).toEqual({ keep: "me" });
    });

    it("re-writes rows itself when the host command succeeded but reconciled nothing", async () => {
        env = createDshTestEnv("nochange");
        env.addProfile("alpha", baseProfileManifest());

        const code = await runSetup({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(0);
        const manifest = env.readManifest("alpha");
        expect((manifest.dependencies as Record<string, string>)[PKG]).toBe(PKG);
    });

    it("writes rows directly with --manifest-only (no host command)", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());

        const code = await runSetup({ argv: ["--profile", "alpha", "--manifest-only"], prompts });

        expect(code).toBe(0);
        expect(env.pluginCalls()).toEqual([]);
        expect((env.readManifest("alpha").dependencies as Record<string, string>)[PKG]).toBe(PKG);
    });

    it("supports a link: dev install", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());
        const checkout = join(env.home, "dsh-plugin-checkout");
        mkdirSync(checkout, { recursive: true });
        writeFileSync(
            join(checkout, "package.json"),
            JSON.stringify({ name: PKG, version: "0.0.0-test" }),
        );

        const code = await runSetup({ argv: ["--profile", "alpha", "--link", checkout], prompts });

        expect(code).toBe(0);
        expect(env.pluginCalls()).toContain(
            JSON.stringify(["plugin", "--profile", "alpha", "add", `link:${checkout}`]),
        );
        expect((env.readManifest("alpha").dependencies as Record<string, string>)[PKG]).toBe(
            `link:${checkout}`,
        );
    });

    it("rejects a --link directory that is not the bundle package", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());
        const checkout = join(env.home, "elsewhere");
        mkdirSync(checkout, { recursive: true });
        writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "other-pkg" }));

        const code = await runSetup({ argv: ["--profile", "alpha", "--link", checkout], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("not @cortexkit/dsh-magic-context");
    });

    it("refuses when the profile re-enables native compaction", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());
        env.writeProfilePatch("alpha", "- id: compaction-basic\n  disabled: false\n");
        const before = readFileSync(
            join(env.dshHome, "profiles", "alpha", "package.json"),
            "utf-8",
        );

        const code = await runSetup({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("compaction-basic");
        expect(env.pluginCalls()).toEqual([]);
        expect(readFileSync(join(env.dshHome, "profiles", "alpha", "package.json"), "utf-8")).toBe(
            before,
        );
    });

    it("refuses a host version outside the supported range", async () => {
        env = createDshTestEnv();
        env.setVersion("0.1.0");
        env.addProfile("alpha", baseProfileManifest());

        const code = await runSetup({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("0.1.0");
    });

    it("dry run reports the planned install without writing or invoking anything", async () => {
        env = createDshTestEnv();
        env.addProfile("alpha", baseProfileManifest());
        const before = readFileSync(
            join(env.dshHome, "profiles", "alpha", "package.json"),
            "utf-8",
        );

        const code = await runSetup({
            argv: ["--profile", "alpha"],
            prompts,
            dryRun: true,
        });

        expect(code).toBe(0);
        expect(env.pluginCalls()).toEqual([]);
        expect(readFileSync(join(env.dshHome, "profiles", "alpha", "package.json"), "utf-8")).toBe(
            before,
        );
        expect(prompts.messages.some((m) => m.includes("[dry-run] would run: dsh plugin"))).toBe(
            true,
        );
    });

    it("stops when the dsh binary is missing", async () => {
        env = createDshTestEnv();
        env.removeFakeDsh();

        const code = await runSetup({ argv: ["--profile", "alpha"], prompts });

        expect(code).toBe(1);
        expect(prompts.messages.join("\n")).toContain("dsh");
    });
});
