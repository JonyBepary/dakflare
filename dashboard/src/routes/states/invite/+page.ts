import {
	DEFAULT_INVITE_STATE,
	INVITE_SCENARIOS,
	isInviteStateKey,
	type InviteStateKey
} from './fixtures';
import { installInviteStub } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: InviteStateKey } {
	const asked = url.searchParams.get('__state');
	const state: InviteStateKey = isInviteStateKey(asked) ? asked : DEFAULT_INVITE_STATE;
	installInviteStub(INVITE_SCENARIOS[state]);
	return { state };
}
