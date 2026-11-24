import {
	DEFAULT_LOGIN_STATE,
	LOGIN_SCENARIOS,
	isLoginStateKey,
	type LoginStateKey
} from './fixtures';
import { installLoginStub } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: LoginStateKey } {
	const asked = url.searchParams.get('__state');
	const state: LoginStateKey = isLoginStateKey(asked) ? asked : DEFAULT_LOGIN_STATE;
	installLoginStub(LOGIN_SCENARIOS[state]);
	return { state };
}
