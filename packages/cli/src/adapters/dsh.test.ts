import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    DSH_PACKAGE_NAME,
    DSH_SUPPORTED_RANGE,
    DshAdapter,
    detectDshBinary,
    ensureDshBundleRow,
    getDshHome,
    getDshInstalledBundleVersions,
    getDshProfileFlag,
    getDshVersion,
    listDshProfiles,
    parseDshCompactionState,
    parseDshVersion,
    profileHasBundleEntry,
    readDshBundleEntryState,
    readDshCompactionState,
    removeDshBundleRow,
    satisfiesDshRange,
} from "./dsh";
import { baseProfileManifest, createDshTestEnv, type DshTestEnv, PKG } from "./dsh-test-support";

let env: DshTestEnv | null = null;

function setup(): DshTestEnv {
    env = createDshTestEnv();
    return env;
}

afterEach(() => {
    env?.cleanup();
    env = null;
});

describe("getDshHome", () => {
    it("honors DSH_HOME", () => {
        const e = setup();
        expect(getDshHome()).toBe(e.dshHome);
    });

    it("defaults to $HOME/.dsh when DSH_HOME is unset", () => {
        const e = setup();
        delete process.env.DSH_HOME;
        expect(getDshHome()).toBe(join(e.home, ".dsh"));
    });
});

describe("detectDshBinary", () => {
    it("finds the fake dsh on PATH and probes its version", () => {
        const e = setup();
        const binary = detectDshBinary();
        expect(binary?.path).toBe(e.fakeDshPath);
        expect(binary?.source).toBe("path");
        expect(getDshVersion(binary!.path)).toBe("0.2.2-rc.1");
    });

    it("falls back to $DSH_HOME/bin/dsh", () => {
        const e = setup();
        const script = readFileSync(e.fakeDshPath);
        e.removeFakeDsh();
        const dir = join(e.dshHome, "bin");
        mkdirSync(dir, { recursive: true });
        const candidate = join(dir, "dsh");
        writeFileSync(candidate, script);
        chmodSync(candidate, 0o755);
        expect(detectDshBinary()?.source).toBe("home");
    });

    it("returns null when dsh is nowhere", () => {
        const e = setup();
        e.removeFakeDsh();
        expect(detectDshBinary()).toBeNull();
    });

    it("reports a failed version probe as null", () => {
        const e = setup();
        e.setMode("noversion");
        expect(getDshVersion(e.fakeDshPath)).toBeNull();
    });
});

describe("listDshProfiles", () => {
    it("lists profile directories with bundle state", () => {
        const e = setup();
        e.addProfile("beta", { name: "p-beta", private: true });
        e.addProfile("alpha", {
            ...baseProfileManifest(),
            dependencies: { [PKG]: "npm:@cortexkit/dsh-magic-context@latest" },
            dsh: {
                profile: {
                    bundles: ["@deepseek-ai/dsh-base", PKG],
                },
            },
        });
        writeFileSync(join(e.dshHome, "profiles", "loose-file.txt"), "x");

        const profiles = listDshProfiles();
        expect(profiles.map((p) => p.name)).toEqual(["alpha", "beta"]);
        expect(profiles[0]?.hasBundleEntry).toBe(true);
        expect(profiles[0]?.bundleSpec).toBe("npm:@cortexkit/dsh-magic-context@latest");
        expect(profiles[1]?.hasBundleEntry).toBe(false);
    });
});

