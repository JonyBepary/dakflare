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
			`prio ${Number.isFinite(form.priority) ? Math.trunc(form.priority) : 0}`,
			form.cooldown_s === 0 ? 'no cooldown' : `1 reply / ${Math.trunc(form.cooldown_s)} s`,
			`max ${Number.isFinite(form.max_per_hour) ? Math.trunc(form.max_per_hour) : 0} / h`
		]
			.filter(Boolean)
			.join(' · ')
	);

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

<svelte:head>
	<title>Rules · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Automation"
		title="Auto-reply rules"
		description="Rules are evaluated by the gateway as messages sync, so they need connectivity. Use one rule for a single rate-limited reply."
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
			{formOpen ? 'Close form' : 'New rule'}
		</button>
	</PageHeader>

	<AutomationHeader active="rules" />

	<div class="stack">
		{#if flash}
			<div aria-live="polite">
				<Notice tone="ok">{flash}</Notice>
			</div>
		{/if}

		{#if listTestOpen}
			<div id="rule-test-panel">
				<RuleTestPanel
					rules={rules}
					devices={devices}
					scope={listTestScope}
					startOpen
					onclose={() => (listTestOpen = false)}
				/>
			</div>
		{/if}

		{#if formOpen}
			<section class="panel form-panel" id="rule-form" aria-labelledby="rule-form-heading">
				<div class="panel-head">
					<h2 id="rule-form-heading" class="panel-title">
						<Icon name="filter" size={14} /> New rule
					</h2>
					<div class="head-actions">
						<span class="panel-meta">matcher → reply</span>
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
				<div class="panel-body">
					<form
						id="rule-form-body"
						class="rule-form"
						onsubmit={(event) => {
							event.preventDefault();
							void submitRule();
						}}
						novalidate
					>
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
										Global rules apply to the whole fleet; a scoped rule only sees that device.
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
									<code>{'{matched}'}</code> are filled in when the reply is sent; everything else is
									plain text.
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
								A matched rule suppresses every workflow for that message.
							</p>
						</section>

						<section class="rule-section" aria-labelledby="rule-limits-heading">
							<div class="rule-section-head rule-limits-head">
								<div>
									<h3 class="eyebrow" id="rule-limits-heading">Limits &amp; targeting</h3>
									<p class="hint">
										{limitsOpen
											? 'Enforced per rule and device.'
											: 'The saved values apply until you open this section.'}
									</p>
								</div>
								<button
									type="button"
									class="limit-toggle"
									onclick={() => (limitsOpen = !limitsOpen)}
									aria-expanded={limitsOpen}
									aria-controls="rule-limits"
								>
									<span class="mono">{limitSummary}</span>
									<span class="limit-toggle-action">{limitsOpen ? 'Hide' : 'Edit'}</span>
									<Icon name={limitsOpen ? 'chevron-up' : 'chevron-down'} size={13} />
								</button>
							</div>

							{#if limitsOpen}
								<div class="form-grid" id="rule-limits">
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
												Enforced per rule and device: the minimum gap between auto replies.
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
											<p class="hint" id="rule-max-hint">
												Enforced per rule and device, in a rolling hour.
											</p>
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

						<div class="form-foot rule-actions">
							<button type="submit" class="btn btn-primary" disabled={submitting} aria-busy={submitting}>
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
							<span class="hint">Upserts by id; a new id is generated on save.</span>
						</div>
					</form>

					<div class="form-test">
						<RuleTestPanel
							rules={rules}
							devices={devices}
							scope={form.device_id}
							draftNotice
						/>
					</div>
				</div>
			</section>
		{/if}

		{#if error}
			<section class="panel">
				<div class="panel-body stack">
					<Notice tone="danger" title="Could not load rules">{error}</Notice>
					<div class="row">
						<button type="button" class="btn btn-primary" onclick={() => void loadRules()}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</div>
			</section>
		{:else if loading}
			<section class="panel" aria-busy="true" aria-live="polite">
				<span class="sr-only">Loading rules</span>
				<div class="panel-head"><h2 class="panel-title">Rules</h2></div>
				<div class="loading-rows">
					{#each ['a', 'b', 'c'] as key (key)}
						<div class="skeleton" style="height: 54px"></div>
					{/each}
				</div>
			</section>
		{:else if rules.length === 0}
			<section class="panel">
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
		{:else}
			<section class="panel">
				<div class="panel-head">
					<h2 class="panel-title"><Icon name="filter" size={14} /> Rules</h2>
					<span class="panel-meta">
						{rules.length} rule{rules.length === 1 ? '' : 's'} ·{' '}
						{rules.filter((rule) => rule.enabled).length} enabled
					</span>
				</div>
				<div class="table-scroll desktop-only">
					<table class="table rules-table">
						<caption class="sr-only">Auto-reply rules including disabled and global rules</caption>
						<thead>
							<tr>
								<th scope="col">Rule</th>
								<th scope="col">Sender match</th>
								<th scope="col">Message match</th>
								<th scope="col">Reply</th>
								<th scope="col">Limits</th>
								<th scope="col">State</th>
								<th scope="col"><span class="sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each rules as rule (rule.id)}
								<tr class:disabled={!rule.enabled}>
									<td>
										<span class="cell-main">{rule.name}</span>
										<span class="cell-sub">
											{#if rule.device_id}
												{@const scoped = findDevice(rule.device_id)}
												<span class="scope-name">{scopeName(rule.device_id)}</span>
												{#if scoped && deviceLabel(scoped)}
													<span class="mono scope">{rule.device_id}</span>
												{/if}
											{:else}
												<Badge tone="accent">global</Badge>
											{/if}
										</span>
									</td>
									<td>
										<Badge tone="muted">{rule.matcher_type}</Badge>
										<span class="mono pattern" title={rule.matcher_value}>{rule.matcher_value}</span>
									</td>
									<td>
										<Badge tone="muted">{rule.body_type}</Badge>
										<span class="mono pattern" title={rule.body_value}>{rule.body_value}</span>
									</td>
									<td>
										{#if rule.reply_template}
											<span class="reply mono">{rule.reply_template}</span>
										{:else}
											<span class="muted">no reply</span>
										{/if}
									</td>
									<td>
										<span class="cell-sub mono limits">
											prio {rule.priority} · {rule.cooldown_s}s
											<br />
											max {rule.max_per_hour}/h · SIM {rule.sim_slot}
											{#if rule.allow_shortcode}
												<br />shortcode ok
											{/if}
										</span>
									</td>
									<td>
										{#if rule.enabled}
											<Badge tone="ok" dot>on</Badge>
										{:else}
											<Badge tone="muted">off</Badge>
										{/if}
									</td>
									<td>
										<div class="cell-actions">
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
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<ul class="rule-cards">
					{#each rules as rule (rule.id)}
						<li class="rule-card" class:disabled={!rule.enabled}>
							<div class="rule-head">
								<span class="rule-name">{rule.name}</span>
								{#if rule.enabled}
									<Badge tone="ok" dot>on</Badge>
								{:else}
									<Badge tone="muted">off</Badge>
								{/if}
							</div>
							<div class="rule-scope">
								{#if rule.device_id}
									{@const scoped = findDevice(rule.device_id)}
									<span class="scope-name">{scopeName(rule.device_id)}</span>
									{#if scoped && deviceLabel(scoped)}
										<span class="mono">{rule.device_id}</span>
									{/if}
								{:else}
									<Badge tone="accent">global</Badge>
								{/if}
							</div>
							<dl class="rule-kv">
								<div>
									<dt>Sender</dt>
									<dd>
										<Badge tone="muted">{rule.matcher_type}</Badge>
										<span class="mono">{rule.matcher_value}</span>
									</dd>
								</div>
								<div>
									<dt>Message</dt>
									<dd>
										<Badge tone="muted">{rule.body_type}</Badge>
										<span class="mono">{rule.body_value}</span>
									</dd>
								</div>
								<div>
									<dt>Reply</dt>
									<dd class="reply">
										{#if rule.reply_template}
											{rule.reply_template}
										{:else}
											<span class="muted">no reply</span>
										{/if}
									</dd>
								</div>
								<div>
									<dt>Limits</dt>
									<dd class="mono limits">
										prio {rule.priority} · {rule.cooldown_s}s · max {rule.max_per_hour}/h · SIM
										{rule.sim_slot}{#if rule.allow_shortcode} · shortcode ok{/if}
									</dd>
								</div>
							</dl>
							<div class="card-actions">
								<button
									type="button"
									class="btn btn-sm"
									onclick={() => void openListTest(rule)}
									aria-label={`Test rule ${rule.name}`}
								>
									<Icon name="activity" size={12} /> Test
								</button>
								<button
									type="button"
									class="btn btn-danger btn-sm"
									onclick={() => {
										deleteError = null;
										deleteTarget = rule;
									}}
									aria-label={`Delete rule ${rule.name}`}
								>
									<Icon name="trash" size={12} /> Delete rule
								</button>
							</div>
						</li>
					{/each}
				</ul>
				<p class="panel-note">
					Patterns are validated against the RE2 subset when you save. The gateway matches rules
					as messages sync; it does not send them to the phone.
				</p>
			</section>
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
			immediately.
		</p>
		<p class="hint" style="margin-top: 10px">
			Replies already queued on a device are not recalled.
		</p>
	{/if}
</ConfirmDialog>

<style>
	.form-panel {
		border-color: color-mix(in srgb, var(--accent) 28%, var(--line));
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
	}

	.form-test {
		margin-top: var(--s-4);
	}

	.rule-form {
		display: flex;
		flex-direction: column;
		gap: var(--s-4);
	}

	.rule-section {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		padding-top: var(--s-4);
		border-top: 1px solid var(--line);
	}

	.rule-section:first-child {
		padding-top: 0;
		border-top: 0;
	}

	.rule-section-head {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.rule-limits-head {
		flex-direction: row;
		align-items: flex-start;
		justify-content: space-between;
		flex-wrap: wrap;
	}

	.rule-limits-head > div {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.limit-toggle {
		display: inline-flex;
		align-items: center;
		justify-content: flex-start;
		gap: 8px;
		min-height: 32px;
		padding: 4px 9px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: var(--surface);
		color: var(--ink-2);
		font-size: var(--text-sm);
	}

	.limit-toggle:hover {
		background: var(--surface-2);
	}

	.limit-toggle .mono {
		font-size: 10.5px;
		color: var(--ink-2);
	}

	.limit-toggle-action {
		color: var(--accent);
		font-weight: 500;
	}

	.suppress-note {
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--ink-3);
	}

	.rule-actions {
		flex-wrap: wrap;
	}

	.field-foot {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-2);
	}

	.counter {
		font-size: 10px;
		color: var(--ink-3);
		flex: none;
	}

	.counter.over {
		color: var(--danger);
	}

	.toggles {
		display: flex;
		gap: var(--s-5);
		flex-wrap: wrap;
		padding: 2px 0;
	}

	.rules-table {
		min-width: 1000px;
		table-layout: fixed;
	}

	.rules-table .cell-actions {
		gap: 4px;
	}

	.rules-table th:nth-child(1) {
		width: 18%;
	}

	.rules-table th:nth-child(2) {
		width: 15%;
	}

	.rules-table th:nth-child(3) {
		width: 15%;
	}

	.rules-table th:nth-child(4) {
		width: 20%;
	}

	.rules-table th:nth-child(5) {
		width: 11%;
	}

	.rules-table th:nth-child(6) {
		width: 6%;
	}

	.rules-table th:nth-child(7) {
		width: 15%;
	}

	.input-num {
		max-width: 160px;
	}

	.rule-cards {
		display: none;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.rule-card {
		padding: var(--s-4);
		border-bottom: 1px solid var(--line);
	}

	.rule-card:last-child {
		border-bottom: 0;
	}

	.rule-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--s-3);
	}

	.rule-name {
		font-weight: 500;
		line-height: 1.35;
	}

	.rule-scope {
		margin-top: 4px;
		font-size: 10px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.rule-kv {
		display: grid;
		gap: var(--s-2);
		margin: var(--s-3) 0 0;
	}

	.rule-kv > div {
		display: grid;
		grid-template-columns: 62px minmax(0, 1fr);
		gap: var(--s-2);
		align-items: baseline;
	}

	.rule-kv dt {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.rule-kv dd {
		margin: 0;
		font-size: var(--text-base);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.rule-kv .limits {
		white-space: normal;
		font-size: 10.5px;
		color: var(--ink-2);
	}

	.rule-kv .reply {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink-2);
		white-space: pre-wrap;
	}

	.rule-card.disabled .rule-name {
		color: var(--ink-3);
	}

	.card-actions {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-3);
	}

	@media (max-width: 820px) {
		.desktop-only {
			display: none;
		}

		.rule-cards {
			display: block;
		}
	}

	.pattern {
		display: block;
		margin-top: 4px;
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.scope {
		display: block;
		font-size: 10px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.scope-name {
		display: block;
		font-size: 11px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.reply {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink-2);
		max-width: 34ch;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.limits {
		line-height: 1.55;
		font-size: 10px;
		color: var(--ink-3);
		white-space: nowrap;
	}

	tr.disabled .cell-main,
	tr.disabled .pattern {
		color: var(--ink-3);
	}

	.loading-rows {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-4);
	}

	@media (max-width: 620px) {
		.toggles {
			flex-direction: column;
			gap: var(--s-3);
		}

		.head-actions {
			width: 100%;
			flex: 1 1 100%;
		}

		.form-panel .panel-head {
			flex-wrap: wrap;
		}

		.form-panel .panel-title {
			flex: 1 0 auto;
			white-space: nowrap;
		}

		.head-actions .panel-meta {
			display: none;
		}

		.limit-toggle {
			min-height: 44px;
			width: 100%;
			justify-content: space-between;
		}
	}
</style>
