/**
 * T079 — the DSH bundle update check. Covers the gates (auto_update opt-out,
 * missing install, dev links, user pins), the registry comparison (channels,
 * staleness), host-command application with restart reporting, and the
 * once-per-boot lane-start scheduling. All network and process launches are
 * injected; the install tree is a temp $DSH_HOME.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	channelForVersion,
	classifyBundleSpec,
	DSH_BUNDLE_PACKAGE,
	type DshUpdateCheckDeps,
	runDshUpdateCheck,
	startDshUpdateCheck,
} from "../src/maintenance/update-check.js";

let home: string | null = null;

function freshHome(): string {
	home = mkdtempSync(join(tmpdir(), "mc-dsh-update-"));
	mkdirSync(join(home, "profiles"), { recursive: true });
	return home;
}

afterEach(() => {
	if (home) rmSync(home, { recursive: true, force: true });
	home = null;
});

function addProfile(
	root: string,
	profile: string,
	spec: string,
	installedVersion: string | null,
): void {
	const dir = join(root, "profiles", profile);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({
			name: `dsh-profile-${profile}`,
			private: true,
			dependencies: { [DSH_BUNDLE_PACKAGE]: spec },
			dsh: { profile: { bundles: [DSH_BUNDLE_PACKAGE] } },
		}),
	);
	if (installedVersion !== null) {
		const pkgDir = join(dir, "node_modules", "@cortexkit", "dsh-magic-context");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name: DSH_BUNDLE_PACKAGE, version: installedVersion }),
		);
	}
}

function registryFetch(distTags: Record<string, string>): {
	fetch: NonNullable<DshUpdateCheckDeps["fetchImpl"]>;
	calls: () => number;
} {
	let calls = 0;
	return {
		calls: () => calls,
		fetch: async () => {
			calls += 1;
			return {
				ok: true,
				status: 200,
				json: async () => ({ "dist-tags": distTags }),
			};
		},
	};
}

describe("classifyBundleSpec", () => {
	test("classifies provenance and pins", () => {
		expect(classifyBundleSpec("link:/home/dev/dsh-plugin").provenance).toBe(
			"dev",
		);
		expect(classifyBundleSpec("file:/tmp/x").provenance).toBe("dev");
		expect(classifyBundleSpec("./local").provenance).toBe("dev");
		expect(classifyBundleSpec("0.49.34").provenance).toBe("pinned");
		expect(
			classifyBundleSpec("npm:@cortexkit/dsh-magic-context@0.49.34").provenance,
		).toBe("pinned");
		expect(classifyBundleSpec("^0.49.0").provenance).toBe("registry");
		expect(classifyBundleSpec("latest").provenance).toBe("registry");
		expect(classifyBundleSpec("@cortexkit/dsh-magic-context").provenance).toBe(
			"registry",
		);
		expect(
			classifyBundleSpec("npm:@cortexkit/dsh-magic-context").provenance,
		).toBe("registry");
	});

	test("maps prereleases to their channel", () => {
		expect(channelForVersion("0.49.34")).toBe("latest");
		expect(channelForVersion("0.50.0-rc.1")).toBe("rc");
		expect(channelForVersion("1.0.0-beta.3")).toBe("beta");
	});
});

describe("runDshUpdateCheck", () => {
	test("auto_update:false disables the probe", async () => {
		const root = freshHome();
		addProfile(root, "web", "latest", "0.49.0");
		const registry = registryFetch({ latest: "0.50.0" });
		const result = await runDshUpdateCheck({
			config: { auto_update: false },
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
		});
		expect(result.status).toBe("disabled");
		expect(registry.calls()).toBe(0);
	});

	test("no profile carrying the bundle is not-installed", async () => {
		const root = freshHome();
		const registry = registryFetch({ latest: "0.50.0" });
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
		});
		expect(result.status).toBe("not-installed");
		expect(registry.calls()).toBe(0);
	});

	test("link: dev installs are skipped without a probe", async () => {
		const root = freshHome();
		addProfile(root, "mc", "link:/home/dev/dsh-plugin", "0.1.0");
		const registry = registryFetch({ latest: "0.50.0" });
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
		});
		expect(result.status).toBe("dev-install");
		expect(result.profile).toBe("mc");
		expect(registry.calls()).toBe(0);
	});

	test("exact pins get a report, never an apply", async () => {
		const root = freshHome();
		addProfile(root, "web", "0.49.34", "0.49.34");
		const registry = registryFetch({ latest: "0.50.0" });
		let ran = 0;
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
			runCommand: () => {
				ran += 1;
				return true;
			},
		});
		expect(result.status).toBe("pinned");
		expect(result.latestVersion).toBe("0.50.0");
		expect(result.command).toEqual([
			"dsh",
			"plugin",
			"--profile",
			"web",
			"add",
			`${DSH_BUNDLE_PACKAGE}@0.50.0`,
		]);
		expect(ran).toBe(0);
		expect(result.restartRequired).toBe(false);
	});

	test("a stale floating install applies via the host command", async () => {
		const root = freshHome();
		addProfile(root, "web", "^0.49.0", "0.49.34");
		const registry = registryFetch({ latest: "0.50.1" });
		const invoked: string[][] = [];
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
			runCommand: (argv) => {
				invoked.push([...argv]);
				return true;
			},
		});
		expect(result.status).toBe("applied");
		expect(result.restartRequired).toBe(true);
		expect(invoked).toEqual([
			[
				"dsh",
				"plugin",
				"--profile",
				"web",
				"add",
				`${DSH_BUNDLE_PACKAGE}@0.50.1`,
			],
		]);
		expect(result.message).toContain("Restart dsh");
	});

	test("a failed host command downgrades to a reported command", async () => {
		const root = freshHome();
		addProfile(root, "web", "latest", "0.49.0");
		const registry = registryFetch({ latest: "0.50.1" });
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
			runCommand: () => false,
		});
		expect(result.status).toBe("available");
		expect(result.command?.at(-1)).toBe(`${DSH_BUNDLE_PACKAGE}@0.50.1`);
	});

	test("current installs report up-to-date", async () => {
		const root = freshHome();
		addProfile(root, "web", "^0.50.0", "0.50.1");
		const registry = registryFetch({ latest: "0.50.1" });
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
			runCommand: () => true,
		});
		expect(result.status).toBe("up-to-date");
	});

	test("prerelease installs follow their channel tag", async () => {
		const root = freshHome();
		addProfile(root, "web", "next", "0.50.0-rc.1");
		const registry = registryFetch({ latest: "0.49.9", rc: "0.51.0-rc.3" });
		const invoked: string[][] = [];
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
			runCommand: (argv) => {
				invoked.push([...argv]);
				return true;
			},
		});
		expect(result.status).toBe("applied");
		expect(invoked[0]?.at(-1)).toBe(`${DSH_BUNDLE_PACKAGE}@0.51.0-rc.3`);
	});

	test("DSH_PROFILE narrows the profile scanned", async () => {
		const root = freshHome();
		addProfile(root, "alpha", "^0.1.0", "0.1.0");
		addProfile(root, "web", "^0.49.0", "0.49.0");
		const registry = registryFetch({ latest: "0.50.0" });
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root, DSH_PROFILE: "web" },
			fetchImpl: registry.fetch,
			runCommand: () => true,
		});
		expect(result.profile).toBe("web");
	});

	test("registry failures are swallowed into a status", async () => {
		const root = freshHome();
		addProfile(root, "web", "latest", "0.49.0");
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: async () => {
				throw new Error("offline");
			},
		});
		expect(result.status).toBe("registry-unreachable");
	});

	test("declared-but-missing installs are not-installed", async () => {
		const root = freshHome();
		addProfile(root, "web", "latest", null);
		const registry = registryFetch({ latest: "0.50.0" });
		const result = await runDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
		});
		expect(result.status).toBe("not-installed");
	});
});

describe("startDshUpdateCheck", () => {
	test("runs exactly once per boot and stops cleanly", async () => {
		const root = freshHome();
		addProfile(root, "web", "latest", "0.49.0");
		const registry = registryFetch({ latest: "0.50.0" });
		const handle = startDshUpdateCheck({
			config: {},
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
			runCommand: () => true,
			startDelayMs: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(registry.calls()).toBe(1);
		handle.stop();
		handle.stop();
	});

	test("auto_update:false never probes", async () => {
		const root = freshHome();
		addProfile(root, "web", "latest", "0.49.0");
		const registry = registryFetch({ latest: "0.50.0" });
		const handle = startDshUpdateCheck({
			config: { auto_update: false },
			env: { DSH_HOME: root },
			fetchImpl: registry.fetch,
			startDelayMs: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(registry.calls()).toBe(0);
		handle.stop();
	});
});
