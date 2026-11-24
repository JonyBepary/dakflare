import type { Invite, PasskeySummary } from '$lib/types';
import type { StateGroup } from './StateSwitcher.svelte';

export type SecurityStateKey =
	| 'loading'
	| 'member-no-access'
	| 'legacy-admin-token'
	| 'totp-off-ready'
	| 'passkeys-none-pw-only'
	| 'passkeys-error'
	| 'totp-unavailable-missing'
	| 'totp-unavailable-no-secret'
	| 'totp-unavailable-disabled'
	| 'totp-signed-out'
	| 'totp-probe-error'
	| 'totp-enrol-starting'
	| 'totp-enrol-qr'
	| 'totp-enrol-verifying'
	| 'totp-enrol-code-error'
	| 'totp-enrol-codes-reveal'
	| 'totp-on'
	| 'totp-disable-open'
	| 'totp-disable-pending'
	| 'totp-disable-error'
	| 'totp-disabled-notice'
	| 'codes-regenerate-dialog'
	| 'codes-regenerate-pending'
	| 'codes-regenerate-error'
	| 'codes-regenerated-reveal'
	| 'pw-health-error'
	| 'pw-no-pepper'
	| 'pw-status-unknown'
	| 'pw-client-not-set'
	| 'pw-server-set'
	| 'pw-form-strength'
	| 'pw-form-saving'
	| 'pw-form-error'
	| 'pw-saved-notice'
	| 'pw-remove-with-password'
	| 'pw-remove-with-totp'
	| 'pw-remove-pending'
	| 'pw-remove-error'
	| 'pw-removed-notice'
	| 'invites-empty'
	| 'invites-error-403'
	| 'invites-error-offline'
	| 'invites-mint-admin-warn'
	| 'invites-mint-pending'
	| 'invites-mint-conflict'
	| 'invites-mint-revealed'
	| 'invites-revoke-confirm'
	| 'invites-remove-expired-confirm'
	| 'invites-revoke-pending'
	| 'invites-revoke-error'
	| 'invites-revoke-gone';

export const SECURITY_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Access',
		states: [
			{ key: 'loading', label: 'Loading security factors' },
			{ key: 'member-no-access', label: 'Member session (no access)' },
			{ key: 'legacy-admin-token', label: 'Legacy admin token session' }
		]
	},
	{
		heading: 'Passkey & TOTP',
		states: [
			{ key: 'totp-off-ready', label: 'Passkeys listed, TOTP off' },
			{ key: 'passkeys-none-pw-only', label: 'No passkeys (pw-only lock)' },
			{ key: 'passkeys-error', label: 'Passkey list unreadable' },
			{ key: 'totp-unavailable-missing', label: 'TOTP not mounted (404)' },
			{ key: 'totp-unavailable-no-secret', label: 'Missing auth secret (503)' },
			{ key: 'totp-unavailable-disabled', label: 'TOTP disabled in options' },
			{ key: 'totp-signed-out', label: 'Factor probe expired (401)' },
			{ key: 'totp-probe-error', label: 'Factor probe gateway error' },
			{ key: 'totp-enrol-starting', label: 'Starting TOTP setup' },
			{ key: 'totp-enrol-qr', label: 'TOTP QR & manual secret' },
			{ key: 'totp-enrol-verifying', label: 'Verifying setup code' },
			{ key: 'totp-enrol-code-error', label: 'Setup code rejected' },
			{ key: 'totp-enrol-codes-reveal', label: 'Setup complete (codes reveal)' },
			{ key: 'totp-on', label: 'Authenticator on' },
			{ key: 'totp-disable-open', label: 'Turn off TOTP form open' },
			{ key: 'totp-disable-pending', label: 'Turning off TOTP' },
			{ key: 'totp-disable-error', label: 'Turn off code rejected' },
			{ key: 'totp-disabled-notice', label: 'TOTP turned off notice' }
		]
	},
	{
		heading: 'Recovery codes',
		states: [
			{ key: 'codes-regenerate-dialog', label: 'Replace codes dialog' },
			{ key: 'codes-regenerate-pending', label: 'Replacing recovery codes' },
			{ key: 'codes-regenerate-error', label: 'Replace code rejected' },
			{ key: 'codes-regenerated-reveal', label: 'New codes revealed' }
		]
	},
	{
		heading: 'Password',
		states: [
			{ key: 'pw-health-error', label: 'Password mode unreadable' },
			{ key: 'pw-no-pepper', label: 'Missing AUTH_PEPPER secret' },
			{ key: 'pw-status-unknown', label: 'Linked accounts unreadable' },
			{ key: 'pw-client-not-set', label: 'Client-derived, not set' },
			{ key: 'pw-server-set', label: 'Server-KDF, password set' },
			{ key: 'pw-form-strength', label: 'Set password form + meter' },
			{ key: 'pw-form-saving', label: 'Deriving & saving password' },
			{ key: 'pw-form-error', label: 'Mode mismatch refusal' },
			{ key: 'pw-saved-notice', label: 'Password saved notice' },
			{ key: 'pw-remove-with-password', label: 'Remove password (via pw)' },
			{ key: 'pw-remove-with-totp', label: 'Remove password (via TOTP)' },
			{ key: 'pw-remove-pending', label: 'Removing password' },
			{ key: 'pw-remove-error', label: 'Removal proof rejected' },
			{ key: 'pw-removed-notice', label: 'Password removed notice' }
		]
	},
	{
		heading: 'Invites',
		states: [
			{ key: 'invites-empty', label: 'No invites yet' },
			{ key: 'invites-error-403', label: 'Invites forbidden (403)' },
			{ key: 'invites-error-offline', label: 'Invites offline / failed' },
			{ key: 'invites-mint-admin-warn', label: 'Mint form (admin warn)' },
			{ key: 'invites-mint-pending', label: 'Minting invite' },
			{ key: 'invites-mint-conflict', label: 'Mint refused (registered)' },
			{ key: 'invites-mint-revealed', label: 'Minted invite revealed' },
			{ key: 'invites-revoke-confirm', label: 'Revoke open invite dialog' },
			{ key: 'invites-remove-expired-confirm', label: 'Remove expired row dialog' },
			{ key: 'invites-revoke-pending', label: 'Revoking invite' },
			{ key: 'invites-revoke-error', label: 'Revoke refused (403)' },
			{ key: 'invites-revoke-gone', label: 'Invite already gone (404)' }
		]
	}
];

