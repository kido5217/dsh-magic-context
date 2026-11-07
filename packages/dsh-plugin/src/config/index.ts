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
import {
	constrainProjectThresholdOverrides,
	dropInheritedEmbeddingKeyOnRedirect,
	restoreTrustedValuesOverInvalidProjectValues,
	stripUnsafeProjectConfigFields,
} from "@magic-context/core/config/project-security";

/** Same shape as the core loader's issue collector, without the legacy
 * migrations (DSH has no legacy config locations to relocate). */
function collectDshSchemaIssuePaths(
	raw: Record<string, unknown>,
): PropertyKey[][] {
	const parsed = MagicContextConfigSchema.safeParse(raw);
	if (parsed.success) return [];
	return parsed.error.issues.flatMap((issue) =>
		issue.code === "unrecognized_keys"
			? issue.keys.map((key) => [...issue.path, key])
			: [[...issue.path]],
	);
}

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
	// Project-tier trust boundary (identical to the shared core loader): the
	// project layer lives in a cloned repo and is UNTRUSTED. Escalation fields
	// (hidden-agent prompt/permission/tools, historian runner/host_runner and
	// per-harness model fields, embeddings endpoint/provider redirection,
	// prompt-surface override paths) are stripped before the merge; threshold
	// overrides are constrain-after-merge so a repo may only DELAY historian
	// work, never force earlier spend. Without this, a cloned repo could
	// reprogram the autonomously running dreamer on DSH alone.
	for (const warning of stripUnsafeProjectConfigFields(projectRaw)) {
		warnings.push(`[project config] ${warning}`);
	}
	const raw = mergeRaw(userRaw, projectRaw);
	if (Object.keys(projectRaw).length > 0) {
		for (const warning of dropInheritedEmbeddingKeyOnRedirect(
			projectRaw,
			raw,
			userRaw,
		)) {
			warnings.push(`[project config] ${warning}`);
		}
		for (const warning of constrainProjectThresholdOverrides({
			mergedRaw: raw,
			projectRaw,
			trustedBaseConfig: MagicContextConfigSchema.parse(userRaw),
		})) {
			warnings.push(`[project config] ${warning}`);
		}
		const restored = restoreTrustedValuesOverInvalidProjectValues({
			mergedRaw: raw,
			trustedRaw: userRaw,
			projectRaw,
			collectIssuePaths: collectDshSchemaIssuePaths,
		});
		for (const warning of restored.warnings) {
			warnings.push(`[project config] ${warning}`);
		}
	}
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
