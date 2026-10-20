/**
 * Canvas-wide UI state shared with node and edge components.
 *
 * Svelte Flow renders custom nodes/edges inside its own component tree, so they
 * cannot receive editor props directly. A context object with getters keeps the
 * preview highlight and selection reactive without copying sets into every node.
 */

export const WORKFLOW_UI = Symbol('workflow-canvas');

export interface WorkflowCanvasUi {
	readonly selectedId: string | null;
	readonly activeNodeIds: Set<string>;
	readonly activeEdgeIds: Set<string>;
	deleteNode(id: string): void;
	duplicateNode(id: string): void;
	/** Screen → canvas coordinates, supplied by the component rendered inside SvelteFlow. */
	screenToFlowPosition(point: { x: number; y: number }): { x: number; y: number };
	revealNode(id: string): void;
}
