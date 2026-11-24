import { session } from '$lib/session.svelte';
import { DEFAULT_SECURITY_STATE, isSecurityState, type SecurityStateKey } from './fixtures';
import { installStub, scenarioFor } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: SecurityStateKey } {
	const raw = url.searchParams.get('__state');
	const state = isSecurityState(raw) ? raw : DEFAULT_SECURITY_STATE;

	if (typeof window !== 'undefined') {
		const scenario = scenarioFor(state);
		installStub(scenario);

		if (session.status === 'authed') {
			if (scenario.authMode === 'legacy') {
				session.clear();
				session.authMode = 'legacy';
				session.markAuthed(Date.now() + 8 * 3_600_000);
			} else {
				session.applyMe({
					ok: true,
					user: {
						id:
							scenario.role === 'member'
								? 'usr_rae_02'
								: scenario.role === 'admin'
									? 'usr_nadia_03'
									: 'usr_jony_01',
						email:
							scenario.role === 'member'
								? 'rae.molina@example.com'
								: scenario.role === 'admin'
									? 'nadia.karim@example.com'
									: 'jony@example.com',
						name:
							scenario.role === 'member'
								? 'Rae Molina'
								: scenario.role === 'admin'
									? 'Nadia Karim'
									: 'Jony Reyes',
						role: scenario.role,
						twoFactorEnabled: true
					},
					expires_at: Date.now() + 8 * 3_600_000,
					auth_mode: 'new'
				});
			}
		}
	}

	return { state };
}
