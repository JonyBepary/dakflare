import { ApiError, describeError, getSession } from './api';

export type SessionStatus = 'unknown' | 'authed' | 'anon' | 'offline';

class SessionStore {
	status = $state<SessionStatus>('unknown');
	expiresAt = $state<number | null>(null);
	error = $state<string | null>(null);

	/** Resolve the cookie session. Never throws: the layout renders the result. */
	async check(): Promise<SessionStatus> {
		this.status = 'unknown';
		this.error = null;
		try {
			const info = await getSession();
			this.status = 'authed';
			this.expiresAt = info.expires_at ?? null;
		} catch (error) {
			if (error instanceof ApiError && error.status === 401) {
				this.clear();
			} else {
				this.status = 'offline';
				this.error = describeError(error);
			}
		}
		return this.status;
	}

	markAuthed(expiresAt: number | null = null): void {
		this.status = 'authed';
		this.expiresAt = expiresAt;
		this.error = null;
	}

	clear(): void {
		this.status = 'anon';
		this.expiresAt = null;
	}
}

export const session = new SessionStore();