describe("profile manifest rows", () => {
    it("reads the entry state from both rows", () => {
        const e = setup();
        e.addProfile("alpha", {
            ...baseProfileManifest(),
            dependencies: { [PKG]: "link:/tmp/x" },
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", PKG] } },
        });
        const state = readDshBundleEntryState("alpha");
        expect(state.hasBundleEntry).toBe(true);
        expect(state.bundleSpec).toBe("link:/tmp/x");
        expect(state.bundleRowCount).toBe(1);

        e.addProfile("dep-only", { ...baseProfileManifest(), dependencies: { [PKG]: "x" } });
        expect(readDshBundleEntryState("dep-only").hasBundleEntry).toBe(false);
        expect(readDshBundleEntryState("dep-only").hasDependency).toBe(true);
    });

    it("detects duplicate rows and multi-section dependencies", () => {
        const e = setup();
        e.addProfile("dup", {
            ...baseProfileManifest(),
            dependencies: { [PKG]: "npm:latest" },
            devDependencies: { [PKG]: "link:/tmp/y" },
            dsh: { profile: { bundles: [PKG, PKG] } },
        });
        const state = readDshBundleEntryState("dup");
        expect(state.bundleRowCount).toBe(2);
        expect(state.duplicateDependencySpecs).toEqual(["link:/tmp/y"]);
    });

    it("adds both rows and preserves unrelated manifest content", () => {
        const e = setup();
        e.addProfile("alpha", {
            ...baseProfileManifest(),
            scripts: { build: "echo" },
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"], patchReload: "startup" } },
        });
        const result = ensureDshBundleRow("alpha");
        expect(result.ok).toBe(true);
        expect(result.action).toBe("added");
        const manifest = e.readManifest("alpha");
        expect((manifest.dependencies as Record<string, string>)[PKG]).toBe(PKG);
        expect((manifest.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual([
            "@deepseek-ai/dsh-base",
            PKG,
        ]);
        expect((manifest.dsh as { profile: { patchReload?: string } }).profile.patchReload).toBe(
            "startup",
        );
        expect(manifest.scripts).toEqual({ build: "echo" });
        expect(manifest.name).toBe("dsh-profile-alpha");
    });

    it("is idempotent and repoints a changed spec", () => {
        const e = setup();
        e.addProfile("alpha", baseProfileManifest());
        expect(ensureDshBundleRow("alpha").action).toBe("added");
        expect(ensureDshBundleRow("alpha").action).toBe("already_present");
        const repointed = ensureDshBundleRow("alpha", `link:/tmp/dev`);
        expect(repointed.ok).toBe(true);
        expect(repointed.action).toBe("updated");
        expect(e.readManifest("alpha").dependencies).toEqual({ [PKG]: "link:/tmp/dev" });
    });

    it("refuses to destroy a malformed manifest", () => {
        const e = setup();
        e.addProfile("alpha", baseProfileManifest());
        writeFileSync(join(e.dshHome, "profiles", "alpha", "package.json"), `{"deps":[\n`);
        const result = ensureDshBundleRow("alpha");
        expect(result.ok).toBe(false);
        expect(readFileSync(join(e.dshHome, "profiles", "alpha", "package.json"), "utf-8")).toBe(
            `{"deps":[\n`,
        );
    });

    it("removes both rows and keeps other bundle rows", () => {
        const e = setup();
        e.addProfile("alpha", {
            ...baseProfileManifest(),
            dependencies: { [PKG]: "x", zod: "^4" },
            dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", PKG] } },
        });
        const result = removeDshBundleRow("alpha");
        expect(result.action).toBe("updated");
        const manifest = e.readManifest("alpha");
        expect(manifest.dependencies).toEqual({ zod: "^4" });
        expect((manifest.dsh as { profile: { bundles: string[] } }).profile.bundles).toEqual([
            "@deepseek-ai/dsh-base",
        ]);
        expect(removeDshBundleRow("alpha").action).toBe("already_present");
    });
});

describe("profile compaction patch parsing", () => {
    it("recognizes an explicit disable row", () => {
        expect(
            parseDshCompactionState(
                "# patch layer\n- id: agent-default-model\n  config:\n    model: x\n\n- id: compaction-basic\n  disabled: true\n",
            ),
        ).toBe("disabled");
    });

    it("recognizes a re-enabled override row", () => {
        expect(parseDshCompactionState("- id: compaction-basic\n  disabled: false\n")).toBe(
            "re-enabled",
        );
        expect(
            parseDshCompactionState("- id: compaction-basic\n  config:\n    threshold: 0.5\n"),
        ).toBe("re-enabled");
    });

    it("treats a patch without the row (or missing file) as absent", () => {
        expect(parseDshCompactionState("[]\n")).toBe("absent");
        expect(parseDshCompactionState("- id: llm-pi-ai\n  config: {}\n")).toBe("absent");
        expect(parseDshCompactionState(null)).toBe("absent");
    });

    it("reads the state from the profile's cordis.patch.yml", () => {
        const e = setup();
        e.addProfile("alpha", baseProfileManifest());
        expect(readDshCompactionState("alpha")).toBe("absent");
        e.writeProfilePatch("alpha", "- id: compaction-basic\n  disabled: false\n");
        expect(readDshCompactionState("alpha")).toBe("re-enabled");
    });
});

describe("version range evaluation", () => {
    it("parses and compares versions with prereleases", () => {
        expect(parseDshVersion("0.2.2-rc.1")).not.toBeNull();
        expect(satisfiesDshRange("0.2.2-rc.1", DSH_SUPPORTED_RANGE)).toBe(true);
        expect(satisfiesDshRange("0.2.2", DSH_SUPPORTED_RANGE)).toBe(true);
        expect(satisfiesDshRange("0.2.9", DSH_SUPPORTED_RANGE)).toBe(true);
        expect(satisfiesDshRange("0.3.0", DSH_SUPPORTED_RANGE)).toBe(false);
        expect(satisfiesDshRange("0.1.0", DSH_SUPPORTED_RANGE)).toBe(false);
        // beta < rc, so it is below the floor.
        expect(satisfiesDshRange("0.2.2-beta.0", DSH_SUPPORTED_RANGE)).toBe(false);
        expect(satisfiesDshRange("garbage", DSH_SUPPORTED_RANGE)).toBe(false);
    });
});

describe("DshAdapter", () => {
    it("reports installed state from the binary probe", () => {
        setup();
        expect(new DshAdapter().isInstalled()).toBe(true);
    });

    it("hasPluginEntry scans every profile unless DSH_PROFILE narrows it", async () => {
        const e = setup();
        e.addProfile("alpha", baseProfileManifest());
        e.addProfile("beta", {
            ...baseProfileManifest(),
            dependencies: { [PKG]: "x" },
            dsh: { profile: { bundles: [PKG] } },
        });
        const adapter = new DshAdapter();
        expect(adapter.hasPluginEntry()).toBe(true);
        process.env.DSH_PROFILE = "alpha";
        expect(adapter.hasPluginEntry()).toBe(false);
    });

    it("requires an explicit profile for mutations", async () => {
        setup();
        const result = await new DshAdapter().ensurePluginEntry();
        expect(result.ok).toBe(false);
        expect(result.message).toContain("DSH_PROFILE");
    });

    it("writes rows through the DSH_PROFILE env", async () => {
        const e = setup();
        e.addProfile("alpha", baseProfileManifest());
        process.env.DSH_PROFILE = "alpha";
        const adapter = new DshAdapter();
        const result = await adapter.ensurePluginEntry();
        expect(result.ok).toBe(true);
        expect(profileHasBundleEntry("alpha")).toBe(true);
        expect(adapter.hasPluginEntry()).toBe(true);
        expect(adapter.getConfigPaths().pluginConfigPath).toBe(
            join(e.dshHome, "profiles", "alpha", "package.json"),
        );
        expect(adapter.getConfigPaths().secondaryConfigPath).toBe(
            join(e.dshHome, "profiles", "alpha", "cordis.patch.yml"),
        );
    });

    it("reports the newest installed bundle version across profiles", () => {
        const e = setup();
        e.addProfile("alpha", baseProfileManifest());
        e.addProfile("beta", baseProfileManifest());
        e.addInstalledBundle("alpha", { name: PKG, version: "0.49.34" });
        e.addInstalledBundle("beta", { name: PKG, version: "0.49.35" });
        expect(new DshAdapter().getInstalledPluginVersion()).toBe("0.49.35");
        expect(getDshInstalledBundleVersions().sort()).toEqual(["0.49.34", "0.49.35"]);
    });

    it("names the dsh-scoped log path and npm identity", () => {
        setup();
        const adapter = new DshAdapter();
        expect(adapter.getLogPath()).toContain("dsh");
        expect(adapter.pluginPackageName).toBe(DSH_PACKAGE_NAME);
        expect(adapter.kind).toBe("dsh");
    });
});

describe("getDshProfileFlag", () => {
    it("reads --profile and rejects missing/flag-shaped values", () => {
        expect(getDshProfileFlag(["--profile", "web"])).toBe("web");
        expect(getDshProfileFlag(["--profile"])).toBeNull();
        expect(getDshProfileFlag(["--profile", "--fix"])).toBeNull();
        expect(getDshProfileFlag([])).toBeNull();
    });
});
