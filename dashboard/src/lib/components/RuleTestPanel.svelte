<script lang="ts">
	import { describeError, testRules } from '$lib/api';
	import type { Device, Rule, RuleTestMatch } from '$lib/types';
	import { deviceLabel, deviceOptionLabel, devicePrimary } from '$lib/presence';
	import Icon from './Icon.svelte';
	import Notice from './Notice.svelte';
	import Spinner from './Spinner.svelte';

	let {
		rules,
		devices,
		scope = '',
		draftNotice = false,
		startOpen = false,
		onclose
	}: {
		rules: Rule[];
		devices: Device[];
		scope?: string;
		draftNotice?: boolean;
		startOpen?: boolean;
		onclose?: () => void;
	} = $props();

	const uid = $props.id();
	const titleId = `rule-test-title-${uid}`;

	let open = $state(false);
	let testDevice = $state('');
	let peer = $state('');
	let body = $state('');
	let running = $state(false);
	let error = $state<string | null>(null);
	let matches = $state<RuleTestMatch[] | null>(null);

	$effect(() => {
		if (startOpen) open = true;
	});

	const scoped = $derived(scope.trim() !== '');
	const scopedDevice = $derived(
		scope ? (devices.find((device) => device.device_id === scope) ?? null) : null
	);
	const rulesById = $derived(new Map(rules.map((rule) => [rule.id, rule])));
	const firstMatchedIndex = $derived(
		matches ? matches.findIndex((match) => match.matched) : -1
	);
	const firstMatched = $derived(
		matches && firstMatchedIndex >= 0 ? matches[firstMatchedIndex] : null
	);
	const firstMatchedRule = $derived(
		firstMatched ? (rulesById.get(firstMatched.rule_id) ?? null) : null
	);
	const renderedReply = $derived.by(() => {
		if (!firstMatched || !firstMatchedRule) return null;
		if (!firstMatchedRule.reply_template.trim()) return null;
		const matched = firstMatched.matched_text ?? matchedText(firstMatchedRule);
		return firstMatchedRule.reply_template
			.split('{sender}')
			.join(peer)
			.split('{body}')
			.join(body)
			.split('{matched}')
			.join(matched);
	});

	$effect(() => {
		if (scope) {
			if (testDevice !== scope) testDevice = scope;
			return;
		}
		const current = devices.some((device) => device.device_id === testDevice);
		if (!current) testDevice = devices[0]?.device_id ?? '';
	});

	// A changed scope invalidates the last result; never show reasons from a
	// different device or form scope.
	$effect(() => {
		void scope;
		void testDevice;
		matches = null;
		error = null;
	});

	function matchedText(rule: Rule): string {
		if (rule.body_type === 'keyword') {
			const index = body.toLowerCase().indexOf(rule.body_value.toLowerCase());
			return index === -1 ? '' : body.slice(index, index + rule.body_value.length);
		}
		if (rule.body_type === 'regex') {
			try {
				return new RegExp(rule.body_value, 'i').exec(body)?.[0] ?? '';
			} catch {
				return '';
			}
		}
		return '';
	}

	function reasonText(match: RuleTestMatch, index: number): string {
		if (match.matched) {
			return index === firstMatchedIndex
				? 'Would reply.'
				: 'Would match, but a higher-priority rule replies first.';
		}
		switch (match.reason) {
			case 'disabled':
				return 'This rule is paused.';
			case 'device_mismatch':
				return 'This rule is scoped to a different device.';
			case 'sender_mismatch':
				return 'The sender does not match this rule.';
			case 'body_mismatch':
				return 'The message body does not match this rule.';
			case 'shortcode_blocked':
				return 'The sender is a shortcode, and this rule does not reply to shortcodes.';
			case 'cooldown':
				return 'This rule is inside its cooldown window.';
			case 'hourly_cap':
				return 'This rule has reached its hourly reply cap.';
			default:
				return 'This rule would not reply to the sample.';
		}
	}

	function ruleName(match: RuleTestMatch): string {
		return rulesById.get(match.rule_id)?.name ?? match.name;
	}

	async function run(): Promise<void> {
		if (running) return;
		const sender = peer.trim();
		if (!sender) {
			error = 'Enter a sample sender.';
			matches = null;
			return;
		}
		running = true;
		error = null;
		matches = null;
		try {
			const target = scoped ? scope : testDevice;
			const result = await testRules({
				peer: sender,
				body,
				...(target ? { device_id: target } : {})
			});
			matches = result.matches;
		} catch (failure) {
			error = describeError(failure);
		} finally {
			running = false;
		}
	}

	function toggle(): void {
		if (open && onclose) {
			onclose();
			return;
		}
		open = !open;
	}
</script>

