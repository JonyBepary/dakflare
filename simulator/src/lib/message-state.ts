/** Send words for outbound rows. Inbound rows have no send state. */
export function sendStateWord(state: string): string {
	switch (state) {
		case 'queued':
			return 'Queued';
		case 'sending':
			return 'Sending';
		case 'sent':
			return 'Sent';
		case 'delivered':
			return 'Delivered';
		case 'failed':
			return 'Failed';
		default:
			// An unknown state is a word the phone does not know; show it rather
			// than invent one, but never an empty chip.
			return state.replaceAll('_', ' ');
	}
}

export function sendStateTone(state: string): 'ok' | 'warn' | 'danger' | 'neutral' {
	if (state === 'failed') return 'danger';
	if (state === 'queued') return 'warn';
	if (state === 'sent') return 'ok';
	return 'neutral';
}
