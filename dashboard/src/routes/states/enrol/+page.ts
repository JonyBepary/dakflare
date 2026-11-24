import {
	DEFAULT_ENROL_STATE,
	ENROL_SCENARIOS,
	isEnrolStateKey,
	type EnrolStateKey
} from './fixtures';
import { installEnrolStub } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: EnrolStateKey } {
	const asked = url.searchParams.get('__state');
	const state: EnrolStateKey = isEnrolStateKey(asked) ? asked : DEFAULT_ENROL_STATE;
	installEnrolStub(ENROL_SCENARIOS[state]);
	return { state };
}