<section class="panel test-panel" aria-labelledby={titleId}>
	<div class="test-head">
		<div class="test-heading">
			<h3 class="test-title" id={titleId}>Test a message</h3>
			<p class="test-note">Nothing is sent.</p>
		</div>
		<button type="button" class="btn btn-sm" onclick={toggle} aria-expanded={open}>
			<Icon name={open ? 'x' : 'activity'} size={12} />
			{open ? (onclose ? 'Close' : 'Hide') : 'Open test'}
		</button>
	</div>

	{#if open}
		<div class="test-body">
			{#if draftNotice}
				<p class="draft-note">
					Tests the saved rules only — save this rule to include it. The unsaved values above are
					not used.
				</p>
			{/if}

			<form
				class="test-form"
				onsubmit={(event) => {
					event.preventDefault();
					void run();
				}}
			>
				<div class="field">
					<span class="label">Test on</span>
					{#if scoped}
						<div class="test-scope">
							{#if scopedDevice && deviceLabel(scopedDevice)}
								<span>{devicePrimary(scopedDevice)}</span>
								<span class="mono">{scope}</span>
							{:else}
								<span class="mono">{scope}</span>
							{/if}
						</div>
					{:else if devices.length > 0}
						<select class="input input-mono" bind:value={testDevice} aria-label="Device to test against">
							{#each devices as device (device.device_id)}
								<option value={device.device_id}>{deviceOptionLabel(device)}</option>
							{/each}
						</select>
					{:else}
						<p class="hint">No paired device. Only global rules can be tested.</p>
					{/if}
				</div>

				<div class="field">
					<label class="label" for={`test-peer-${uid}`}>Sample sender</label>
					<input
						id={`test-peer-${uid}`}
						class="input input-mono"
						bind:value={peer}
						placeholder="+15551234567"
						autocomplete="off"
						spellcheck="false"
					/>
				</div>

				<div class="field span-2">
					<label class="label" for={`test-body-${uid}`}>Sample message</label>
					<textarea
						id={`test-body-${uid}`}
						class="input"
						rows="2"
						bind:value={body}
						placeholder="STOP"
						spellcheck="false"
					></textarea>
				</div>

				<div class="test-actions span-2">
					<button type="submit" class="btn btn-primary btn-sm" disabled={running} aria-busy={running}>
						{#if running}<Spinner />{:else}<Icon name="activity" size={12} />{/if}
						Run the test
					</button>
					<span class="hint">
						Checks the matchers only; cooldowns and hourly limits are not applied.
					</span>
				</div>
			</form>

			{#if error}
				<Notice tone="danger" title="Could not run the test">{error}</Notice>
			{/if}

			{#if matches}
				<div class="results" aria-live="polite">
					{#if matches.length === 0}
						<p class="test-empty">No rules exist yet.</p>
					{:else}
						<ul class="test-matches">
							{#each matches as match, index (match.rule_id)}
								{@const wouldReply = index === firstMatchedIndex}
								<li class="test-match" class:would-reply={wouldReply}>
									<div class="test-match-head">
										<span class="test-name">{ruleName(match)}</span>
										{#if wouldReply}
											<span class="verdict">would reply</span>
										{/if}
									</div>
									<p class="test-reason">{reasonText(match, index)}</p>
								</li>
							{/each}
						</ul>

						{#if firstMatched && firstMatchedRule}
							{#if firstMatchedRule.reply_template.trim()}
								<div class="reply-preview">
									<p class="preview-label">Would send</p>
									<p class="reply-text">
										{renderedReply || 'The reply is empty after the values are filled in.'}
									</p>
								</div>
							{:else}
								<p class="hint">
									This rule matches and sends no reply. Flows still run for that message.
								</p>
							{/if}
						{:else}
							<p class="test-empty">No rule would reply to this sample.</p>
						{/if}
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</section>

<style>
	.test-panel {
		min-width: 0;
		border-radius: var(--df-p-radius-lg);
		/* The same panel sits in a 4-column rail and full width under the editor;
		   the fields follow its own width, not the viewport's. */
		container-type: inline-size;
	}

	.test-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: var(--df-p-radius-lg) var(--df-p-radius-lg) 0 0;
	}

	.test-heading {
		min-width: 0;
	}

	.test-title {
		font-size: var(--df-p-text-md);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.test-note {
		margin-top: 2px;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.test-body {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
	}

	.draft-note {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-state-warn-bg);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
	}

	.test-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--df-p-space-3);
	}

	@container (min-width: 520px) {
		.test-form {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	.test-form .span-2 {
		grid-column: 1 / -1;
	}

	.test-scope {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-height: 34px;
		justify-content: center;
		padding: 4px var(--df-p-space-2);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-base);
	}

	.test-scope .mono {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.test-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
	}

	.results {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
	}

	.test-matches {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		overflow: hidden;
		max-height: 320px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.test-match {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-card);
	}

	.test-match:last-child {
		border-bottom: 0;
	}

	.test-match.would-reply {
		background: var(--df-state-ok-bg);
		box-shadow: inset 3px 0 0 var(--df-state-ok-ink);
	}

	.test-match-head {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.test-name {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.verdict {
		padding: 1px 7px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-state-ok-bg);
		color: var(--df-state-ok-ink);
		font-size: var(--df-p-text-2xs);
		font-weight: 700;
		line-height: 1.6;
		white-space: nowrap;
	}

	.test-match.would-reply .verdict {
		background: var(--df-surface-card);
	}

	.test-reason {
		margin-top: 2px;
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-secondary);
	}

	.preview-label {
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.reply-preview {
		padding: var(--df-p-space-3);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.reply-text {
		margin-top: 4px;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-primary);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.test-empty {
		font-size: var(--df-p-text-base);
		color: var(--df-text-meta);
	}

	@media (prefers-reduced-motion: reduce) {
		.test-matches {
			scroll-behavior: auto;
		}
	}
</style>
