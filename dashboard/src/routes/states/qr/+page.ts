import { installStateStub } from './stub';

export type QrStateKey = 'default-200' | 'large-260' | 'rotate-long-url' | 'captionless' | 'empty-error';

const QR_STATE_KEYS: ReadonlyArray<QrStateKey> = [
	'default-200',
	'large-260',
	'rotate-long-url',
	'captionless',
	'empty-error'
];

function isQrState(raw: string | null): raw is QrStateKey {
	return raw !== null && (QR_STATE_KEYS as readonly string[]).includes(raw);
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: QrStateKey } {
	const asked = url.searchParams.get('__state');
	const state: QrStateKey = isQrState(asked) ? asked : 'default-200';
	installStateStub({
		handle: () => null
	});
	return { state };
}
