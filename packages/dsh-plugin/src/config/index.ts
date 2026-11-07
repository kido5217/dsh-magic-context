/**
 * Shared-config loader (T007).
 *
 * Reduced variant of Pi's `loadPiConfig`: DSH reads the SAME CortexKit config
 * pair as every other harness (user `$(XDG_CONFIG_HOME|~/.config)/cortexkit/
 * magic-context.{jsonc,json}`, project `<cwd>/.cortexkit/…`, project merged
 * over user) with the SAME schema — no DSH-only knobs (FR-006) and no legacy
 * harness migrations (DSH has no legacy locations to relocate). A config that
 * fails validation falls back to schema defaults with a warning, same
 * fail-open-to-defaults posture as the other loaders.
 */
import {
	cortexKitProjectConfigBasePath,
	cortexKitUserConfigBasePath,
} from "@magic-context/core/config/migrate-config-location";
import {
	type MagicContextConfig,
	MagicContextConfigSchema,
} from "@magic-context/core/config/schema/magic-context";
import {
	detectConfigFile,
	readJsoncFile,
} from "@magic-context/core/shared/jsonc-parser";

export interface LoadDshConfigResult {
	config: MagicContextConfig;
	warnings: string[];
	loadedFromPaths: string[];
}

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRaw(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	for (const key of Object.keys(base)) {
		if (POLLUTION_KEYS.has(key)) continue;
		merged[key] = base[key];
	}
	for (const key of Object.keys(override)) {
		if (POLLUTION_KEYS.has(key)) continue;
		const baseValue = Object.hasOwn(base, key) ? base[key] : undefined;
		const overrideValue = override[key];
		merged[key] =
			isPlainObject(baseValue) && isPlainObject(overrideValue)
				? mergeRaw(baseValue, overrideValue)
				: overrideValue;
	}
	return merged;
}

function readLayer(
	basePath: string,
	label: string,
	warnings: string[],
	loadedFromPaths: string[],
): Record<string, unknown> {
	const detected = detectConfigFile(basePath);
	if (detected.format === "none") return {};
	const parsed = readJsoncFile<unknown>(detected.path);
	if (parsed === null || !isPlainObject(parsed)) {
		warnings.push(
			`[${label} config] ${detected.path} is not a readable JSONC object; using defaults for this layer`,
		);
		return {};
	}
	loadedFromPaths.push(detected.path);
	return parsed;
}

/** Load the shared Magic Context config for a DSH boot (user + project layers). */
export function loadDshConfig(
	opts: { cwd?: string } = {},
): LoadDshConfigResult {
	const cwd = opts.cwd ?? process.cwd();
	const warnings: string[] = [];
	const loadedFromPaths: string[] = [];
	const userRaw = readLayer(
		cortexKitUserConfigBasePath(),
		"user",
		warnings,
		loadedFromPaths,
	);
	const projectRaw = readLayer(
		cortexKitProjectConfigBasePath(cwd),
		"project",
		warnings,
		loadedFromPaths,
	);
	const raw = mergeRaw(userRaw, projectRaw);
	const parsed = MagicContextConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { config: parsed.data, warnings, loadedFromPaths };
	}
	warnings.push(
		`[config] schema validation failed (${parsed.error.issues.length} issue(s)); using defaults`,
	);
	return {
		config: MagicContextConfigSchema.parse({}),
		warnings,
		loadedFromPaths,
	};
}
