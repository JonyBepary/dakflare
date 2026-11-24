import { session } from '$lib/session.svelte';
import { DEFAULT_AUDIT_STATE, isAuditState, type AuditStateKey } from './fixtures';
import { installStub, scenarioFor } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: AuditStateKey } {
	const raw = url.searchParams.get('__state');
	const state = isAuditState(raw) ? raw : DEFAULT_AUDIT_STATE;

	if (typeof window !== 'undefined') {
		const scenario = scenarioFor(state);
		installStub(scenario);

		if (session.status === 'authed') {
			session.applyMe({
				ok: true,
				user: {
					id: scenario.role === 'member' ? 'usr_rae_02' : 'usr_jony_01',
					email: scenario.role === 'member' ? 'rae.molina@example.com' : 'jony@example.com',
					name: scenario.role === 'member' ? 'Rae Molina' : 'Jony Reyes',
					role: scenario.role,
					twoFactorEnabled: true
				},
				expires_at: Date.now() + 8 * 60 * 60 * 1000,
				auth_mode: 'new'
			});
		}
	}

	return { state };
}
