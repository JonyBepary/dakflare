/** A recorded flow run, in words an operator can act on. */
export function runWord(outcome: string): string {
	switch (outcome) {
		case 'delivered':
			return 'Answered';
		case 'filtered':
			return 'No match';
		case 'halted':
			return 'Stopped before a reply';
		case 'no_trigger':
			return 'No trigger';
		case 'error':
			return 'Error';
		default:
			return outcome.replaceAll('_', ' ');
	}
}

export function runTone(outcome: string): 'ok' | 'warn' | 'danger' | 'neutral' {
	if (outcome === 'delivered') return 'ok';
	if (outcome === 'halted') return 'warn';
	if (outcome === 'error' || outcome === 'no_trigger') return 'danger';
	return 'neutral';
}
