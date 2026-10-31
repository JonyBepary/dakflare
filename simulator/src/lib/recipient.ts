/**
 * Who a new message may be addressed to.
 *
 * A reply always has a sender to answer, so `reply-target.ts` can decide from
 * the thread alone. A new message has no sender: the operator types the
 * recipient, and this file says whether that exact string can be dialled.
 *
 * No separator is stripped, no country code is added and no number is
 * shortened. What the screen shows under the field as "Dials …" is the string
 * handed to `send_sms`, so the operator can see the value before it leaves.
 *
 * A mask and a shortcode are refused for the same reason the reply composer
 * refuses them: they are senders that cannot receive replies. The masks are
 * checked before the format rule, because a mask is a considered sender id,
 * not a typo in a number.
 */

import { isMaskSender, isShortcode } from './reply-target';

/** E.164 tops out at 15 digits; below 7 is not a number a phone can dial. */
export const MIN_DIGITS = 7;
export const MAX_DIGITS = 15;

export type RecipientProblemCode =
	| 'empty'
	| 'mask'
	| 'shortcode'
	| 'characters'
	| 'short'
	| 'long';

export type RecipientCheck =
	| { ok: true; to: string; digits: number }
	| {
			ok: false;
			code: RecipientProblemCode;
			/** The sentence, without its count; the screen sets the count in mono. */
			reason: string;
			/** The digits counted, present only for `short` and `long`. */
			count?: number;
	  };

export function checkRecipient(raw: string): RecipientCheck {
	const to = raw.trim();

	if (to.length === 0) {
		return { ok: false, code: 'empty', reason: 'Enter the number to send to' };
	}

	if (isMaskSender(to)) {
		return {
			ok: false,
			code: 'mask',
			reason:
				'This sender is a mask, a sender that cannot receive replies; messages are not sent to it'
		};
	}

	if (isShortcode(to)) {
		return {
			ok: false,
			code: 'shortcode',
			reason:
				'This sender is a shortcode, a sender that cannot receive replies; messages are not sent to it'
		};
	}

	// The field accepts a leading `+` and digits, nothing else. Spaces, dashes
	// and brackets are refused rather than quietly removed: the operator should
	// never discover that the number dialled was not the one on screen.
	if (!/^\+?\d+$/.test(to)) {
		return {
			ok: false,
			code: 'characters',
			reason: 'Use digits only, with an optional leading +'
		};
	}

	const digits = to.startsWith('+') ? to.length - 1 : to.length;

	if (digits < MIN_DIGITS) {
		return {
			ok: false,
			code: 'short',
			reason: `A phone number needs at least ${MIN_DIGITS} digits; this one has`,
			count: digits
		};
	}

	if (digits > MAX_DIGITS) {
		return {
			ok: false,
			code: 'long',
			reason: `A phone number has at most ${MAX_DIGITS} digits; this one has`,
			count: digits
		};
	}

	return { ok: true, to, digits };
}

/** The whole sentence as one string, for a title or aria-label. */
export function recipientWords(check: RecipientCheck): string {
	if (check.ok) return `Dials ${check.to}`;
	return check.count === undefined ? check.reason : `${check.reason} ${check.count}`;
}
