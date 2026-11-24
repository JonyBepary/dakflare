/**
 * The workbench's one job: read `?__state=`, install the fetch stub before the
 * console boots, and hand the state to the page.
 *
 * `installStub` runs in `load` rather than `onMount` because the shell's session
 * check is the first request in the app, and the shell only renders the page
 * after it answers. A stub installed by the page would be installed too late.
 */
import { DEFAULT_STATE, isStateKey, SCENARIOS, type StateKey } from './scenarios';
import { installStub } from './stub';

export const ssr = false;

/**
 * PRERENDERED, RELUCTANTLY — the one place this workbench bends the brief.
 *
 * `prerender = false` is what a workbench should say, and it is what this route
 * said first: `npm run build` then failed with
 *   "@sveltejs/adapter-static: all routes must be fully prerenderable, but found
 *    the following routes that are dynamic: src/routes/states/ai-settings"
 * because `vite.config.ts` runs adapter-static with no `fallback` and strict on.
 * The two fixes both live in that config (`fallback`, or `strict: false`), which
 * is out of scope here, so this route is marked prerenderable instead: with
 * `ssr = false` it contributes an empty HTML shell and nothing else, at
 * `worker/public/admin/states/ai-settings/` — a gitignored build artifact, never
 * linked from the console. Say the word and `strict: false` in the adapter
 * options makes this `prerender = false` again.
 */
export const prerender = true;

export function load({ url }: { url: URL }): { state: StateKey } {
	const asked = url.searchParams.get('__state') ?? '';
	const state: StateKey = isStateKey(asked) ? asked : DEFAULT_STATE;
	if (typeof window !== 'undefined') installStub(SCENARIOS[state]);
	return { state };
}
