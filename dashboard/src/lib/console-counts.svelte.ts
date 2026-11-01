/**
 * The few deployment counts the shell shows beside the navigation.
 *
 * The layout owns one health read so the rail can carry real pill counts on
 * every route. Pages that already fetch health push their result in through
 * `note()`, so Overview does not need a second request just to feed the rail.
 * A failed read keeps the last known value: a pill must never invent a zero.
 *
 * Pending approvals are not in the health payload, so the layout asks for them
 * separately, and only for an operator who can see the Approvals screen. The
 * queue page pushes its own count in, so the two never disagree.
 */

import { getApprovals, getHealth } from './api';
import type { Health } from './types';

class ConsoleCounts {
	devices = $state<number | null>(null);
	messages = $state<number | null>(null);
	rules = $state<number | null>(null);
	openAlerts = $state<number | null>(null);
	approvals = $state<number | null>(null);

	private inFlight = false;
	private approvalsInFlight = false;

	note(health: Health): void {
		this.devices = health.counts?.devices ?? null;
		this.messages = health.counts?.messages ?? null;
		this.rules = health.counts?.rules ?? null;
		this.openAlerts = health.open_alerts ?? health.counts?.open_alerts ?? null;
	}

	/** The queue page already has the answer; the rail takes it rather than asking twice. */
	noteApprovals(count: number): void {
		this.approvals = count;
	}

	async refresh(includeApprovals = false): Promise<void> {
		// Start the extra read first so it overlaps the health call rather than
		// making every navigation wait for two round trips in a row.
		if (includeApprovals) void this.refreshApprovals();
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

	private async refreshApprovals(): Promise<void> {
		if (this.approvalsInFlight) return;
		this.approvalsInFlight = true;
		try {
			this.approvals = (await getApprovals()).length;
		} catch {
			// A count is a convenience; a failed read keeps the last known value.
		} finally {
			this.approvalsInFlight = false;
		}
	}
}

export const consoleCounts = new ConsoleCounts();
