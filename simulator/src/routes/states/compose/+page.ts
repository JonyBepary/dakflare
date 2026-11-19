import type { PageLoad } from './$types';
import { applyState, resolveStateKey } from './stub';

export const ssr = false;

export const load: PageLoad = async ({ url }) => {
	const state = resolveStateKey(url.searchParams.get('__state'));
	await applyState(state);
	return { state };
};
