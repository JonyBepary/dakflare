/**
 * Outbound command state — PROTOCOL_CONTRACT_V5 Rev C §6.
 *
 * The happy path is linear, but `DISPATCHED` may fall back to `PENDING` on an
 * ack timeout. The UI therefore tracks the furthest stage reached separately
 * from the current state: progress only ever moves forward, while the badge
 * always tells the truth about where the command is now.
 */

export const COMMAND_STEPS = [
	'PENDING',
	'DISPATCHED',
	'ACKED_BY_DEVICE',
	'SENT',
	'DELIVERED'
] as const;

export type CommandStep = (typeof COMMAND_STEPS)[number];

export const TERMINAL_COMMAND_STATES = new Set(['DELIVERED', 'FAILED', 'EXPIRED']);

export function isTerminalCommand(state: string | null | undefined): boolean {
	return state !== null && state !== undefined && TERMINAL_COMMAND_STATES.has(state);
}

/** Index in the linear happy path, or -1 for a terminal branch state. */
export function commandStepIndex(state: string | null | undefined): number {
	if (!state) return -1;
	return COMMAND_STEPS.indexOf(state as CommandStep);
}

export function commandStateNote(state: string | null | undefined): string {
	switch (state) {
		case 'PENDING':
			return 'Queued, waiting for the phone to pick it up.';
		case 'DISPATCHED':
			return 'Handed to the phone over its live link.';
		case 'ACKED_BY_DEVICE':
			return 'The phone accepted the command.';
		case 'SENT':
			return 'The phone handed the message to the SIM.';
		case 'DELIVERED':
			return 'The carrier confirmed delivery.';
		case 'FAILED':
			return 'The phone or carrier reported a failure.';
		case 'EXPIRED':
			return 'The command expired before the phone acknowledged it.';
		default:
			return 'Waiting for the first status.';
	}
}

export function commandStateTone(
	state: string | null | undefined
): 'ok' | 'warn' | 'danger' | 'accent' | 'muted' {
	switch (state) {
		case 'DELIVERED':
			return 'ok';
		case 'FAILED':
			return 'danger';
		case 'EXPIRED':
			return 'warn';
		case 'PENDING':
		case 'DISPATCHED':
		case 'ACKED_BY_DEVICE':
		case 'SENT':
			return 'accent';
		default:
			return 'muted';
	}
}
