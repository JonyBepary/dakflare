<script lang="ts">
	import { replyFateNote, replyFateWord, replyReason, type ReplyFateState } from '$lib/replies';
	import Icon, { type IconName } from './Icon.svelte';

	/**
	 * One phrase for what became of a reply.
	 *
	 * `variant="out"` reads the reply row: `Delivered`, `Sent`, `Queued`,
	 * `Failed — …`. `variant="in"` reads the question and only ever appears for
	 * a failure, so a thread that was answered (and refused) cannot look
	 * unanswered: `Reply failed — …`, with a link to the reply row when it is in
	 * the log.
	 *
	 * The word carries the meaning; the glyph repeats it for a glance; colour is
	 * a third, quiet signal. Only failure takes an ink, and only this phrase —
	 * the row around it stays a log row.
	 */
	let {
		state,
		error = null,
		variant = 'out',
		href = null,
		onfollow = null
	}: {
		state: ReplyFateState;
		error?: string | null;
		variant?: 'out' | 'in';
		href?: string | null;
		onfollow?: (() => void) | null;
	} = $props();

	const failed = $derived(state === 'failed');
	const word = $derived(variant === 'in' ? 'Reply failed' : replyFateWord(state));
	const reason = $derived(failed ? replyReason(error) : null);
	const note = $derived(replyFateNote({ state, error }));

	const glyphs: Record<ReplyFateState, IconName> = {
		queued: 'clock',
		sent: 'send',
		delivered: 'check',
		failed: 'alert',
		unknown: 'info'
	};

	function follow(event: MouseEvent): void {
		if (!onfollow) return;
		event.preventDefault();
		onfollow();
	}
</script>

{#if variant === 'out' || failed}
	<span class="fate" data-state={state} title={note}>
		<span class="fate-word">{word}</span>
		{#if reason}<span class="fate-reason">— {reason}</span>{/if}
		<span class="fate-glyph" aria-hidden="true"><Icon name={glyphs[state]} size={11} /></span>
		{#if href}
			<a class="fate-link" {href} onclick={follow}>Show the reply</a>
		{/if}
	</span>
{/if}

<style>
	.fate {
		display: inline-flex;
		align-items: baseline;
		gap: var(--df-p-space-1);
		flex-wrap: wrap;
		min-width: 0;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	.fate-word {
		font-weight: 500;
	}

	.fate-reason {
		color: inherit;
		overflow-wrap: anywhere;
	}

	.fate[data-state='queued'] {
		color: var(--df-text-meta);
	}

	.fate[data-state='failed'] {
		color: var(--df-state-danger-ink);
	}

	.fate[data-state='failed'] .fate-word {
		font-weight: 600;
	}

	.fate-glyph {
		display: inline-flex;
		align-self: center;
		color: var(--df-text-meta);
	}

	.fate[data-state='delivered'] .fate-glyph {
		color: var(--df-state-ok-ink);
	}

	.fate[data-state='failed'] .fate-glyph {
		color: var(--df-state-danger-ink);
	}

	/* A control, not a second alarm: the failure word keeps the ink. */
	.fate-link {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-secondary);
		text-decoration: underline;
		text-underline-offset: 2px;
		white-space: nowrap;
	}

	.fate-link:hover {
		color: var(--df-accent-text);
	}
</style>
