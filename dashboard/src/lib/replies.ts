/**
 * What became of a reply, in operator words (`docs/design-review/05` §2.1).
 *
 * The wire enum is four values and never reaches the screen. The four words are
 * the same ones `CommandTracker` uses for its stages, so a row, the tracker and
 * the drawer cannot drift: Queued → Sent → Delivered, with Failed as the branch.
 *
 * `reply_error` is the phone's own reason. It arrives as a radio result code in
 * some builds and as a sentence in others, so it is translated here: a known
 * code becomes the operator's phrase, prose is kept as written, and a code this
 * console does not know is admitted rather than guessed at.
 */

import type { Message } from './types';

export type ReplyFateState = 'queued' | 'sent' | 'failed' | 'delivered' | 'unknown';

export interface ReplyFate {
	state: ReplyFateState;
	/** The phone's raw reason, only when the reply failed. */
	error: string | null;
}

const KNOWN_STATES = new Set(['queued', 'sent', 'failed', 'delivered']);

/**
 * `null` when the row carries no fate: an older row, a send the phone never
 * reported, or a message that was never answered. An unrecognised value is
 * `unknown`, never silently dropped — a failure must not disappear because the
 * contract grew.
 */
export function replyFateOf(
	message: Pick<Message, 'reply_state' | 'reply_error'>
): ReplyFate | null {
	const state = message.reply_state;
	if (!state) return null;
	if (!KNOWN_STATES.has(state)) {
		return { state: 'unknown', error: message.reply_error ?? null };
	}
	return {
		state: state as ReplyFateState,
		error: state === 'failed' ? (message.reply_error ?? null) : null
	};
}

/**
 * One fate per row, for a loaded window of messages.
 *
 * Only the outbound row carries a fate; the inbound row is `null` by contract.
 * A question therefore reads the reply row whose id is `reply_command_id` (the
 * command id is the outbound message id on the send path). When that row is
 * outside the window, the question has no fate to show — the console does not
 * guess that a reply failed.
 */
export function replyFatesOf(messages: Message[]): Map<string, ReplyFate> {
	const map = new Map<string, ReplyFate>();
	for (const message of messages) {
		if (message.direction !== 'out') continue;
		const fate = replyFateOf(message);
		if (fate) map.set(message.id, fate);
	}
	for (const message of messages) {
		if (message.direction !== 'in' || !message.reply_command_id) continue;
		const fate = map.get(message.reply_command_id);
		if (fate) map.set(message.id, fate);
	}
	return map;
}

const WORDS: Record<ReplyFateState, string> = {
	queued: 'Queued',
	sent: 'Sent',
	delivered: 'Delivered',
	failed: 'Failed',
	unknown: 'Unknown'
};

export function replyFateWord(state: ReplyFateState): string {
	return WORDS[state];
}

/**
 * Reason phrases, most specific first. Each is written to follow an em dash and
 * to say what the phone or carrier did, not which integer it returned.
 */
const REASONS: Array<[RegExp, string]> = [
	[/no[_\s-]?service|out[_\s-]?of[_\s-]?service/, 'no signal'],
	[/radio[_\s-]?off|flight[_\s-]?mode|airplane/, 'the radio was off'],
	[/no[_\s-]?signal|signal[_\s-]?lost/, 'no signal'],
	[
		/permission|not[_\s-]?allowed|denied|forbidden|unauthori[sz]ed/,
		'the app is not allowed to send SMS'
	],
	[/queue[_\s-]?full|storage[_\s-]?full|out[_\s-]?of[_\s-]?space/, 'the phone’s queue was full'],
	[/no[_\s-]?credit|balance|insufficient/, 'the SIM has no credit'],
	[/blocked|restricted|barred/, 'the carrier blocked it'],
	[/expire/, 'it expired before the phone collected it'],
	[
		/offline|unreachable|timeout|timed[_\s-]?out|no[_\s-]?response|not[_\s-]?connected/,
		'the phone never reported back'
	],
	[/invalid|destination|recipient|number/, 'the carrier rejected the number'],
	[/\bsim\b|sim[_\s-]|subscription/, 'the SIM was not available'],
	[/generic|unknown[_\s-]?error|unexpected|failure|refused/, 'the radio refused it']
];

/** A sentence when the phone sent one; a phrase built from its code otherwise. */
export function replyReason(raw: string | null | undefined): string {
	const text = (raw ?? '').trim();
	if (text === '') return 'the phone could not send it';

	const key = text.toLowerCase();
	for (const [pattern, phrase] of REASONS) {
		if (pattern.test(key)) return phrase;
	}

	if (looksLikeCode(text)) return 'a failure this console does not recognise';
	return tidyProse(text);
}

/** `RESULT_ERROR_…`, `SEND_FAILED`, `E123`: a code, not something a person wrote. */
function looksLikeCode(text: string): boolean {
	if (/\s/.test(text)) return false;
	return text.includes('_') || /^[A-Z0-9._-]+$/.test(text);
}

/** Prose follows an em dash, so it starts lower case and loses its full stop. */
function tidyProse(text: string): string {
	const out = text.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().replace(/[.;]+$/, '');
	if (/^[A-Z][a-z]/.test(out)) return out.charAt(0).toLowerCase() + out.slice(1);
	return out;
}

/**
 * The sentence behind the word, for a tooltip. It keeps the phone's raw reason
 * and the raw state: support can quote them, and the operator never sees them.
 */
export function replyFateNote(fate: ReplyFate): string {
	const reported = fate.error?.trim() ? ` Reported: ${fate.error.trim()}.` : '';
	let sentence: string;
	switch (fate.state) {
		case 'queued':
			sentence = 'Queued. The phone has not confirmed it has the reply yet.';
			break;
		case 'sent':
			sentence = 'The phone handed it to the radio. The carrier has not confirmed delivery.';
			break;
		case 'delivered':
			sentence = 'The carrier confirmed delivery.';
			break;
		case 'failed':
			sentence = `The reply failed: ${replyReason(fate.error)}.`;
			break;
		default:
			sentence = 'The gateway reported a reply state this console does not know.';
			break;
	}
	const state = fate.state === 'unknown' ? '' : ` State: ${fate.state}.`;
	return `${sentence}${reported}${state}`;
}
