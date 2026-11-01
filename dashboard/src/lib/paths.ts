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
	rules: resolve('/rules'),
	workflows: resolve('/workflows'),
	// One static editor route for drafts and saved flows alike; the workflow key
	// travels as `?id=<id>` because saved ids only exist in D1 at runtime.
	workflowEdit: resolve('/workflows/edit'),
	// Pre-auth account routes. `/invite` takes a code or a `dakflare://invite`
	// link; `/enrol` forces the first passkey before Overview is reachable.
	invite: resolve('/invite'),
	enrol: resolve('/enrol'),
	// Where a magic link lands. It never spends the token on load: the button on
	// the page is the only POST (mail scanners prefetch every link).
	magic: resolve('/magic'),
	// Owner/admin only (AUTH_PLAN §5); the nav hides it for members.
	audit: resolve('/audit'),
	// The human side of the agent control plane: pending authority requests and
	// the duration ladder that answers them. Also owner/admin only.
	approvals: resolve('/approvals'),
	// Owner/admin only as well: the account's factors are managed next to the
	// log that records their use.
	security: resolve('/security')
} as const;

export const BASE = ROUTES.overview.replace(/\/$/, '');
