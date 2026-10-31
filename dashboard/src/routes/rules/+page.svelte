<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { createRule, deleteRule, describeError, getDevices, getRules } from '$lib/api';
	import type { BodyType, Device, MatcherType, Rule } from '$lib/types';
	import { utf8Bytes } from '$lib/format';
	import { deviceLabel, deviceOptionLabel, devicePrimary } from '$lib/presence';
	import AutomationHeader from '$lib/components/AutomationHeader.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RuleTestPanel from '$lib/components/RuleTestPanel.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	interface FormModel {
		name: string;
		device_id: string;
		enabled: boolean;
		priority: number;
		matcher_type: MatcherType;
		matcher_value: string;
		body_type: BodyType;
		body_value: string;
		reply_template: string;
		cooldown_s: number;
		max_per_hour: number;
		sim_slot: number;
		allow_shortcode: boolean;
	}

	/** The fields a rule sentence is built from — a saved rule or the open form. */
	interface SentenceSource {
		matcher_type: MatcherType | string;
		matcher_value: string;
		body_type: BodyType | string;
		body_value: string;
		reply_template: string;
	}

	const MATCHERS: { value: MatcherType; label: string; hint: string; placeholder: string }[] = [
		{
			value: 'exact',
			label: 'Exact',
			hint: 'The sender must equal the value exactly.',
			placeholder: '+15551234567'
		},
		{
			value: 'prefix',
			label: 'Prefix',
			hint: 'The sender must start with the value.',
			placeholder: '+1555'
		},
		{
			value: 'suffix',
			label: 'Suffix',
			hint: 'The sender must end with the value.',
			placeholder: '1234'
		},
		{
			value: 'glob',
			label: 'Glob',
			hint: 'Shell-style wildcards: * matches any run of characters.',
			placeholder: '+1555*'
		},
		{
			value: 'regex',
			label: 'Regex',
			hint: 'RE2 subset only — no lookarounds or backreferences.',
			placeholder: '^\\+1555[0-9]{7}$'
		}
	];

	const BODY_TYPES: { value: BodyType; label: string; hint: string; placeholder: string }[] = [
		{
			value: 'keyword',
			label: 'Keyword',
			hint: 'The message body must contain the keyword or phrase.',
			placeholder: 'STOP'
		},
		{
			value: 'regex',
			label: 'Regex',
			hint: 'RE2 subset only — the gateway rejects a pattern it cannot compile.',
			placeholder: '^(STOP|UNSUBSCRIBE)$'
		}
	];

	function defaultForm(): FormModel {
		return {
			name: '',
			device_id: '',
			enabled: true,
			priority: 0,
			matcher_type: 'exact',
			matcher_value: '',
			body_type: 'keyword',
			body_value: '',
			reply_template: '',
			cooldown_s: 60,
			max_per_hour: 10,
			sim_slot: 0,
			allow_shortcode: false
		};
	}

	let rules = $state<Rule[]>([]);
	let devices = $state<Device[]>([]);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let flash = $state<string | null>(null);

	let formOpen = $state(false);
	let form = $state<FormModel>(defaultForm());
	let fieldErrors = $state<Record<string, string>>({});
	let formError = $state<string | null>(null);
	let submitting = $state(false);
	let limitsOpen = $state(false);

	let listTestOpen = $state(false);
	let listTestScope = $state('');

	let deleteTarget = $state<Rule | null>(null);
	let deleting = $state(false);
	let deleteError = $state<string | null>(null);

	const matcherHint = $derived(MATCHERS.find((item) => item.value === form.matcher_type) ?? MATCHERS[0]);
	const bodyHint = $derived(BODY_TYPES.find((item) => item.value === form.body_type) ?? BODY_TYPES[0]);
	const replyBytes = $derived(utf8Bytes(form.reply_template));
	const matcherBytes = $derived(utf8Bytes(form.matcher_value));
	const bodyBytes = $derived(utf8Bytes(form.body_value));
	const limitSummary = $derived(
		[
			form.enabled ? null : 'Paused',
			`priority ${Number.isFinite(form.priority) ? Math.trunc(form.priority) : 0}`,
			form.cooldown_s === 0 ? 'no cooldown' : `1 reply / ${Math.trunc(form.cooldown_s)} s`,
			form.max_per_hour === 0
				? 'no replies'
				: `max ${Number.isFinite(form.max_per_hour) ? Math.trunc(form.max_per_hour) : 0} / hour`,
			form.sim_slot > 0 ? `SIM ${Math.trunc(form.sim_slot)}` : 'default SIM'
		]
			.filter(Boolean)
			.join(' · ')
	);

	const enabledCount = $derived(rules.filter((rule) => rule.enabled).length);

	/* ------------------------------------------------------------- sentence */

	/**
	 * A rule is one sentence: who it is from, what the message says, and what goes
	 * back. The same wording is used in the list and in the editor's preview, so
	 * the form and the stored rule never describe themselves differently.
	 */
	function senderLead(rule: SentenceSource): string {
		switch (rule.matcher_type) {
			case 'prefix':
				return 'numbers starting';
			case 'suffix':
				return 'numbers ending';
			case 'glob':
				return 'numbers matching';
			case 'regex':
				return 'numbers matching';
			default:
				return '';
		}
	}

	function senderToken(rule: SentenceSource): string {
		const value = rule.matcher_value.trim();
		if (!value) return '…';
		return rule.matcher_type === 'regex' ? `/${value}/` : value;
	}

	function bodyLead(rule: SentenceSource): string {
		return rule.body_type === 'regex' ? 'matching' : 'containing';
	}

	function bodyToken(rule: SentenceSource): string {
		const value = rule.body_value.trim();
		if (!value) return '…';
		return rule.body_type === 'regex' ? `/${value}/` : `“${value}”`;
	}

	function limitsLine(rule: Rule): string {
		return [
			`priority ${rule.priority}`,
			rule.cooldown_s === 0 ? 'no cooldown' : `1 reply / ${rule.cooldown_s} s`,
			rule.max_per_hour === 0 ? 'no replies' : `max ${rule.max_per_hour} / hour`,
			rule.sim_slot > 0 ? `SIM ${rule.sim_slot}` : 'default SIM',
			rule.allow_shortcode ? 'shortcodes allowed' : null
		]
			.filter(Boolean)
			.join(' · ');
	}

	function findDevice(id: string | null): Device | null {
		if (!id) return null;
		return devices.find((device) => device.device_id === id) ?? null;
	}

	function scopeName(id: string | null): string | null {
		if (!id) return null;
		const device = findDevice(id);
		return device ? devicePrimary(device) : id;
	}

	function scopeDetail(id: string | null): string {
		if (!id) return 'every device';
		const device = findDevice(id);
		if (!device) return id;
		const label = deviceLabel(device);
		return label ? `${label} (${id})` : id;
	}

	async function loadRules(initial = false) {
		if (!initial) refreshing = true;
		error = null;
		try {
			rules = await getRules();
		} catch (failure) {
			error = describeError(failure);
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	async function loadDevices() {
		try {
			devices = await getDevices();
		} catch {
			// The scope picker degrades to global-only; the rule list still works.
			devices = [];
		}
	}

	function openForm() {
		formOpen = true;
		listTestOpen = false;
		formError = null;
		fieldErrors = {};
		limitsOpen = false;
	}

	async function openListTest(rule: Rule) {
		formOpen = false;
		listTestScope = rule.device_id ?? '';
		listTestOpen = true;
		await tick();
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		document
			.getElementById('rule-test-panel')
			?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
	}

	function resetForm() {
		form = defaultForm();
		fieldErrors = {};
		formError = null;
		limitsOpen = false;
	}

	function validate(): boolean {
		const next: Record<string, string> = {};
		if (!form.name.trim()) next.name = 'Give the rule a name.';
		if (!form.matcher_value.trim()) next.matcher_value = 'A sender match value is required.';
		else if (matcherBytes > 512) next.matcher_value = 'Pattern must be at most 512 UTF-8 bytes.';
		if (!form.body_value.trim()) next.body_value = 'A message match value is required.';
		else if (bodyBytes > 512) next.body_value = 'Pattern must be at most 512 UTF-8 bytes.';
		if (replyBytes > 1000) next.reply_template = 'Reply must be at most 1000 UTF-8 bytes.';
		if (!Number.isFinite(form.priority)) next.priority = 'Enter a whole number.';
		if (!Number.isFinite(form.cooldown_s) || form.cooldown_s < 0) {
			next.cooldown_s = 'Cooldown cannot be negative.';
		}
		if (!Number.isFinite(form.max_per_hour) || form.max_per_hour < 0) {
			next.max_per_hour = 'Limit cannot be negative.';
		}
		if (!Number.isFinite(form.sim_slot) || form.sim_slot < 0) {
			next.sim_slot = 'SIM slot cannot be negative.';
		}
		fieldErrors = next;
		if (Object.keys(next).length > 0) {
			const ids: Record<string, string> = {
				name: 'rule-name',
				matcher_value: 'matcher-value',
				body_value: 'body-value',
				reply_template: 'reply-template',
				priority: 'rule-priority',
				cooldown_s: 'rule-cooldown',
				max_per_hour: 'rule-max',
				sim_slot: 'rule-sim'
			};
			if (['priority', 'cooldown_s', 'max_per_hour', 'sim_slot'].some((key) => key in next)) {
				limitsOpen = true;
			}
			const first = Object.keys(ids).find((key) => key in next);
			if (first) {
				const targetId = ids[first];
				void tick().then(() => document.getElementById(targetId)?.focus());
			}
		}
		return Object.keys(next).length === 0;
	}

	async function submitRule() {
		if (submitting) return;
		formError = null;
		flash = null;
		if (!validate()) {
			formError = 'Fix the highlighted fields before saving.';
			return;
		}

		submitting = true;
		try {
			const name = form.name.trim();
			await createRule({
				name,
				device_id: form.device_id || null,
				enabled: form.enabled,
				priority: Math.trunc(form.priority),
				matcher_type: form.matcher_type,
				matcher_value: form.matcher_value,
				body_type: form.body_type,
				body_value: form.body_value,
				reply_template: form.reply_template,
				cooldown_s: Math.trunc(form.cooldown_s),
				max_per_hour: Math.trunc(form.max_per_hour),
				sim_slot: Math.trunc(form.sim_slot),
				allow_shortcode: form.allow_shortcode
			});
			flash = `Rule “${name}” saved${form.device_id ? ` for ${scopeName(form.device_id)}` : ' as a global rule'}.`;
			formOpen = false;
			resetForm();
			await loadRules();
		} catch (failure) {
			formError = describeError(failure);
		} finally {
			submitting = false;
		}
	}

	async function confirmDelete() {
		if (!deleteTarget || deleting) return;
		deleting = true;
		deleteError = null;
		const target = deleteTarget;
		try {
			await deleteRule(target.id);
			rules = rules.filter((rule) => rule.id !== target.id);
			flash = `Deleted “${target.name}”.`;
			deleteTarget = null;
		} catch (failure) {
			deleteError = describeError(failure);
		} finally {
			deleting = false;
		}
	}

	onMount(() => {
		void loadRules(true);
		void loadDevices();
		if (page.url.searchParams.get('new') === '1') openForm();
	});
</script>

{#snippet ruleSentence(rule: SentenceSource)}
	<p class="sentence">
		<span class="lead">From</span>
		{#if senderLead(rule)}<span class="lead">{senderLead(rule)}</span>{/if}
		<span class="tok mono">{senderToken(rule)}</span>
		<span class="lead">{bodyLead(rule)}</span>
		<span class="tok mono">{bodyToken(rule)}</span>
		<span class="arrow" aria-hidden="true">→</span><span class="sr-only">then </span>
		{#if rule.reply_template.trim()}
			<span class="lead">reply</span>
			<span class="tok mono reply" class:is-long={rule.reply_template.trim().length > 80}
				>{rule.reply_template.trim()}</span
			>
		{:else}
			<span class="no-reply">no reply</span>
		{/if}
	</p>
{/snippet}

<svelte:head>
	<title>Rules · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Automation"
		title="Rules"
		description="One reply, rate-limited per rule and device. Evaluated on the gateway as messages sync."
	>
		<button
			type="button"
			class="btn"
			onclick={() => void loadRules()}
			disabled={loading || refreshing}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
		<button
			type="button"
			class="btn {formOpen ? '' : 'btn-primary'}"
			onclick={() => (formOpen ? (formOpen = false) : openForm())}
			aria-expanded={formOpen}
			aria-controls="rule-form"
		>
			<Icon name={formOpen ? 'x' : 'plus'} size={14} />
			{formOpen ? 'Close editor' : 'New rule'}
		</button>
	</PageHeader>

	<AutomationHeader active="rules" />

	<div class="grid-stack">
		{#if flash}
			<div class="flash" aria-live="polite">
				<Notice tone="ok">{flash}</Notice>
			</div>
		{/if}

		{#if formOpen}
			<div class="bento settle" style="--i: 0">
				<section class="card span-12 editor" id="rule-form" aria-labelledby="rule-form-heading">
					<div class="editor-head">
						<div>
							<h2 id="rule-form-heading" class="editor-title">New rule</h2>
							<p class="editor-note">One reply, rate-limited per rule and device.</p>
						</div>
						<div class="editor-actions">
							<button
								type="submit"
								form="rule-form-body"
								class="btn btn-primary btn-sm"
								disabled={submitting}
								aria-busy={submitting}
							>
								{#if submitting}<Spinner />{:else}<Icon name="check" size={12} />{/if}
								Save rule
							</button>
							<button
								type="button"
								class="btn btn-sm"
								onclick={() => (formOpen = false)}
								disabled={submitting}
							>
								Cancel
							</button>
						</div>
					</div>

					<div class="editor-body">
						<form
							id="rule-form-body"
							class="rule-form"
							onsubmit={(event) => {
								event.preventDefault();
								void submitRule();
							}}
							novalidate
						>
							<div class="preview">
								<p class="preview-label">This rule</p>
								{@render ruleSentence(form)}
								<p class="preview-limits mono">{limitSummary}</p>
							</div>

							<section class="rule-section" aria-labelledby="rule-match-heading">
								<div class="rule-section-head">
									<h3 class="eyebrow" id="rule-match-heading">Match</h3>
									<p class="hint">Who the message is from and what it says.</p>
								</div>

								<div class="form-grid">
									<div class="field span-2">
										<label class="label" for="rule-name">Name</label>
										<input
											id="rule-name"
											class="input"
											bind:value={form.name}
											placeholder="Stop requests"
											aria-invalid={fieldErrors.name ? 'true' : undefined}
											aria-describedby={fieldErrors.name ? 'rule-name-error' : undefined}
										/>
										{#if fieldErrors.name}
											<p class="field-error" id="rule-name-error">{fieldErrors.name}</p>
										{/if}
									</div>

									<div class="field">
										<label class="label" for="rule-scope">Scope</label>
										<select
											id="rule-scope"
											class="input input-mono"
											bind:value={form.device_id}
											aria-describedby="rule-scope-hint"
										>
											<option value="">Global — every device</option>
											{#each devices as device (device.device_id)}
												<option value={device.device_id}>{deviceOptionLabel(device)}</option>
											{/each}
										</select>
										<p class="hint" id="rule-scope-hint">
											A global rule sees the whole fleet; a scoped rule only sees that device.
										</p>
									</div>

									<div class="field">
										<label class="label" for="matcher-type">Sender match type</label>
										<select
											id="matcher-type"
											class="input"
											bind:value={form.matcher_type}
											aria-describedby="matcher-type-hint"
										>
											{#each MATCHERS as matcher (matcher.value)}
												<option value={matcher.value}>{matcher.label}</option>
											{/each}
										</select>
										<p class="hint" id="matcher-type-hint">{matcherHint.hint}</p>
									</div>

									<div class="field span-2">
										<label class="label" for="matcher-value">Sender value</label>
										<input
											id="matcher-value"
											class="input input-mono"
											bind:value={form.matcher_value}
											placeholder={matcherHint.placeholder}
											autocomplete="off"
											spellcheck="false"
											aria-invalid={fieldErrors.matcher_value ? 'true' : undefined}
											aria-describedby="matcher-value-hint matcher-counter"
										/>
										<div class="field-foot">
											{#if fieldErrors.matcher_value}
												<p class="field-error" id="matcher-value-hint">
													{fieldErrors.matcher_value}
												</p>
											{:else}
												<span class="hint" id="matcher-value-hint">
													Phone number, shortcode or pattern.
												</span>
											{/if}
											<span class="counter mono" class:over={matcherBytes > 512}>
												{matcherBytes}/512
											</span>
										</div>
										<span class="sr-only" id="matcher-counter">Sender pattern, maximum 512 bytes</span>
									</div>

									<div class="field">
										<label class="label" for="body-type">Message match type</label>
										<select
											id="body-type"
											class="input"
											bind:value={form.body_type}
											aria-describedby="body-type-hint"
										>
											{#each BODY_TYPES as item (item.value)}
												<option value={item.value}>{item.label}</option>
											{/each}
										</select>
										<p class="hint" id="body-type-hint">{bodyHint.hint}</p>
									</div>

									<div class="field span-2">
										<label class="label" for="body-value">Message value</label>
										<input
											id="body-value"
											class="input input-mono"
											bind:value={form.body_value}
											placeholder={bodyHint.placeholder}
											autocomplete="off"
											spellcheck="false"
											aria-invalid={fieldErrors.body_value ? 'true' : undefined}
											aria-describedby="body-value-hint"
										/>
										<div class="field-foot">
											{#if fieldErrors.body_value}
												<p class="field-error" id="body-value-hint">{fieldErrors.body_value}</p>
											{:else}
												<span class="hint" id="body-value-hint">
													Matched against the full inbound body.
												</span>
											{/if}
											<span class="counter mono" class:over={bodyBytes > 512}>{bodyBytes}/512</span>
										</div>
									</div>
								</div>
							</section>

							<section class="rule-section" aria-labelledby="rule-reply-heading">
								<div class="rule-section-head">
									<h3 class="eyebrow" id="rule-reply-heading">Reply</h3>
									<p class="hint" id="rule-reply-help">
										<code>{'{sender}'}</code>, <code>{'{body}'}</code> and
										<code>{'{matched}'}</code> are filled in when the reply is sent; everything else
										is plain text.
									</p>
								</div>

								<div class="form-grid">
									<div class="field span-3">
										<label class="label" for="reply-template">
											Reply template <span class="optional">optional</span>
										</label>
										<textarea
											id="reply-template"
											class="input"
											bind:value={form.reply_template}
											placeholder="Reply sent back to the sender…"
											rows="3"
											aria-invalid={fieldErrors.reply_template ? 'true' : undefined}
											aria-describedby="rule-reply-help reply-template-hint"
										></textarea>
										<div class="field-foot">
											{#if fieldErrors.reply_template}
												<p class="field-error" id="reply-template-hint">
													{fieldErrors.reply_template}
												</p>
											{:else}
												<span class="hint" id="reply-template-hint">
													Leave empty to match without sending a reply.
												</span>
											{/if}
											<span class="counter mono" class:over={replyBytes > 1000}>
												{replyBytes}/1000
											</span>
										</div>
									</div>
								</div>

								<p class="suppress-note">
									A rule that replies stops the flows for that message. A rule with no reply
									leaves them running.
								</p>
							</section>

							<section class="rule-section" aria-labelledby="rule-limits-heading">
								<div class="rule-section-head">
									<h3 class="eyebrow" id="rule-limits-heading">Limits &amp; targeting</h3>
									<p class="hint">Enforced per rule and device, in a rolling hour.</p>
								</div>

								<button
									type="button"
									class="limits-toggle"
									onclick={() => (limitsOpen = !limitsOpen)}
									aria-expanded={limitsOpen}
									aria-controls="rule-limits"
								>
									<span class="limits-value mono">{limitSummary}</span>
									<span class="limits-action">{limitsOpen ? 'Hide' : 'Edit'}</span>
									<Icon name={limitsOpen ? 'chevron-up' : 'chevron-down'} size={13} />
								</button>

								{#if limitsOpen}
									<div class="form-grid limits-grid" id="rule-limits">
										<div class="field">
											<label class="label" for="rule-priority">Priority</label>
											<input
												id="rule-priority"
												class="input input-mono input-num"
												type="number"
												bind:value={form.priority}
												step="1"
												aria-invalid={fieldErrors.priority ? 'true' : undefined}
												aria-describedby="rule-priority-hint"
											/>
											{#if fieldErrors.priority}
												<p class="field-error" id="rule-priority-hint">{fieldErrors.priority}</p>
											{:else}
												<p class="hint" id="rule-priority-hint">
													Higher wins when several rules match.
												</p>
											{/if}
										</div>

										<div class="field">
											<label class="label" for="rule-cooldown">Cooldown (seconds)</label>
											<input
												id="rule-cooldown"
												class="input input-mono input-num"
												type="number"
												bind:value={form.cooldown_s}
												min="0"
												step="1"
												aria-invalid={fieldErrors.cooldown_s ? 'true' : undefined}
												aria-describedby="rule-cooldown-hint"
											/>
											{#if fieldErrors.cooldown_s}
												<p class="field-error" id="rule-cooldown-hint">{fieldErrors.cooldown_s}</p>
											{:else}
												<p class="hint" id="rule-cooldown-hint">
													The minimum gap between auto replies.
												</p>
											{/if}
										</div>

										<div class="field">
											<label class="label" for="rule-max">Max replies / hour</label>
											<input
												id="rule-max"
												class="input input-mono input-num"
												type="number"
												bind:value={form.max_per_hour}
												min="0"
												step="1"
												aria-invalid={fieldErrors.max_per_hour ? 'true' : undefined}
												aria-describedby="rule-max-hint"
											/>
											{#if fieldErrors.max_per_hour}
												<p class="field-error" id="rule-max-hint">{fieldErrors.max_per_hour}</p>
											{:else}
												<p class="hint" id="rule-max-hint">0 blocks every reply.</p>
											{/if}
										</div>

										<div class="field">
											<label class="label" for="rule-sim">SIM slot</label>
											<input
												id="rule-sim"
												class="input input-mono input-num"
												type="number"
												bind:value={form.sim_slot}
												min="0"
												step="1"
												aria-invalid={fieldErrors.sim_slot ? 'true' : undefined}
												aria-describedby="rule-sim-hint"
											/>
											{#if fieldErrors.sim_slot}
												<p class="field-error" id="rule-sim-hint">{fieldErrors.sim_slot}</p>
											{:else}
												<p class="hint" id="rule-sim-hint">0 uses the device default.</p>
											{/if}
										</div>

										<div class="toggles span-2">
											<label class="check">
												<input
													id="rule-enabled"
													type="checkbox"
													bind:checked={form.enabled}
													aria-describedby="rule-enabled-hint"
												/>
												<span>
													Enabled
													<span
														class="hint"
														id="rule-enabled-hint"
														aria-hidden="true"
														style="display: block"
													>
														Disabled rules are stored but never matched.
													</span>
												</span>
											</label>
											<label class="check">
												<input
													id="rule-allow-shortcode"
													type="checkbox"
													bind:checked={form.allow_shortcode}
													aria-describedby="rule-allow-shortcode-hint"
												/>
												<span>
													Allow shortcode replies
													<span
														class="hint"
														id="rule-allow-shortcode-hint"
														aria-hidden="true"
														style="display: block"
													>
														Shortcode replies can be billable on the device.
													</span>
												</span>
											</label>
										</div>
									</div>
								{/if}
							</section>

							{#if formError}
								<div role="alert">
									<Notice tone="danger" title="Rule not saved">{formError}</Notice>
								</div>
							{/if}

							<div class="form-foot">
								<button
									type="submit"
									class="btn btn-primary"
									disabled={submitting}
									aria-busy={submitting}
								>
									{#if submitting}<Spinner />{:else}<Icon name="check" size={14} />{/if}
									Save rule
								</button>
								<button
									type="button"
									class="btn btn-ghost"
									onclick={() => (formOpen = false)}
									disabled={submitting}
								>
									Cancel
								</button>
								<span class="spacer"></span>
								<span class="hint">Saving with an existing name creates a second rule.</span>
							</div>
						</form>
					</div>
				</section>

			</div>

			<div class="bento settle" style="--i: 1">
				<div class="span-12 test-col">
					<RuleTestPanel rules={rules} devices={devices} scope={form.device_id} draftNotice />
				</div>
			</div>
		{/if}

		{#if error}
			<div class="bento settle" style="--i: 1">
				<section class="card span-12">
					<Notice tone="danger" title="Could not load rules">{error}</Notice>
					<div class="row" style="margin-top: 16px">
						<button type="button" class="btn btn-primary" onclick={() => void loadRules()}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</section>
			</div>
		{:else if loading}
			<div class="bento settle" style="--i: 1">
				<section class="card span-12" aria-busy="true" aria-live="polite">
					<span class="sr-only">Loading rules</span>
					<div class="skeleton" style="height: 16px; width: 90px"></div>
					<div class="loading-rows">
						{#each ['a', 'b', 'c'] as key (key)}
							<div class="skeleton" style="height: 64px"></div>
						{/each}
					</div>
				</section>
			</div>
		{:else if rules.length === 0}
			<div class="bento settle" style="--i: 1">
				<section class="card span-12">
					<EmptyState
						icon="filter"
						title="No rules yet"
						description="A rule pairs a sender matcher and a message matcher with an optional reply. Without one, a matching workflow is the only thing that can answer automatically."
					>
						<button type="button" class="btn btn-primary" onclick={openForm}>
							<Icon name="plus" size={14} /> Create the first rule
						</button>
					</EmptyState>
				</section>
			</div>
		{:else}
			<div class="bento settle" style="--i: 1">
				<section
					class="card list-card {listTestOpen ? 'span-8' : 'span-12'}"
					aria-labelledby="rules-heading"
				>
					<div class="panel-heading">
						<div>
							<h2 id="rules-heading" class="section-title">Rules</h2>
							<p class="section-note">
								{rules.length}
								{rules.length === 1 ? 'rule' : 'rules'} · {enabledCount} enabled · the first match
								inside its limits replies
							</p>
						</div>
					</div>

					<ul class="rule-list">
						{#each rules as rule (rule.id)}
							<li class="rule-row" class:is-off={!rule.enabled}>
								<div class="rule-main">
									<div class="rule-head">
										<span class="rule-name">{rule.name}</span>
										{#if rule.enabled}
											<Badge tone="ok" dot>on</Badge>
										{:else}
											<Badge tone="muted">paused</Badge>
										{/if}
									</div>
									{@render ruleSentence(rule)}
									<p class="rule-meta">
										<span class="mono meta-item">{limitsLine(rule)}</span>
										{#if rule.device_id}
											<span class="meta-item scope-name">{scopeName(rule.device_id)}</span>
										{:else}
											<span class="meta-item">every device</span>
										{/if}
									</p>
								</div>

								<div class="rule-actions">
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										onclick={() => void openListTest(rule)}
										aria-label={`Test rule ${rule.name}`}
									>
										<Icon name="activity" size={12} /> Test
									</button>
									<button
										type="button"
										class="btn btn-danger-ghost btn-sm"
										onclick={() => {
											deleteError = null;
											deleteTarget = rule;
										}}
										aria-label={`Delete rule ${rule.name}`}
									>
										<Icon name="trash" size={12} /> Delete
									</button>
								</div>
							</li>
						{/each}
					</ul>

					<p class="panel-note">
						Patterns are checked against the RE2 subset when you save. The gateway matches rules as
						messages sync; it does not send them to the phone.
					</p>
				</section>

				{#if listTestOpen}
					<div class="span-4 test-col" id="rule-test-panel">
						<RuleTestPanel
							rules={rules}
							devices={devices}
							scope={listTestScope}
							startOpen
							onclose={() => (listTestOpen = false)}
						/>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</div>

<ConfirmDialog
	open={deleteTarget !== null}
	title="Delete this rule?"
	confirmLabel="Delete rule"
	tone="danger"
	pending={deleting}
	error={deleteError}
	onconfirm={() => void confirmDelete()}
	oncancel={() => {
		if (!deleting) {
			deleteTarget = null;
			deleteError = null;
		}
	}}
>
	{#if deleteTarget}
		<p>
			<span class="mono">{deleteTarget.name}</span> will be removed from{' '}
			{deleteTarget.device_id ? `device ${scopeDetail(deleteTarget.device_id)}` : 'every device'}
			immediately. Anything that matches it stops getting an answer.
		</p>
		<p class="hint" style="margin-top: 10px">
			Replies already queued on a device are not recalled.
		</p>
	{/if}
</ConfirmDialog>

<style>
	.editor {
		scroll-margin-top: 80px;
		padding: 0;
		overflow: hidden;
	}

	.editor-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding: var(--df-p-space-4) var(--df-p-space-5);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.editor-title {
		font-size: var(--df-p-text-lg);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.editor-note {
		margin-top: 2px;
		font-size: var(--df-p-text-base);
		color: var(--df-text-meta);
	}

	.editor-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.editor-body {
		padding: var(--df-p-space-5);
	}

	.rule-form {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-5);
	}

	/* ---------- the sentence, in the list and in the editor ---------- */

	.preview {
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.preview-label {
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.preview-limits {
		margin-top: var(--df-p-space-2);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.sentence {
		display: block;
		margin-top: 2px;
		font-size: var(--df-p-text-md);
		line-height: 1.5;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.sentence .lead {
		color: var(--df-text-secondary);
	}

	.tok {
		font-size: 0.9em;
		font-weight: 500;
		color: var(--df-text-primary);
	}

	/* The reply is a sentence, not a code chip: mono weight carries it. */
	.tok.reply {
		font-weight: 400;
	}

	.reply.is-long {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		max-width: 68ch;
		vertical-align: top;
	}

	.arrow {
		padding: 0 2px;
		color: var(--df-text-meta);
	}

	.no-reply {
		color: var(--df-text-meta);
	}

	/* ---------- list ---------- */

	.list-card {
		padding: 0;
		overflow: hidden;
	}

	/* The saved-rule confirmation keeps its mint container here, so a change to the
	   shared callout tones cannot turn it into a grey box. */
	.flash :global(.callout) {
		background: var(--df-state-ok-bg);
	}

	.panel-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding: var(--df-p-space-4) var(--df-p-space-5) var(--df-p-space-3);
	}

	.section-title {
		font-size: var(--df-p-text-lg);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.section-note {
		margin-top: 2px;
		font-size: var(--df-p-text-base);
		color: var(--df-text-meta);
	}

	.rule-list {
		margin: 0;
		padding: 0 var(--df-p-space-5);
		list-style: none;
	}

	.rule-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: start;
		gap: var(--df-p-space-4);
		padding: var(--df-p-space-4) 0;
		border-top: 1px solid var(--df-border-hairline);
		transition: background-color 140ms ease;
	}

	.rule-row:first-child {
		border-top: 0;
	}

	.rule-main {
		min-width: 0;
	}

	.rule-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.rule-name {
		font-size: var(--df-p-text-md);
		font-weight: 600;
		line-height: 1.3;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.rule-meta {
		display: flex;
		align-items: baseline;
		column-gap: var(--df-p-space-2);
		row-gap: 2px;
		flex-wrap: wrap;
		margin-top: var(--df-p-space-2);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.rule-meta .mono {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	/* The separator rides with the item after it, so a wrap never leaves a
	   dangling dot at the end of a line. */
	.meta-item + .meta-item::before {
		content: '·';
		margin-right: var(--df-p-space-2);
		/* A separator is punctuation, not a hairline: in dark the control border
		   is 1.6:1 on the card and the dots vanish between the facts. */
	color: light-dark(
		var(--df-border-control),
		color-mix(in srgb, var(--df-text-meta) 65%, transparent)
	);
	}

	.scope-name {
		overflow-wrap: anywhere;
	}

	.rule-row.is-off .rule-name,
	.rule-row.is-off .sentence,
	.rule-row.is-off .sentence .lead,
	.rule-row.is-off .sentence .tok {
		color: var(--df-text-meta);
	}

	.rule-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	/* ---------- editor form ---------- */

	.rule-section {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		padding-top: var(--df-p-space-5);
		border-top: 1px solid var(--df-border-hairline);
	}

	.rule-section:first-of-type {
		padding-top: 0;
		border-top: 0;
	}

	.rule-section-head {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.field-foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--df-p-space-2);
	}

	.counter {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		flex: none;
	}

	.counter.over {
		color: var(--df-state-danger-ink);
	}

	.suppress-note {
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.limits-toggle {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		width: 100%;
		min-height: 40px;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
		text-align: left;
		transition: background-color 140ms ease;
	}

	.limits-toggle:hover {
		background: var(--df-surface-press);
	}

	.limits-toggle:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	.limits-value {
		flex: 1;
		min-width: 0;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	.limits-action {
		font-size: var(--df-p-text-sm);
		font-weight: 600;
		color: var(--df-accent-text);
	}

	.limits-toggle :global(svg) {
		color: var(--df-text-meta);
	}

	.toggles {
		display: flex;
		gap: var(--df-p-space-5);
		flex-wrap: wrap;
		padding: 2px 0;
	}

	.input-num {
		max-width: 180px;
	}

	.test-col {
		min-width: 0;
		scroll-margin-top: 80px;
	}

	.loading-rows {
		display: grid;
		gap: var(--df-p-space-2);
		margin-top: var(--df-p-space-4);
	}

	@media (max-width: 900px) {
		.rule-row {
			grid-template-columns: minmax(0, 1fr);
		}

		.rule-actions {
			justify-content: flex-start;
		}
	}

	@media (max-width: 720px) {
		.editor-body {
			padding: var(--df-p-space-4);
		}

		.panel-heading,
		.rule-list {
			padding-inline: var(--df-p-space-4);
		}

		/* Stacked, the limits and the scope are two facts on two lines; a leading
		   dot would read as a bullet. */
		.rule-meta {
			flex-direction: column;
			gap: 1px;
		}

		.meta-item + .meta-item::before {
			content: none;
		}

		.toggles {
			flex-direction: column;
			gap: var(--df-p-space-3);
		}

		.limits-toggle {
			min-height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.rule-row,
		.limits-toggle {
			transition: none;
		}
	}
</style>
