/**
 * Who can be answered from this phone, decided from facts the shell already
 * holds so the composer can be disabled with a reason *before* the radio is
 * asked. The backend still has the last word; a refusal it returns is shown
 * verbatim (see `Composer.svelte`).
 *
 * Order matters. A mask or a shortcode can never be answered from here, so that
 * reason outranks a switch that can be turned back on.
 */

import type { Device, DeviceFacts } from './stores/app.svelte';

export type ReplyBlockCode = 'mask' | 'shortcode' | 'no-device' | 'permission' | 'carrier-off';

export type ReplyBlock = { code: ReplyBlockCode; reason: string };

/** The route holds the peer encoded; a malformed link should still open. */
export function decodePeer(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * A carrier mask is an alphanumeric sender id: it has letters in it. Any
 * script counts, so a Bangla sender id is a mask too, not a number to dial.
 */
export function isMaskSender(peer: string): boolean {
	return /\p{L}/u.test(peer);
}

/** A shortcode is a bare run of digits too short to be a phone number. */
export function isShortcode(peer: string): boolean {
	const trimmed = peer.trim();
	if (trimmed.startsWith('+')) return false;
	const digits = trimmed.replace(/[\s().-]/g, '');
	return /^\d{3,6}$/.test(digits);
}

/**
 * The radio-side reasons only, for a screen that chooses its own recipient.
 * The wording is shared with the reply composer so the two never drift.
 */
export function sendBlock(input: {
	device: Device | null;
	facts: DeviceFacts | null;
	offline: boolean;
}): ReplyBlock | null {
	if (!input.device) {
		return { code: 'no-device', reason: 'No device is selected on this phone' };
	}
	// A missing fact is unknown, never a guess: when Android has not written
	// the permissions row, the composer stays open and the radio answers.
	const send = input.facts?.permissions?.send;
	const receive = input.facts?.permissions?.sms;
	if (send === false || receive === false) {
		return { code: 'permission', reason: 'SMS permission is not granted' };
	}
	if (input.offline) {
		return { code: 'carrier-off', reason: 'The carrier is off on this phone' };
	}
	return null;
}

export function replyBlock(input: {
	peer: string;
	device: Device | null;
	facts: DeviceFacts | null;
	offline: boolean;
}): ReplyBlock | null {
	if (isMaskSender(input.peer)) {
		return { code: 'mask', reason: 'This sender is a mask; replies are not sent to it' };
	}
	if (isShortcode(input.peer)) {
		return { code: 'shortcode', reason: 'This sender is a shortcode; replies are not sent to it' };
	}
	return sendBlock(input);
}
