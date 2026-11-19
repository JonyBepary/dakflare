#!/usr/bin/env node
/**
 * Refuse a production build while the state workbenches are in the route tree.
 *
 * The same guard the console has had since the workbenches twice reached a deployed
 * artifact (`dashboard/scripts/assert-no-workbenches.mjs`). The simulator had no
 * equivalent, so `npm run tauri android build` would have bundled `routes/states/` —
 * throwaway pages with stubbed endpoints — into an APK that goes on a phone.
 *
 * `npm run dev` and `npm run tauri dev` still serve them; only a production build is
 * refused. Override with ALLOW_WORKBENCH=1 when you knowingly want them in an artifact.
 */
import { existsSync } from 'node:fs';

const dir = new URL('../src/routes/states/', import.meta.url);
if (existsSync(dir) && process.env.ALLOW_WORKBENCH !== '1') {
	console.error(
		'build refused: src/routes/states/ exists and would ship the throwaway state\n' +
			'workbenches inside the handset app. Move the folder out of the tree (or set\n' +
			'ALLOW_WORKBENCH=1 if you really want them in this artifact). `npm run dev`\n' +
			'still serves them.'
	);
	process.exit(1);
}
