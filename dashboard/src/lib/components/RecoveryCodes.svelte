<script lang="ts">
	/**
	 * The one-time reveal of a recovery-code set.
	 *
	 * These strings exist in exactly one response from Better Auth and in this
	 * component's state; the server keeps only a hash-encrypted copy it cannot
	 * show again. So the panel has to be loud about two things: what they are for
	 * (the way back in when the passkey device is gone) and that they cannot be
	 * read later. Copy and download are both explicit — nothing leaves the page
	 * without a click.
	 */
	import CopyButton from './CopyButton.svelte';
	import Icon from './Icon.svelte';

	let {
		codes,
		account,
		heading = 'Save these recovery codes',
		ondone
	}: {
		codes: string[];
		account: string | null;
		heading?: string;
		ondone: () => void;
	} = $props();

	let acknowledged = $state(false);
	let downloaded = $state(false);

	const joined = $derived(codes.join('\n'));

	function download(): void {
		const lines = [
			'DakFlare recovery codes',
			...(account === null ? [] : [`Account: ${account}`]),
			`Created: ${new Date().toISOString().slice(0, 10)}`,
			'',
			'Each code works once, for one sign-in, in place of the authenticator code.',
			'They are the only way back into this account if the passkey device is lost.',
			'',
			...codes,
			''
		];
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const link = document.createElement('a');
		link.href = url;
		link.download = 'dakflare-recovery-codes.txt';
		document.body.appendChild(link);
		link.click();
		link.remove();
		// The blob holds the codes; drop it as soon as the download has started.
		setTimeout(() => URL.revokeObjectURL(url), 1_000);
		downloaded = true;
	}
</script>

<section class="reveal" aria-labelledby="recovery-codes-title">
	<div class="reveal-head">
		<h3 id="recovery-codes-title">{heading}</h3>
		<p class="reveal-lede">
			Ten single-use codes. Each one signs you in once when the authenticator is not available —
			they are the only way back into this account if the passkey device is lost. They are shown
			now and never again; the gateway keeps only a scrambled copy.
		</p>
	</div>

	<ol class="codes" aria-label="Recovery codes">
		{#each codes as code, index (code)}
			<li class="code">
				<span class="code-index mono" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
				<span class="code-value mono">{code}</span>
			</li>
		{/each}
	</ol>

	<div class="reveal-actions">
		<button type="button" class="btn btn-sm" onclick={download}>
			<Icon name={downloaded ? 'check' : 'arrow-down-left'} size={13} />
			{downloaded ? 'Downloaded' : 'Download as .txt'}
		</button>
		<CopyButton value={joined} label="Copy all codes" />
		<span class="reveal-count mono">{codes.length} codes</span>
	</div>

	<div class="reveal-foot">
		<label class="ack">
			<input type="checkbox" bind:checked={acknowledged} />
			<span>I have saved these somewhere I can reach without this browser.</span>
		</label>
		<button
			type="button"
			class="btn btn-primary btn-sm"
			disabled={!acknowledged}
			onclick={ondone}
		>
			Done — hide the codes
		</button>
	</div>
	<p class="hint">
		Lose them and you can still replace the set from this page; the old codes stop working the
		moment a new set is made.
	</p>
</section>

<style>
	.reveal {
		padding: var(--s-4);
		border: 1px solid color-mix(in srgb, var(--warn) 34%, var(--line));
		border-radius: var(--r);
		background: color-mix(in srgb, var(--warn) 6%, var(--surface));
	}

	.reveal-head h3 {
		margin-top: 4px;
		font-family: var(--df-font-display);
		font-size: var(--text-md);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	/* Focus is moved here after a code is accepted so a screen reader announces
	   the reveal; the heading is not a control and needs no ring. */
	.reveal-head h3:focus {
		outline: none;
	}

	.reveal-lede {
		margin-top: 6px;
		max-width: 62ch;
		color: var(--ink-2);
		font-size: var(--text-sm);
		line-height: 1.55;
	}

	.codes {
		display: grid;
		/* Ten codes: five columns by two rows fills the block with no gap left
		   over, and every value lands on the same baseline as its neighbour. */
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 1px;
		margin-top: var(--s-4);
		padding: 1px;
		list-style: none;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--line);
	}

	.code {
		display: flex;
		align-items: baseline;
		gap: 10px;
		padding: 8px 10px;
		background: var(--surface);
	}

	.code-index {
		font-size: 10px;
		color: var(--ink-3);
		letter-spacing: 0.06em;
	}

	.code-value {
		font-size: var(--text-sm);
		color: var(--ink);
		letter-spacing: 0.02em;
		user-select: all;
	}

	.reveal-actions {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: var(--s-3);
	}

	.reveal-count {
		margin-left: auto;
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.reveal-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
		margin-top: var(--s-4);
		padding-top: var(--s-3);
		border-top: 1px solid color-mix(in srgb, var(--warn) 24%, var(--line));
	}

	.ack {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 32px;
		color: var(--ink-2);
		font-size: var(--text-sm);
		cursor: pointer;
	}

	.ack input {
		width: 16px;
		height: 16px;
		margin: 0;
		accent-color: var(--accent);
		cursor: pointer;
	}

	.ack input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.hint {
		margin-top: var(--s-3);
	}

	@media (max-width: 720px) {
		.codes {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.reveal-foot {
			align-items: stretch;
			flex-direction: column;
		}

		.ack,
		.reveal-actions .btn,
		.reveal-foot .btn {
			min-height: 48px;
		}

		.ack input {
			width: 20px;
			height: 20px;
		}
	}
</style>
