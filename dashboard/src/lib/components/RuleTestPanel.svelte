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
				return 'The sender is a shortcode, and shortcode replies are off for this rule.';
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
	<div class="panel-head">
		<h3 class="panel-title" id={titleId}><Icon name="shield" size={14} /> Test saved rules</h3>
		<span class="panel-meta">dry run · nothing is sent</span>
		<span class="spacer"></span>
		<button type="button" class="btn btn-sm" onclick={toggle} aria-expanded={open}>
			<Icon name={open ? 'x' : 'activity'} size={12} />
			{open ? (onclose ? 'Close' : 'Hide') : 'Open test'}
		</button>
	</div>

	{#if open}
		<div class="panel-body test-body">
			{#if draftNotice}
				<p class="draft-note">
					Testing saved rules — save to include this one. This test never uses the unsaved form
					values.
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
					<span class="label">Test for</span>
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
						Test saved rules
					</button>
					<span class="hint">
						Matchers only. Cooldowns and hourly caps are not applied to this test.
					</span>
				</div>
			</form>

			{#if error}
				<Notice tone="danger" title="Could not run the test">{error}</Notice>
			{/if}

			{#if matches}
				{#if matches.length === 0}
					<p class="test-empty">No saved rules exist yet.</p>
				{:else}
					<ul class="test-matches">
						{#each matches as match, index (match.rule_id)}
							{@const wouldReply = index === firstMatchedIndex}
							<li class="test-match" class:would-reply={wouldReply}>
								<div class="test-match-head">
									<span class="test-name">{ruleName(match)}</span>
									{#if wouldReply}
										<span class="test-verdict">would reply</span>
									{/if}
								</div>
								<p class="hint">{reasonText(match, index)}</p>
							</li>
						{/each}
					</ul>

					{#if firstMatched && firstMatchedRule}
						{#if firstMatchedRule.reply_template.trim()}
							<div class="reply-preview">
								<p class="eyebrow">Would send</p>
								<p class="reply-text">{renderedReply ?? '(empty after substitution)'}</p>
							</div>
						{:else}
							<p class="hint">This rule matches without sending a reply.</p>
						{/if}
					{:else}
						<p class="test-empty">No saved rule would reply to this sample.</p>
					{/if}
				{/if}
			{/if}
		</div>
	{/if}
</section>

<style>
	.test-panel {
		min-width: 0;
	}

	.test-panel .panel-head {
		flex-wrap: wrap;
	}

	.test-body {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
	}

	.draft-note {
		padding: 7px 9px;
		border: 1px solid color-mix(in srgb, var(--warn) 28%, var(--line));
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--warn) 6%, var(--surface));
		color: var(--ink-2);
		font-size: 11.5px;
		line-height: 1.45;
	}

	.test-form {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: var(--s-3);
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
		padding: 4px 9px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		font-size: var(--text-base);
	}

	.test-scope .mono {
		font-size: 10px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.test-actions {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		flex-wrap: wrap;
	}

	.test-matches {
		display: flex;
		flex-direction: column;
		gap: 0;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		overflow: hidden;
		max-height: 340px;
		overflow-y: auto;
	}

	.test-match {
		padding: 8px 10px;
		border-bottom: 1px solid var(--line);
		background: var(--surface);
	}

	.test-match:last-child {
		border-bottom: 0;
	}

	.test-match.would-reply {
		border-left: 2px solid var(--ok);
		background: color-mix(in srgb, var(--ok) 5%, var(--surface));
	}

	.test-match-head {
		display: flex;
		align-items: baseline;
		gap: var(--s-2);
		flex-wrap: wrap;
	}

	.test-name {
		font-size: var(--text-base);
		font-weight: 500;
	}

	.test-verdict {
		padding: 1px 5px;
		border: 1px solid color-mix(in srgb, var(--ok) 32%, var(--line));
		border-radius: 3px;
		background: color-mix(in srgb, var(--ok) 9%, var(--surface));
		color: var(--ok);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.reply-preview {
		padding: 10px;
		border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line));
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--accent) 4%, var(--surface));
	}

	.reply-text {
		margin-top: 4px;
		font-family: var(--font-mono);
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink-2);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.test-empty {
		font-size: var(--text-base);
		color: var(--ink-3);
	}

	@media (max-width: 620px) {
		.test-form {
			grid-template-columns: minmax(0, 1fr);
		}

		.test-form .span-2 {
			grid-column: auto;
		}
	}
</style>
