/** Send words for outbound rows. Inbound rows have no send state. */
export function sendStateWord(state: string): string {
	switch (state) {
		case 'queued':
			return 'Queued';
		case 'sent':
			return 'Sent';
		case 'failed':
			return 'Failed';
		default:
			return state;
	}
}

export function sendStateTone(state: string): 'ok' | 'warn' | 'danger' | 'neutral' {
	if (state === 'failed') return 'danger';
	if (state === 'queued') return 'warn';
	if (state === 'sent') return 'ok';
	return 'neutral';
}
