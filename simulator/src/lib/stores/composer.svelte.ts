/**
 * The conversation's composer, kept outside the route so the bottom bar can be
 * rendered by the shell (the same slot the dock uses) while the thread itself
 * stays the route's business.
 *
 * The route binds `reload` so a send can end with the local database read back:
 * the optimistic row is only removed once the real row is on screen.
 */

import { app, type Message } from './app.svelte';

export type PendingReply = {
	key: string;
	peer: string;
	body: string;
	/** Local clock, so the row can show a mono time while it is queued. */
	created_at: number;
};

/** What the new-message screen gets back. Its text stays in the route. */
export type ComposeSendResult = { ok: true; peer: string } | { ok: false; reason: string };

/**
 * The one duplicate rule, used both to hide an optimistic row and to forget it:
 * a stored outbound row with the same body, at most a minute before the row the
 * screen painted. Keeping one function means the two can never disagree about
 * whether a bubble is a duplicate or still waiting.
 */
export function isAnswered(row: PendingReply, messages: Message[]): boolean {
	return messages.some(
		(message) =>
			message.direction === 'out' &&
			message.body === row.body &&
			message.created_at >= row.created_at - 60_000
	);
}

class ComposerStore {
	draft = $state('');
	sending = $state(false);
	/** The backend's exact words, or null. */
	failure = $state<string | null>(null);
	/** Rows written by the user that no database row has replaced yet. */
	pending = $state<PendingReply[]>([]);
	/** The route hides the bar on a thread with nothing in it. */
	repliesOpen = $state(true);
	/**
	 * The new-message form, kept outside its route so leaving the screen does
	 * not silently discard the recipient and the text. It lives for the session;
	 * a send that succeeds clears it.
	 */
	newMessage = $state({ to: '', body: '' });

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

	clearNewMessage(): void {
		this.newMessage.to = '';
		this.newMessage.body = '';
	}

	/**
	 * A database read has now answered these optimistic rows, so the store can
	 * forget them. The predicate is the conversation screen's duplicate rule.
	 */
	settle(peer: string, messages: Message[]): void {
		const answered = this.pending.filter(
			(row) => row.peer === peer && isAnswered(row, messages)
		);
		if (answered.length === 0) return;
		this.pending = this.pending.filter((row) => !answered.includes(row));
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

	/**
	 * Send from the new-message screen. The screen owns the text, so a refusal
	 * leaves it in place and returns the reason instead of restoring a draft in
	 * the reply bar. Everything else is the conversation's path: the optimistic
	 * row is written before the radio is asked, the thread reads the stored row
	 * back, and the state follows the receipt for a few seconds after landing.
	 */
	async sendTo(peer: string, body: string): Promise<ComposeSendResult> {
		if (this.sending) {
			return { ok: false, reason: 'The phone is already sending a message' };
		}
		if (body.trim().length === 0) {
			return { ok: false, reason: 'The message is empty' };
		}

		const key = `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.sending = true;
		// The row exists before the call, so the thread the operator lands on
		// already holds the message even when the database read is behind.
		this.pending = [...this.pending, { key, peer, body, created_at: Date.now() }];

		try {
			await app.sendSms(peer, body);
			// Nothing is bound on the form; the conversation that opens next
			// binds this and replaces the row with the stored one.
			await this.reload?.();
			void app.refreshSelected();
			for (const delay of [1200, 3500, 8000]) {
				setTimeout(() => void this.reload?.(), delay);
			}
			return { ok: true, peer };
		} catch (error) {
			this.pending = this.pending.filter((row) => row.key !== key);
			return { ok: false, reason: String(error) };
		} finally {
			this.sending = false;
		}
	}
}

export const composer = new ComposerStore();
