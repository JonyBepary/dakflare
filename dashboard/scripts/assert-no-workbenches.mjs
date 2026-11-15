#!/usr/bin/env node
/**
 * Refuse a production build while the state workbenches are in the route tree.
 *
 * `/routes/states/*` are throwaway pages: real components, stubbed endpoints, a
 * switcher that is deliberately outside the design system. They are useful in dev
 * and must never ship. They have no git presence, so nothing else stops a build
 * from picking them up — twice now that has put them in a deployed console.
 *
 * `npm run dev` is unaffected: the guard only runs before `npm run build`.
 * Override with ALLOW_WORKBENCH=1 when you knowingly want them in an artifact.
 */
import { existsSync } from 'node:fs';

const dir = new URL('../src/routes/states/', import.meta.url);
if (existsSync(dir) && process.env.ALLOW_WORKBENCH !== '1') {
	console.error(
		'build refused: src/routes/states/ exists and would ship the throwaway state\n' +
			'workbenches. Move the folder out of the tree (or set ALLOW_WORKBENCH=1 if\n' +
			'you really want them in this artifact). `npm run dev` still serves them.'
	);
	process.exit(1);
}
