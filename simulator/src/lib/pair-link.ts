/**
 * Read the one link `dakflare pair` prints: `dakflare://pair?u=…&c=…`.
 *
 * The Rust side already parses this when the operator pastes it (core
 * `parse_pair_link`). This copy exists because the Android shell hands the link
 * over as a route query parameter, and Settings must fill two fields from it
 * before any command runs. Strict on purpose and identical to the Rust rules:
 * host `pair`, an http(s) `u`, and a 12-hex-character `c`. A link that fails
 * here is rejected with a sentence rather than half-applied.
 */
export type PairLink = { baseUrl: string; code: string };

const CODE = /^[0-9a-fA-F]{12}$/;

export function readPairLink(input: string | null | undefined): PairLink | null {
	if (typeof input !== 'string') return null;
	const value = input.trim();
	if (value === '') return null;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== 'dakflare:' || url.host.toLowerCase() !== 'pair') return null;

	const baseUrl = (url.searchParams.get('u') ?? '').trim();
	const code = (url.searchParams.get('c') ?? '').trim();
	if (baseUrl === '' || !CODE.test(code)) return null;

	try {
		const target = new URL(baseUrl);
		if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
		if (target.hostname === '') return null;
	} catch {
		return null;
	}

	return { baseUrl: baseUrl.replace(/\/+$/, ''), code: code.toUpperCase() };
}
