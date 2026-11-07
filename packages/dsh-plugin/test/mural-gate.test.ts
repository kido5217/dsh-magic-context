/**
 * Mural gate spike (T010).
 *
 * Question: can the head path save an image through the host attachment store,
 * and is image input gated by the routed model's `inputModalities`?
 *
 * Both halves are structural facts of the installed host:
 * - `AttachmentService.saveImage(input)` persists one image and returns an
 *   id-addressed reference usable as an `image` content block
 *   (`dsh-attachment/lib/types/index.d.ts:76`; `saveImages` is the batch form
 *   used by its own admission pipeline);
 * - a model's capability is `inputModalities?: readonly ModelModality[]`
 *   (`dsh-llm/lib/types/index.d.ts:101`), so a route that does not advertise
 *   `image` must never receive one.
 *
 * The design consequence (R7/FR-006): the mural is rendered and stored only
 * when the CURRENT route advertises image input; when the capability is
 * unknown the head renders text-only — never a guessed image and never a
 * silent downgrade of the whole head.
 */
import { describe, expect, test } from "bun:test";
import AttachmentStore from "@deepseek-ai/dsh-attachment";

/** Does this route accept image input? Unknown ⇒ false (text-only). */
export function acceptsImage(
	modalities: readonly string[] | undefined,
): boolean {
	return modalities?.includes("image") === true;
}

describe("mural gate", () => {
	test("the attachment service exposes ordered image commits", () => {
		// `saveImage` is abstract (declared per backend, so absent on the
		// abstract prototype); `saveImages` is the concrete ordered commit the
		// head path uses, and it accepts the single-image form as a batch.
		expect(typeof AttachmentStore.prototype.saveImages).toBe("function");
		expect(typeof AttachmentStore.prototype.admitPromptContent).toBe(
			"function",
		);
	});

	test("image capability gates the mural, unknown capabilities do not", () => {
		expect(acceptsImage(["text", "image"])).toBe(true);
		expect(acceptsImage(["text"])).toBe(false);
		expect(acceptsImage(undefined)).toBe(false);
	});
});
