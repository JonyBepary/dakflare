import { DEFAULT_WORKFLOWS_STATE, isWorkflowsState, type WorkflowsStateKey } from './fixtures';
import { installStub, scenarioFor } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: WorkflowsStateKey } {
	const raw = url.searchParams.get('__state');
	const state = isWorkflowsState(raw) ? raw : DEFAULT_WORKFLOWS_STATE;

	if (typeof window !== 'undefined') {
		installStub(scenarioFor(state));
	}

	return { state };
}
