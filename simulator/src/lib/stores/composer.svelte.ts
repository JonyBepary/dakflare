/**
 * The conversation's composer, kept outside the route so the bottom bar can be
 * rendered by the shell (the same slot the dock uses) while the thread itself
 * stays the route's business.
 *
 * The route binds `reload` so a send can end with the local database read back:
 * the optimistic row is only removed once the real row is on screen.
 */

import { app } from './app.svelte';

export type PendingReply = {
	key: string;
	peer: string;
	body: string;
	/** Local clock, so the row can show a mono time while it is queued. */
	created_at: number;
};

class ComposerStore {
	draft = $state('');
	sending = $state(false);
	/** The backend's exact words, or null. */
	failure = $state<string | null>(null);
	/** Rows written by the user that no database row has replaced yet. */
	pending = $state<PendingReply[]>([]);
	/** The route hides the bar on a thread with nothing in it. */
	repliesOpen = $state(true);

	private reload: (() => Promise<void>) | null = null;

	/** Called by the conversation route; returns its unregister. */
	bind(reload: () => Promise<void>): () => void {
		this.reload = reload;
		return () => {
			if (this.reload === reload) this.reload = null;
		};
	}

	/** A new conversation starts with an empty box and no stale reason. */
	start(): void {
		this.draft = '';
		this.failure = null;
	}

	pendingFor(peer: string): PendingReply[] {
		return this.pending.filter((row) => row.peer === peer);
	}

	async send(peer: string): Promise<void> {
		const body = this.draft;
		if (this.sending || body.trim().length === 0) return;

		const key = `composer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.failure = null;
		this.sending = true;
		this.draft = '';
		// The row appears before the call, so the thread answers the tap even
		// when the radio takes its time.
		this.pending = [...this.pending, { key, peer, body, created_at: Date.now() }];

		try {
			await app.sendSms(peer, body);
			// Re-read the thread: the real row, with its real state, replaces the
			// optimistic one. Nothing is claimed about delivery.
			await this.reload?.();
			this.pending = this.pending.filter((row) => row.key !== key);
			// The thread list on the previous frame shows the same row; keep it true.
			void app.refreshSelected();
			// The row is `queued` until the radio answers, which is later than the
			// call above. Re-read a few times so the bubble ends on the state the
			// store actually holds instead of sitting on "Queued" until the thread
			// is reopened. Nothing here claims delivery; it only reports the receipt.
			for (const delay of [1200, 3500, 8000]) {
				setTimeout(() => void this.reload?.(), delay);
			}
		} catch (error) {
			this.pending = this.pending.filter((row) => row.key !== key);
			this.failure = String(error);
			this.draft = body;
		} finally {
			this.sending = false;
		}
	}
}

export const composer = new ComposerStore();
