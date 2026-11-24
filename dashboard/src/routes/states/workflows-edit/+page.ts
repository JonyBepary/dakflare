import {
	DEFAULT_WORKFLOW_EDIT_STATE,
	isWorkflowEditState,
	scenarioFor,
	syncEditorStorage,
	type WorkflowEditStateKey
} from './fixtures';
import { installStub } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: WorkflowEditStateKey } {
	const raw = url.searchParams.get('__state');
	const state = isWorkflowEditState(raw) ? raw : DEFAULT_WORKFLOW_EDIT_STATE;

	if (typeof window !== 'undefined') {
		syncEditorStorage(state);
		installStub(scenarioFor(state));
	}

	return { state };
}
