/**
 * What a pending patch looks like on the canvas.
 *
 * The editor keeps the real document and the ghost in the same `nodes` array
 * while a patch is staged, because Svelte Flow binds to that array and every
 * card draws from it. What it cannot pass down is which cards are new and which
 * only had a connection moved — the node components sit inside Svelte Flow's own
 * tree and receive no editor props. A small context with one lookup does that,
 * and it lives next to the cards rather than in `$lib/workflow/context.ts` so the
 * canvas-wide contract stays exactly as it was.
 */

export const WORKFLOW_GHOST = Symbol('workflow-ghost');

/** A card the pending patch adds, or one whose connection it moves. */
export type GhostKind = 'added' | 'modified';

export interface WorkflowGhostUi {
	/** `null` once the patch is accepted, reverted, or never existed. */
	kindOf(nodeId: string): GhostKind | null;
}
