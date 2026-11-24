/**
 * The assistant workbench: one throwaway route, deliberately out of the console.
 *
 * It exists to see `Assistant.svelte` and `AssistantProposalCard.svelte` in every
 * state their code can reach, fed at the boundary they use. It is not part of the
 * product and it is not linked from anywhere.
 *
 * `ssr = false` and `prerender = true` follow the root layout: the app is a pure
 * SPA, so this route builds to the same empty shell as every other one.
 */
import { STATE_KEYS, type StateKey } from './fixtures';
import { installFetchStub } from './stub';

// Runs when the route module is imported, before the layout mounts and asks the
// session endpoint anything. `installFetchStub` is a no-op outside a browser.
installFetchStub();

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }) {
	installFetchStub();
	const asked = url.searchParams.get('__state');
	const state: StateKey =
		asked !== null && (STATE_KEYS as string[]).includes(asked) ? (asked as StateKey) : 'closed';
	return { state };
}
