/**
 * Route URLs and the mount point.
 *
 * SvelteKit 3 removed the `base` export from `$app/paths`; `resolve()` is the
 * supported way to prefix a path. Deriving BASE from a known route keeps
 * `vite.config.ts` as the single source of truth for the mount path.
 */

import { resolve } from '$app/paths';

export const ROUTES = {
	overview: resolve('/'),
	login: resolve('/login'),
	devices: resolve('/devices'),
	messages: resolve('/messages'),
	rules: resolve('/rules')
} as const;

export const BASE = ROUTES.overview.replace(/\/$/, '');
