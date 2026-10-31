/**
 * Outbound command state — PROTOCOL_CONTRACT_V5 Rev C §6.
 *
 * The happy path is linear, but `DISPATCHED` may fall back to `PENDING` on an
 * ack timeout. The UI therefore tracks the furthest stage reached separately
 * from the current state: progress only ever moves forward, while the label
 * always tells the truth about where the command is now.
 *
 * The wire enum never reaches the screen (`docs/design-review/05` §2.1). Every
 * state has one operator word, and the raw value survives only in a `title` so
 * support can still quote it.
 */

export const COMMAND_STEPS = [
	'PENDING',
	'DISPATCHED',
	'ACKED_BY_DEVICE',
	'SENT',
	'DELIVERED'
] as const;

export type CommandStep = (typeof COMMAND_STEPS)[number];

/** Stage names in operator words: each step reads differently from its neighbour. */
export const COMMAND_STEP_LABELS: Record<CommandStep, string> = {
	PENDING: 'Queued',
	DISPATCHED: 'Handed over',
	ACKED_BY_DEVICE: 'Received',
	SENT: 'Sent',
	DELIVERED: 'Delivered'
};

const STATE_LABELS = {
	PENDING: 'Queued',
	DISPATCHED: 'Queued',
	ACKED_BY_DEVICE: 'Received',
	SENT: 'Sent',
	DELIVERED: 'Delivered',
	FAILED: 'Failed',
	EXPIRED: 'Not sent'
} as const satisfies Record<string, string>;

const STATE_NOTES = {
	PENDING: 'Queued. The phone collects it when it next checks in.',
	DISPATCHED: 'Queued. Handed to the phone over its live link; waiting for it to accept.',
	ACKED_BY_DEVICE: 'The phone has it and is sending it now.',
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
		case 'ACKED_BY_DEVICE':
			return 'accent';
		case 'FAILED':
			return 'danger';
		case 'EXPIRED':
			return 'warn';
		case 'PENDING':
		case 'DISPATCHED':
			return 'muted';
		default:
			return 'muted';
	}
}
