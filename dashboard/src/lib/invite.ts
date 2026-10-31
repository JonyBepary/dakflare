/**
 * Invite parsing for the console.
 *
 * The CLI prints `dakflare://invite?u=<worker url>&t=<token>` (cli/bin/dakflare.js),
 * and the same token may arrive as a bare string from an owner who pasted it
 * into a message. Both are accepted; nothing else is guessed at.
 */

export interface InviteLink {
	token: string;
	/** The deployment the link names, when it names one. */
	origin: string | null;
}

/** `dki_` + base64url(32 bytes), but any token-shaped string goes to the Worker. */
const BARE_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;

export function readInvite(input: string | null | undefined): InviteLink | null {
	if (typeof input !== 'string') return null;
	const value = input.trim();
	if (value === '') return null;

	if (BARE_TOKEN.test(value)) return { token: value, origin: null };

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	const token = url.searchParams.get('t') ?? url.searchParams.get('token') ?? url.searchParams.get('code');
	if (token === null || !BARE_TOKEN.test(token)) return null;

	if (url.protocol === 'dakflare:' && url.host === 'invite') {
		const target = url.searchParams.get('u');
		return { token, origin: target === null ? null : safeOrigin(target) };
	}

	// An https link to a console's invite page, e.g. .../admin/invite?code=…
	if (url.protocol === 'https:' || url.protocol === 'http:') {
		return { token, origin: url.origin };
	}

	return null;
}

function safeOrigin(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}
