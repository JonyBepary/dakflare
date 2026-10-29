/**
 * The few deployment counts the shell shows beside the navigation.
 *
 * The layout owns one health read so the rail can carry real pill counts on
 * every route. Pages that already fetch health push their result in through
 * `note()`, so Overview does not need a second request just to feed the rail.
 * A failed read keeps the last known value: a pill must never invent a zero.
 */

import { getHealth } from './api';
import type { Health } from './types';

class ConsoleCounts {
	devices = $state<number | null>(null);
	messages = $state<number | null>(null);
	rules = $state<number | null>(null);
	openAlerts = $state<number | null>(null);

	private inFlight = false;

	note(health: Health): void {
		this.devices = health.counts?.devices ?? null;
		this.messages = health.counts?.messages ?? null;
		this.rules = health.counts?.rules ?? null;
		this.openAlerts = health.open_alerts ?? health.counts?.open_alerts ?? null;
	}

	async refresh(): Promise<void> {
		if (this.inFlight) return;
		this.inFlight = true;
		try {
			const { health } = await getHealth();
			this.note(health);
		} catch {
			// The page owns the error message; the rail keeps its last values.
		} finally {
			this.inFlight = false;
		}
	}
}

export const consoleCounts = new ConsoleCounts();
