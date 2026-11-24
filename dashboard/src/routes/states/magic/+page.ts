import {
	DEFAULT_MAGIC_STATE,
	MAGIC_SCENARIOS,
	isMagicStateKey,
	type MagicStateKey
} from './fixtures';
import { installMagicStub } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: MagicStateKey } {
	const asked = url.searchParams.get('__state');
	const state: MagicStateKey = isMagicStateKey(asked) ? asked : DEFAULT_MAGIC_STATE;
	installMagicStub(MAGIC_SCENARIOS[state]);
	return { state };
}
