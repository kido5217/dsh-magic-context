/**
 * Prompt-surface plumbing shared by the five DSH tool factories (T031).
 *
 * Descriptions and per-parameter descriptions are the core prompt surface
 * (`@magic-context/core/tools/*`); the adapter MUST NOT fork copy. Each
 * factory declares its parameters in the DSH `ParameterSchemaSpec` DSL and
 * runs them through core `applyJsonSchemaParameterDescriptions` before
 * `defineTool`, and takes its tool description through the resolved
 * registration (`descriptionFor`), mirroring the Pi plugin's `surfaceTool`.
 */
import type { ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { PromptSurfaceRegistrationSelection } from "@magic-context/core/shared/prompt-surface-runtime";
import { withoutSmartNoteText } from "@magic-context/core/tools/ctx-note/constants";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "@magic-context/core/tools/light-descriptions";
import { applyJsonSchemaParameterDescriptions } from "@magic-context/core/tools/parameter-descriptions";

export interface ToolSurface {
	/** Preset-resolved registration from `PromptSurfaceRuntime.resolveRegistration`. */
	registration: PromptSurfaceRegistrationSelection;
	/** Smart notes are writable (dreamer runnable and smart_notes enabled). */
	smartNotesAvailable: boolean;
}

/** Every ctx_* tool returns one reply string; the host renders it as text. */
export function stringToolOutput(): {
	schema: { type: "string" };
	render: (
		args: unknown,
		value: string,
	) => Array<{ type: "text"; text: string }>;
} {
	return {
		schema: { type: "string" },
		render: (_args: unknown, value: string) => [{ type: "text", text: value }],
	};
}

/** Stamp core per-parameter descriptions onto a DSL parameter map, in place. */
export function surfaceParameterDescriptions(
	toolId: string,
	parameters: ParameterSchemaSpec,
	surface: ToolSurface,
): void {
	applyJsonSchemaParameterDescriptions(
		toolId,
		{ properties: parameters },
		surface.registration.preset,
		surface.smartNotesAvailable,
	);
}

/** The effective model-facing description for one tool, core-sourced. */
export function surfaceDescription(
	toolId: string,
	fullDescription: string,
	surface: ToolSurface,
): string {
	if (toolId === "ctx_note" && !surface.smartNotesAvailable) {
		return withoutSmartNoteText(
			surface.registration.preset === "light"
				? CTX_NOTE_LIGHT_DESCRIPTION
				: fullDescription,
		);
	}
	return surface.registration.descriptionFor(toolId, fullDescription);
}
