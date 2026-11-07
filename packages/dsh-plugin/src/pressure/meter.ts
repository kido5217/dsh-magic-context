/**
 * Token-meter bridge (T012).
 *
 * Bridges `DshHost.pressure()` (production: `ctx.tokenMeter.contextPressure`,
 * routed-model authoritative pressure for the next request) onto the core's
 * escalation bands. No local token estimation (FR-006): the percentage is
 * always provider pressure ÷ routed context window.
 *
 * Band semantics mirror core `shared/escalation-bands.ts` exactly —
 * `escalationBands(executeThreshold)`:
 * - `execute`: shared `scheduler.execute_threshold_percentage` (default
 *   `DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE` = 65), capped at
 *   `MAX_EXECUTE_THRESHOLD` (90) like the core scheduler;
 * - `force`: `max(85, execute + 2)` (forceMaterializationPercentage);
 * - `refuse`: 95 (`ABSOLUTE_EMERGENCY_PERCENTAGE`, the absolute wall).
 *
 * Meter unavailable (pressure() undefined / no window yet) ⇒ `percentage:
 * null`, treated as **below the execute threshold** and logged once per
 * session (D6: conservative, never fabricate pressure).
 */
import {
	DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
	type MagicContextConfig,
} from "@magic-context/core/config/schema/magic-context";
import {
	escalationBands,
	MAX_EXECUTE_THRESHOLD,
} from "@magic-context/core/shared/escalation-bands";
import { log } from "@magic-context/core/shared/logger";
import type { DshHost } from "../host.js";

/** Resolve the shared execute threshold percentage (number or routed `{default}`). */
export function resolveExecuteThresholdPercentage(
	config: Pick<MagicContextConfig, "execute_threshold_percentage">,
): number {
	const value = config.execute_threshold_percentage;
	const threshold =
		typeof value === "number"
			? value
			: (value?.default ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE);
	return Math.min(threshold, MAX_EXECUTE_THRESHOLD);
}

/** One pressure reading in core band coordinates. `percentage: null` ⇒ meter unavailable. */
export interface PressureBands {
	readonly percentage: number | null;
	readonly execute: number;
	readonly force: number;
	readonly refuse: number;
}

export class PressureMeter {
	private readonly bands: PressureBands;
	private readonly loggedUnavailable = new Set<string>();
	// Learned-window overlay (N-02): the band must price against
	// min(advertised, learned) — the same doctrine as the core, which persists
	// learned limits. Wired once from the overflow ledger; a meter without a
	// ledger prices against the advertised window only.
	private windowOverlay?: (sessionId: string, advertised: number) => number | undefined;

	setWindowOverlay(
		overlay: (sessionId: string, advertised: number) => number | undefined,
	): void {
		this.windowOverlay = overlay;
	}

	constructor(
		private readonly host: DshHost,
		config: Pick<MagicContextConfig, "execute_threshold_percentage">,
	) {
		const execute = resolveExecuteThresholdPercentage(config);
		const { forceMaterializationPercentage, emergencyPercentage } =
			escalationBands(execute);
		this.bands = {
			percentage: null,
			execute,
			force: forceMaterializationPercentage,
			refuse: emergencyPercentage,
		};
	}

	/** Current banded pressure for one session; never throws, null = below execute. */
	read(sessionId: string): PressureBands {
		const reading = this.host.pressure(sessionId);
		const tokens = reading?.pressureTokens;
		const window = reading?.contextWindow;
		if (tokens === undefined || window === undefined || window <= 0) {
			if (!this.loggedUnavailable.has(sessionId)) {
				this.loggedUnavailable.add(sessionId);
				log(
					`[dsh-magic-context] token meter unavailable for session ${sessionId}; treating pressure as below the execute threshold (D6)`,
				);
			}
			return this.bands;
		}
		const learned = this.windowOverlay?.(sessionId, window);
		const effective =
			learned !== undefined && learned > 0 && learned < window ? learned : window;
		const percentage = Math.min(100, (tokens / effective) * 100);
		return {
			percentage,
			execute: this.bands.execute,
			force: this.bands.force,
			refuse: this.bands.refuse,
		};
	}

	/** N-06: release per-session memory when the session closes. */
	forget(sessionId: string): void {
		this.loggedUnavailable.delete(sessionId);
	}

	/** Coarse lane for callers (T019): meter unavailable ⇒ "below-execute" (D6). */
	lane(sessionId: string): "below-execute" | "execute" | "force" | "refuse" {
		const { percentage, execute, force, refuse } = this.read(sessionId);
		if (percentage === null) return "below-execute";
		if (percentage >= refuse) return "refuse";
		if (percentage >= force) return "force";
		if (percentage >= execute) return "execute";
		return "below-execute";
	}
}