export const DEFAULT_SECURITY_STATE: SecurityStateKey = 'totp-off-ready';

const VALID_KEYS = new Set<string>(
	SECURITY_GROUPS.flatMap((group) => group.states.map((item) => item.key))
);

export function isSecurityState(value: string | null): value is SecurityStateKey {
	return value !== null && VALID_KEYS.has(value);
}

const NOW = Date.now();

export const SAMPLE_PASSKEYS: PasskeySummary[] = [
	{
		id: 'pk_yubikey_5c_01',
		name: 'YubiKey 5C NFC (Work)',
		createdAt: new Date(NOW - 32 * 86_400_000).toISOString()
	},
	{
		id: 'pk_pixel_6a_02',
		name: null,
		createdAt: new Date(NOW - 6 * 86_400_000).toISOString()
	}
];

export const SAMPLE_INVITES: Invite[] = [
	{
		id: 'inv_open_nadia_01',
		email: 'nadia.karim@example.com',
		role: 'admin',
		expires_at: NOW + 5 * 86_400_000,
		used_at: null,
		created_by: 'usr_jony_01',
		created_at: NOW - 2 * 3_600_000
	},
	{
		id: 'inv_used_tariq_02',
		email: 'tariq.ops@example.com',
		role: 'member',
		expires_at: NOW + 3 * 86_400_000,
		used_at: NOW - 19 * 3_600_000,
		created_by: 'usr_jony_01',
		created_at: NOW - 4 * 86_400_000
	},
	{
		id: 'inv_expired_farah_03',
		email: 'farah.dispatch@example.com',
		role: 'member',
		expires_at: NOW - 2 * 86_400_000,
		used_at: null,
		created_by: 'usr_jony_01',
		created_at: NOW - 9 * 86_400_000
	}
];

export const SAMPLE_TOTP_URI =
	'otpauth://totp/DakFlare:jony%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=DakFlare&digits=6&period=30';

export const SAMPLE_BACKUP_CODES = [
	'A4K9-M2P7',
	'B7N3-Q8R2',
	'C5T6-V9W4',
	'D2X8-Y6Z3',
	'E9F4-G7H5',
	'J3K6-L8M2',
	'N5P9-R4S7',
	'T2V6-W3X8',
	'Y7Z4-A9B5',
	'C8D3-E6F2'
];

export const REGENERATED_BACKUP_CODES = [
	'P9Q2-R4S6',
	'T7U3-V5W8',
	'X2Y9-Z4A6',
	'B5C8-D3E7',
	'F4G9-H2J6',
	'K8L3-M5N9',
	'P2Q7-R6S4',
	'T3U8-V9W2',
	'X6Y4-Z7A3',
	'B9C2-D5E8'
];
