/**
 * Outbound command state — PROTOCOL_CONTRACT_V5 Rev C §6.
 *
 * The happy path is linear, but `LEASED` may fall back to `PENDING` when its
 * 60 s lease expires. The UI therefore tracks the furthest stage reached separately
 * from the current state: progress only ever moves forward, while the label
 * always tells the truth about where the command is now.
 *
 * The wire enum never reaches the screen (`docs/design-review/05` §2.1). Every
 * state has one operator word, and the raw value survives only in a `title` so
 * support can still quote it.
 */

import { replyReason } from './replies';
import type { CommandInfo } from './types';

export const COMMAND_STEPS = [
	'PENDING',
	'LEASED',
	'DISPATCHED',
	'SENT',
	'DELIVERED'
] as const;

export type CommandStep = (typeof COMMAND_STEPS)[number];

/** Stage names in operator words: each step reads differently from its neighbour. */
export const COMMAND_STEP_LABELS: Record<CommandStep, string> = {
	PENDING: 'Queued',
	LEASED: 'Handed over',
	DISPATCHED: 'Received',
	SENT: 'Sent',
	DELIVERED: 'Delivered'
};

const STATE_LABELS = {
	PENDING: 'Queued',
	LEASED: 'Handed over',
	DISPATCHED: 'Received',
	SENT: 'Sent',
	DELIVERED: 'Delivered',
	FAILED: 'Failed',
	EXPIRED: 'Not sent'
} as const satisfies Record<string, string>;

const STATE_NOTES = {
	PENDING: 'Queued. The phone collects it when it next checks in.',
	LEASED: 'Handed to the phone over its live link. It has not confirmed it accepted it yet.',
	DISPATCHED: 'The phone confirmed it has it and is sending it now.',
	SENT: 'The phone handed it to the radio. The carrier has not confirmed delivery.',
	DELIVERED: 'The carrier confirmed delivery.',
	FAILED: 'The phone could not send it.',
	EXPIRED: 'The phone never collected it. Nothing was sent.'
} as const satisfies Record<string, string>;

export const TERMINAL_COMMAND_STATES = new Set(['DELIVERED', 'FAILED', 'EXPIRED']);

export function isTerminalCommand(state: string | null | undefined): boolean {
	return state !== null && state !== undefined && TERMINAL_COMMAND_STATES.has(state);
}

/** Index in the linear happy path, or -1 for a terminal branch state. */
export function commandStepIndex(state: string | null | undefined): number {
	if (!state) return -1;
	return COMMAND_STEPS.indexOf(state as CommandStep);
}

/** The one word the operator reads. Unknown values stay honest rather than blank. */
export function commandStateLabel(state: string | null | undefined): string {
	if (!state) return 'Unknown';
	return (STATE_LABELS as Record<string, string>)[state] ?? 'Unknown';
}

export function commandStepLabel(step: CommandStep): string {
	return COMMAND_STEP_LABELS[step];
}

export function commandStateNote(state: string | null | undefined): string {
	if (!state) return 'The gateway has not reported a state for this message.';
	return (
		(STATE_NOTES as Record<string, string>)[state] ??
		'The gateway reported a state this console does not know. Its raw value is in the tooltip.'
	);
}

export function commandStateTone(
	state: string | null | undefined
): 'ok' | 'warn' | 'danger' | 'accent' | 'muted' {
	switch (state) {
		case 'DELIVERED':
		case 'SENT':
			return 'ok';
		case 'DISPATCHED':
			return 'accent';
		case 'FAILED':
			return 'danger';
		case 'EXPIRED':
			return 'warn';
		case 'PENDING':
		case 'LEASED':
			return 'muted';
		default:
			return 'muted';
	}
}

/**
 * What a failed command carries: the reason, when there is one.
 *
 * Two different senders answer for a failure. A channel that could not queue the
 * message at all writes a code of its own (`no_paired_handset`), while a phone
 * that tried and failed reports a radio result code. The phone's code
 * translations live in `replies.ts` because the messages list already reads them
 * and the two screens must not disagree about what "no signal" means.
 *
 * `null` for every state that is not a failure, and a sentence that admits the
 * gap when the command failed without a reason. Guessing one would be worse than
 * saying so: the trace expander is where the missing detail can be found.
 */
export function commandFailureReason(command: CommandInfo | null | undefined): string | null {
	const state = command?.state;
	if (state !== 'FAILED' && state !== 'EXPIRED') return null;

	const written = (command?.error_message ?? '').trim();
	if (written !== '') return withStop(written);

	const code = (command?.error_code ?? '').trim();
	if (code !== '') {
		const gateway = GATEWAY_CODES[code];
		if (gateway !== undefined) return gateway;

		const channel = /^(telegram|whatsapp)_error_(\d+)$/.exec(code);
		if (channel !== null) {
			const name = channel[1] === 'telegram' ? 'Telegram' : 'WhatsApp';
			return `${name} answered HTTP ${channel[2]}.`;
		}

		const phone = replyReason(code);
		// The same sentence `replies.ts` uses for a code it cannot read.
		if (phone === 'a failure this console does not recognise') {
			return `The command failed with code ${code}, which this console does not read.`;
		}
		return `The phone reported it failed: ${phone}.`;
	}

	if (state === 'EXPIRED') {
		return 'The phone did not collect it before its window closed, so nothing was sent.';
	}
	return 'The phone reported the send failed, and did not say why.';
}

/**
 * A channel that refused to queue the message, in a sentence. These are the
 * Worker's own codes (`worker/src/channels/`), and each names the thing to fix.
 */
const GATEWAY_CODES: Record<string, string> = {
	no_paired_handset: 'No handset is paired, so there was nothing to send it with.',
	enqueue_failed: 'The gateway could not queue it for the phone.',
	telegram_bot_token_missing: 'This deployment has no Telegram bot token.',
	whatsapp_credentials_missing: 'This deployment has no WhatsApp credentials.',
	template_required: 'WhatsApp needs an approved template for this message.'
};

function withStop(sentence: string): string {
	return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}
