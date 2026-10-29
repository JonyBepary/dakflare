/**
 * The console's one session.
 *
 * Two contracts live behind this store, and the flag decides which answers:
 *
 *   AUTH_MODE=legacy — `GET /admin/session` and a signed cookie over ADMIN_TOKEN.
 *     This is the request this file has always made, unchanged, and it stays the
 *     first call in every case.
 *   AUTH_MODE=new — `GET /v1/auth/me`, which also carries the role the nav needs.
 *     Reached only when the legacy cookie is absent, so a legacy deployment never
 *     sees a second request it did not have before.
 *
 * `authMode` is what the deployment told us, not what we guessed; `null` means
 * nobody has answered yet. `role` is only meaningful in `new`: the token is the
 * owner credential in `legacy`, and `canViewSecurity` says so explicitly.
 */

import { ApiError, describeError, getMe, getSession } from './api';
import type { AuthMode, MeInfo, Role } from './types';

export type SessionStatus = 'unknown' | 'authed' | 'anon' | 'offline';

class SessionStore {
	status = $state<SessionStatus>('unknown');
	expiresAt = $state<number | null>(null);
	error = $state<string | null>(null);

	/** `null` until an endpoint reports the flag. Kept across `clear()`. */
	authMode = $state<AuthMode | null>(null);
	/** From `/v1/auth/me` only. `null` under the admin token, which has no user row. */
	role = $state<Role | null>(null);
	email = $state<string | null>(null);
	name = $state<string | null>(null);

	/**
	 * The Audit page is for owners and admins. In `legacy` the admin token *is*
	 * the owner credential, so a valid token session qualifies.
	 */
	get canViewSecurity(): boolean {
		if (this.status !== 'authed') return false;
		if (this.role === 'owner' || this.role === 'admin') return true;
		return this.role === null && this.authMode !== 'new';
	}

	/** Resolve the cookie session. Never throws: the layout renders the result. */
	async check(): Promise<SessionStatus> {
		this.status = 'unknown';
		this.error = null;

		// Once the deployment has said `new`, the token endpoint is not a question
		// worth asking again: in that mode it mints a cookie the console ignores.
		if (this.authMode === 'new') return this.checkAccount();

		try {
			const info = await getSession();
			this.status = 'authed';
			this.expiresAt = info.expires_at ?? null;
			// The token endpoint answered, so this is the gate that is live.
			this.authMode ??= 'legacy';
			return this.status;
		} catch (error) {
			if (!(error instanceof ApiError) || error.status !== 401) {
				this.status = 'offline';
				this.error = describeError(error);
				return this.status;
			}
		}

		return this.checkAccount();
	}

	/** The `new`-mode path: a Better Auth session, its role, and its expiry. */
	private async checkAccount(): Promise<SessionStatus> {
		try {
			this.applyMe(await getMe());
			return this.status;
		} catch (error) {
			if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
				this.clear();
				return this.status;
			}
			this.status = 'offline';
			this.error = describeError(error);
			return this.status;
		}
	}

	/** After a token sign-in. The token path only exists in the legacy gate. */
	markAuthed(expiresAt: number | null = null): void {
		this.status = 'authed';
		this.expiresAt = expiresAt;
		this.error = null;
		this.authMode ??= 'legacy';
	}

	/** After a passkey sign-in or an invite redemption. */
	applyMe(me: MeInfo): void {
		this.status = 'authed';
		this.expiresAt = me.expires_at ?? null;
		this.error = null;
		this.authMode = me.auth_mode;
		this.role = me.user.role;
		this.email = me.user.email;
		this.name = me.user.name;
	}

	clear(): void {
		this.status = 'anon';
		this.expiresAt = null;
		this.role = null;
		this.email = null;
		this.name = null;
	}
}

export const session = new SessionStore();
