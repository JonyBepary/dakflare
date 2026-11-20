<script lang="ts">
	/**
	 * Templates and the audience they render against.
	 *
	 * The preview is local on purpose: a template is edited before it exists, so
	 * there is no id to ask `/preview` about. The grammar and the segment
	 * arithmetic are the Worker's (`worker/src/lib/templates.ts`), copied here as
	 * two small pure functions rather than imported across the deploy boundary.
	 * The plain-language rule is that this page counts what a carrier will bill,
	 * not what a text box calls a character.
	 */
	import { onMount } from 'svelte';
	import {
		createTemplate,
		deleteTemplate,
		describeError,
		getContacts,
		getTemplates,
		importContactsCsv
	} from '$lib/api';
	import { channelWord } from '$lib/channels';
	import { formatCount } from '$lib/format';
	import { session } from '$lib/session.svelte';
	import type { ContactPage, MessageTemplate } from '$lib/types';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/* ------------------------------------------------------------------ ids */

	const uid = $props.id();
	const nameId = `template-name-${uid}`;
	const channelId = `template-channel-${uid}`;
	const bodyId = `template-body-${uid}`;
	const varsId = `template-vars-${uid}`;
	const waNameId = `template-wa-name-${uid}`;
	const waLangId = `template-wa-language-${uid}`;
	const csvId = `template-csv-${uid}`;
	const fileId = `template-file-${uid}`;
	const audienceTitleId = `template-audience-${uid}`;

	/* --------------------------------------------------------------- grammar */

	const CHANNELS = [
		{ value: 'any', label: 'Any channel' },
		{ value: 'sms', label: 'SMS' },
		{ value: 'whatsapp', label: 'WhatsApp Cloud' },
		{ value: 'telegram', label: 'Telegram' },
		{ value: 'messenger', label: 'Messenger' },
		{ value: 'instagram', label: 'Instagram' }
	] as const;

	/** `{{name}}` or `{{name | fallback}}`, the Worker's whole template language. */
	const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.-]+)(?:\s*\|\s*([^}]+?))?\s*\}\}/g;

	interface Preview {
		rendered: string;
		missing: string[];
		used: string[];
		jsonError: string | null;
	}

	interface SmsMeasure {
		encoding: 'GSM-7' | 'UCS-2';
		units: number;
		segments: number;
		remaining: number;
	}

	/* The GSM 03.38 basic and extension tables, byte for byte the Worker's. */
	const GSM7_BASIC =
		'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
	const GSM7_EXTENSION = '^{}\\[~]|€';
	const GSM7_BASIC_SET = new Set(GSM7_BASIC);
	const GSM7_EXTENSION_SET = new Set(GSM7_EXTENSION);

	function measureSms(text: string): SmsMeasure {
		let gsmUnits = 0;
		let isGsm = true;
		for (const char of text) {
			if (GSM7_BASIC_SET.has(char)) gsmUnits += 1;
			else if (GSM7_EXTENSION_SET.has(char)) gsmUnits += 2;
			else {
				isGsm = false;
				break;
			}
		}

		if (isGsm) {
			const segments = gsmUnits === 0 ? 0 : gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
			const capacity = segments <= 1 ? 160 : 153;
			return {
				encoding: 'GSM-7',
				units: gsmUnits,
				segments,
				remaining: segments === 0 ? 160 : Math.max(0, segments * capacity - gsmUnits)
			};
		}

		let units = 0;
		for (const char of text) units += char.length;
		const segments = units === 0 ? 0 : units <= 70 ? 1 : Math.ceil(units / 67);
		const capacity = segments <= 1 ? 70 : 67;
		return {
			encoding: 'UCS-2',
			units,
			segments,
			remaining: segments === 0 ? 70 : Math.max(0, segments * capacity - units)
		};
	}

	/* ------------------------------------------------------------------ state */

	let templates = $state<MessageTemplate[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let flash = $state<string | null>(null);

	let formOpen = $state(false);
	let saving = $state(false);
	let formError = $state<string | null>(null);

	let name = $state('');
	let channel = $state<string>('sms');
	let body = $state(
		'Hi {{first_name | there}}, your order {{order_id}} is packed and leaves today. Reply STOP to opt out.'
	);
	let sampleVars = $state('{"first_name": "Amina", "order_id": "DK-4021"}');
	let waTemplateName = $state('');
	let waLanguage = $state('en_US');

	let audience = $state<ContactPage | null>(null);
	let audienceLoading = $state(false);
	let audienceError = $state<string | null>(null);

	const DEFAULT_CSV =
		'peer,channel,name,timezone\n+8801540196080,sms,Amina Rahman,Asia/Dhaka\n';
	let csvText = $state(DEFAULT_CSV);
	let csvFileName = $state<string | null>(null);
	let importing = $state(false);
	let importError = $state<string | null>(null);
	let importResult = $state<{ imported: number; skipped: number } | null>(null);

	let pendingDelete = $state<MessageTemplate | null>(null);
	let deleting = $state(false);
	let deleteError = $state<string | null>(null);

	const canWrite = $derived(session.canWrite);

	const channelLabel = $derived(channel === 'any' ? 'Any channel' : (channelWord(channel) ?? channel));

	const preview = $derived.by((): Preview => {
		let vars: Record<string, unknown> = {};
		let jsonError: string | null = null;
		const source = sampleVars.trim();
		if (source !== '') {
			try {
				const parsed: unknown = JSON.parse(source);
				if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
					jsonError =
						'Sample values must be a JSON object, for example {"first_name": "Amina"}.';
				} else {
					vars = parsed as Record<string, unknown>;
				}
			} catch {
				jsonError = 'The sample values are not valid JSON yet.';
			}
		}

		const missing: string[] = [];
		const used: string[] = [];
		const rendered = body.replace(
			TOKEN_RE,
			(_full: string, key: string, fallback?: string) => {
				used.push(key);
				const raw = vars[key];
				const value = raw === null || raw === undefined ? '' : String(raw).trim();
				if (value !== '') return value;
				if (fallback !== undefined) return fallback.trim();
				missing.push(key);
				return '';
			}
		);
		return { rendered, missing: jsonError ? [] : missing, used, jsonError };
	});

	const measure = $derived(measureSms(preview.rendered));
	const characterCount = $derived([...preview.rendered].length);
	const meterBars = $derived(Math.min(measure.segments, 8));

	const audienceScope = $derived(
		channel === 'any' ? 'audience rows across all channels' : `${channelLabel} rows`
	);

	const saveProblem = $derived.by(() => {
		if (name.trim() === '') return 'Give this template a name.';
		if (body.trim() === '') return 'Write the message body.';
		return null;
	});

	/* ------------------------------------------------------------------ reads */

	async function loadTemplates(): Promise<void> {
		loading = true;
		loadError = null;
		try {
			templates = await getTemplates();
		} catch (failure) {
			loadError = describeError(failure);
		} finally {
			loading = false;
		}
	}

	async function loadAudience(): Promise<void> {
		audienceLoading = true;
		audienceError = null;
		const asked = channel;
		try {
			const page = await getContacts({
				channel: asked === 'any' ? undefined : asked,
				limit: 1
			});
			if (asked !== channel) return;
			audience = page;
		} catch (failure) {
			if (asked !== channel) return;
			audience = null;
			audienceError = describeError(failure);
		} finally {
			if (asked === channel) audienceLoading = false;
		}
	}

	/* ----------------------------------------------------------------- writes */

	function openComposer(): void {
		formError = null;
		flash = null;
		formOpen = true;
	}

	function closeComposer(): void {
		if (saving) return;
		formOpen = false;
		formError = null;
	}

	async function saveTemplate(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!canWrite || saving || saveProblem !== null) return;
		saving = true;
		formError = null;
		flash = null;
		try {
			const result = await createTemplate({
				name: name.trim(),
				channel,
				body,
				...(channel === 'whatsapp'
					? {
							wa_template_name: waTemplateName.trim() || undefined,
							wa_language: waLanguage.trim() || undefined
						}
					: {})
			});
			templates = [result.template, ...templates.filter((row) => row.id !== result.template.id)];
			flash = `Saved "${result.template.name}" with ${formatCount(result.variables.length)} ${
				result.variables.length === 1 ? 'variable' : 'variables'
			}.`;
			formOpen = false;
		} catch (failure) {
			formError = describeError(failure);
		} finally {
			saving = false;
		}
	}

	function askDelete(row: MessageTemplate): void {
		pendingDelete = row;
		deleteError = null;
		flash = null;
	}

	function cancelDelete(): void {
		if (deleting) return;
		pendingDelete = null;
		deleteError = null;
	}

	async function confirmDelete(): Promise<void> {
		const row = pendingDelete;
		if (!row || deleting) return;
		deleting = true;
		deleteError = null;
		try {
			await deleteTemplate(row.id);
			templates = templates.filter((item) => item.id !== row.id);
			flash = `Deleted "${row.name}". Messages already sent keep their text.`;
			pendingDelete = null;
		} catch (failure) {
			deleteError = describeError(failure);
		} finally {
			deleting = false;
		}
	}

	async function chooseFile(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		// Clearing the value lets the same file be chosen twice in a row.
		input.value = '';
		if (!file) return;
		importError = null;
		importResult = null;
		if (!/\.csv$/i.test(file.name)) {
			importError = 'Choose a file ending in .csv.';
			return;
		}
		if (file.size > 512 * 1024) {
			importError = 'That file is larger than 512 KB. Split it and import the parts.';
			return;
		}
		try {
			csvText = (await file.text()).replace(/^\uFEFF/, '');
			csvFileName = file.name;
		} catch {
			importError = 'That file could not be read. Try choosing it again.';
		}
	}

	async function runImport(): Promise<void> {
		if (!canWrite || importing || csvText.trim() === '') return;
		importing = true;
		importError = null;
		importResult = null;
		try {
			importResult = await importContactsCsv(csvText);
			flash = null;
			void loadAudience();
		} catch (failure) {
			importError = describeError(failure);
		} finally {
			importing = false;
		}
	}

	onMount(() => {
		void loadTemplates();
		void loadAudience();
	});
</script>

<PageHeader
	eyebrow="Audience"
	title="Templates"
	description={'Reusable message bodies with {{name | fallback}} placeholders. See the text, the SMS bill and who opts out before a send.'}
>
	<button type="button" class="btn" onclick={() => void loadTemplates()} disabled={loading}>
		<Icon name="refresh" size={14} /> Refresh
	</button>
	{#if canWrite && !formOpen}
		<button type="button" class="btn btn-primary" onclick={openComposer}>
			<Icon name="plus" size={14} /> New template
		</button>
	{/if}
</PageHeader>

{#if !canWrite}
	<p class="read-only">
		<Icon name="shield" size={15} />
		Your account can read templates and the audience but cannot change them. Ask an owner or admin
		to save a template or import contacts.
	</p>
{/if}

{#if flash}
	<div class="flash">
		<Notice tone="ok" title="Done">{flash}</Notice>
	</div>
{/if}

{#if loadError && templates.length > 0}
	<div class="flash">
		<Notice tone="warn" title="The library may be out of date">
			{loadError} The templates below are the last answer from the gateway.
		</Notice>
	</div>
{/if}

{#if formOpen}
	<section class="composer panel" aria-labelledby="composer-title">
		<div class="panel-head">
			<h2 class="panel-title" id="composer-title">
				<Icon name="braces" size={15} /> New template
			</h2>
			<button
				type="button"
				class="btn btn-ghost btn-icon btn-sm"
				onclick={closeComposer}
				disabled={saving}
				aria-label="Close the template form"
			>
				<Icon name="x" size={14} />
			</button>
		</div>

		<div class="composer-grid">
			<form class="fields" onsubmit={(event) => void saveTemplate(event)}>
				<div class="field">
					<label class="label" for={nameId}>Name</label>
					<input
						id={nameId}
						class="input"
						bind:value={name}
						maxlength="64"
						placeholder="order_ready"
						autocomplete="off"
						disabled={saving}
					/>
					<p class="hint">The word operators will look for. Keep it stable.</p>
				</div>

				<div class="field">
					<label class="label" for={channelId}>Channel</label>
					<select
						id={channelId}
						class="input"
						bind:value={channel}
						onchange={() => void loadAudience()}
						disabled={saving}
					>
						{#each CHANNELS as option (option.value)}
							<option value={option.value}>{option.label}</option>
						{/each}
					</select>
					<p class="hint">Any channel is offered everywhere; a named one stays on that platform.</p>
				</div>

				<div class="field field-wide">
					<label class="label" for={bodyId}>Body</label>
					<textarea
						id={bodyId}
						class="input body-input"
						rows="6"
						bind:value={body}
						spellcheck="true"
						disabled={saving}
					></textarea>
					<p class="hint">
						<code>{'{{name}}'}</code> inserts a value. <code>{'{{name | fallback}}'}</code> inserts the
						fallback when the contact has no value.
					</p>
				</div>

				{#if channel === 'whatsapp'}
					<div class="field field-wide wa-row">
						<div class="field">
							<label class="label" for={waNameId}>
								Meta template name <span class="optional">required by Meta</span>
							</label>
							<input
								id={waNameId}
								class="input input-mono"
								bind:value={waTemplateName}
								placeholder="order_ready_v2"
								autocomplete="off"
								spellcheck="false"
								disabled={saving}
							/>
							<p class="hint">The approved template this body mirrors, as Meta spells it.</p>
						</div>
						<div class="field">
							<label class="label" for={waLangId}>Language</label>
							<input
								id={waLangId}
								class="input input-mono"
								bind:value={waLanguage}
								placeholder="en_US"
								autocomplete="off"
								spellcheck="false"
								disabled={saving}
							/>
							<p class="hint">The language code on the approved template.</p>
						</div>
					</div>
				{/if}

				<div class="field field-wide">
					<label class="label" for={varsId}>
						Sample values <span class="optional">JSON</span>
					</label>
					<textarea
						id={varsId}
						class="input input-mono sample-input"
						rows="3"
						bind:value={sampleVars}
						spellcheck="false"
						disabled={saving}
					></textarea>
					<p class="hint">For this preview only. Nothing here is stored with the template.</p>
				</div>

				<div class="form-foot">
					<button
						type="submit"
						class="btn btn-primary"
						disabled={saving || saveProblem !== null}
						aria-busy={saving}
					>
						{#if saving}<Spinner />{:else}<Icon name="check" size={14} />{/if}
						Save template
					</button>
					<button type="button" class="btn" onclick={closeComposer} disabled={saving}>
						Cancel
					</button>
					{#if !saving && saveProblem}
						<p class="hint form-problem">{saveProblem}</p>
					{/if}
				</div>

				{#if formError}
					<div class="field-wide">
						<Notice tone="danger" title="The template was not saved">{formError}</Notice>
					</div>
				{/if}
			</form>

			<aside class="preview-rail" aria-label="Preview and audience">
				<div class="preview">
					<div class="preview-head">
						<h3 class="rail-title">Preview</h3>
						<span class="preview-channel mono">{channelLabel}</span>
					</div>

					<div class="bubble-out">
						{#if preview.rendered.trim() === ''}
							<span class="bubble-empty">Your message appears here.</span>
						{:else}
							{preview.rendered}
						{/if}
					</div>

					<p class="bubble-meta">
						{formatCount(characterCount)} {characterCount === 1 ? 'character' : 'characters'} after
						the sample values are filled in
					</p>

					{#if preview.jsonError}
						<p class="json-warning" role="alert">
							<Icon name="alert" size={13} /> {preview.jsonError}
						</p>
					{/if}

					<div class="measure">
						<p class="measure-number">
							<span class="measure-value">{measure.segments}</span>
							<span class="measure-word">
								{measure.segments === 1 ? 'SMS segment' : 'SMS segments'}
							</span>
						</p>
						<div
							class="meter"
							role="img"
							aria-label={`${measure.segments} SMS ${measure.segments === 1 ? 'segment' : 'segments'}`}
						>
							{#each Array(meterBars) as _, index (index)}
								<span class="meter-bar"></span>
							{/each}
							{#if measure.segments === 0}
								<span class="meter-bar meter-empty"></span>
							{/if}
						</div>
						<dl class="measure-facts">
							<div>
								<dt>Encoding</dt>
								<dd>{measure.encoding}</dd>
							</div>
							<div>
								<dt>Units</dt>
								<dd>{formatCount(measure.units)}</dd>
							</div>
							<div>
								<dt>Spare</dt>
								<dd>{formatCount(measure.remaining)}</dd>
							</div>
						</dl>
					</div>

					<p class="hint measure-hint">
						{#if measure.segments === 0}
							Nothing to count yet. An SMS part holds 160 GSM-7 units, or 70 UCS-2 units.
						{:else if measure.encoding === 'GSM-7'}
							GSM-7: 160 units fit one part and 153 fit each part after that. Characters in the
							extension table (for example {'^'} or {'€'}) cost two.
						{:else}
							UCS-2: one character outside GSM-7 moves the whole message here. 70 units fit one part
							and 67 fit each part after that; an emoji costs two.
						{/if}
					</p>

					{#if preview.missing.length > 0}
						<div class="missing">
							<p class="missing-label">
								<Icon name="alert" size={13} />
								No value and no fallback for
							</p>
							<ul class="missing-list">
								{#each preview.missing as key (key)}
									<li class="missing-chip mono">{key}</li>
								{/each}
							</ul>
							<p class="hint">These render as nothing. Add a fallback or a sample value.</p>
						</div>
					{:else if !preview.jsonError && preview.used.length > 0}
						<p class="hint variables-line">
							{formatCount(new Set(preview.used).size)} variables resolve from the sample values.
						</p>
					{/if}
				</div>

				<section class="audience" aria-labelledby={audienceTitleId}>
					<div class="audience-head">
						<h3 class="rail-title" id={audienceTitleId}>Audience</h3>
						<button
							type="button"
							class="btn btn-ghost btn-sm"
							onclick={() => void loadAudience()}
							disabled={audienceLoading}
							aria-label="Recheck the audience count"
						>
							{#if audienceLoading}<Spinner />{:else}<Icon name="refresh" size={12} />{/if}
							Recheck
						</button>
					</div>

					{#if audienceError}
						<p class="audience-error" role="alert">
							<Icon name="alert" size={13} />
							The audience count did not load. {audienceError}
						</p>
					{:else if audience}
						<p class="audience-line">
							<strong class="audience-figure">{formatCount(audience.opted_out)}</strong>
							of
							<strong class="audience-figure">{formatCount(audience.total)}</strong>
							{audienceScope} are opted out and will be skipped.
						</p>
						<p class="hint">
							{#if audience.total === 0}
								No rows are on file for this channel yet. Import a list below to give a send someone
								to reach.
							{:else if audience.opted_out === audience.total}
								Every row on file for this channel is opted out, so a send here would reach nobody.
								The queue checks opt-out again when it runs.
							{:else}
								This is a pre-flight count. The queue checks opt-out again when the send runs.
							{/if}
						</p>
					{:else}
						<div class="skeleton audience-skeleton" aria-hidden="true"></div>
					{/if}
				</section>
			</aside>
		</div>
	</section>
{/if}

<section class="panel library" aria-labelledby="library-title">
	<div class="panel-head">
		<h2 class="panel-title" id="library-title"><Icon name="braces" size={15} /> Library</h2>
		<p class="panel-meta">
			{#if loading}
				Reading
			{:else}
				{formatCount(templates.length)}
				{templates.length === 1 ? 'template' : 'templates'}
			{/if}
		</p>
	</div>

	{#if loading && templates.length === 0}
		<div class="panel-body loading-stack" aria-busy="true" aria-live="polite">
			<span class="sr-only">Loading templates</span>
			<div class="skeleton"></div>
			<div class="skeleton"></div>
			<div class="skeleton"></div>
		</div>
	{:else if loadError && templates.length === 0}
		<div class="panel-body">
			<Notice tone="danger" title="The template library did not load">{loadError}</Notice>
			<button type="button" class="btn retry" onclick={() => void loadTemplates()}>
				<Icon name="refresh" size={13} /> Try again
			</button>
		</div>
	{:else if templates.length === 0}
		<div class="panel-body">
			<EmptyState
				icon="braces"
				title="A template is a message you write once"
				description="It holds the words and the placeholders, and every contact gets their own values filled in. Nothing is sent from this page; a flow or an operator uses the template later."
			>
				{#if canWrite}
					<button type="button" class="btn btn-primary" onclick={openComposer}>
						<Icon name="plus" size={14} /> Write the first template
					</button>
				{/if}
			</EmptyState>
		</div>
	{:else}
		<table class="table template-table">
			<thead>
				<tr>
					<th scope="col">Template</th>
					<th scope="col">Channel</th>
					<th scope="col">Variables</th>
					<th scope="col">Updated</th>
					<th scope="col"><span class="sr-only">Actions</span></th>
				</tr>
			</thead>
			<tbody>
				{#each templates as row, index (row.id)}
					<tr class="settle" style={`--i: ${Math.min(index, 5)}`}>
						<td data-label="Template">
							<span class="cell-main">{row.name}</span>
							<span class="cell-sub body-line" title={row.body}>{row.body}</span>
						</td>
						<td data-label="Channel">
							<span class="channel-tag">
								{row.channel === 'any' ? 'Any channel' : (channelWord(row.channel) ?? row.channel)}
							</span>
							{#if row.channel === 'whatsapp' && row.wa_template_name}
								<span class="cell-sub mono wa-name" title={row.wa_template_name}>
									{row.wa_template_name}
								</span>
							{/if}
						</td>
						<td data-label="Variables">
							<span class="cell-main">{row.variables.length}</span>
							<span class="cell-sub var-names" title={row.variables.join(', ')}>
								{row.variables.length === 0
									? 'none'
									: row.variables.slice(0, 3).join(' · ') +
										(row.variables.length > 3 ? ` +${row.variables.length - 3}` : '')}
							</span>
						</td>
						<td data-label="Updated">
							<RelativeTime value={row.updated_at} fallback="just now" />
						</td>
						<td class="row-actions">
							<CopyButton value={row.body} label="Copy the body" iconOnly size="sm" />
							{#if canWrite}
								<button
									type="button"
									class="btn btn-sm btn-danger-ghost"
									onclick={() => askDelete(row)}
									aria-label={`Delete ${row.name}`}
									title={`Delete ${row.name}`}
								>
									<Icon name="trash" size={13} />
								</button>
							{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</section>

{#if canWrite}
	<section class="panel import-panel" aria-labelledby="import-title">
		<div class="panel-head">
			<h2 class="panel-title" id="import-title">
				<Icon name="paperclip" size={15} /> Import contacts
			</h2>
			<p class="panel-meta">CSV</p>
		</div>

		<div class="import-grid">
			<div class="field">
				<label class="label" for={csvId}>Contacts as CSV</label>
				<textarea
					id={csvId}
					class="input input-mono csv-input"
					rows="7"
					bind:value={csvText}
					spellcheck="false"
					disabled={importing}
				></textarea>
				<p class="hint">
					The first row is the header. <code>peer</code> and <code>channel</code> identify a row;
					<code>name</code> and <code>timezone</code> are optional.
				</p>
			</div>

			<div class="import-side">
				<label class="file-btn">
					<input
						id={fileId}
						class="file-input"
						type="file"
						accept=".csv,text/csv"
						onchange={chooseFile}
						disabled={importing}
					/>
					<Icon name="paperclip" size={14} />
					Choose a .csv file
				</label>
				{#if csvFileName}
					<p class="file-name mono">{csvFileName}</p>
				{/if}

				<button
					type="button"
					class="btn btn-primary import-run"
					onclick={() => void runImport()}
					disabled={importing || csvText.trim() === ''}
					aria-busy={importing}
				>
					{#if importing}<Spinner />{:else}<Icon name="plus" size={14} />{/if}
					Import contacts
				</button>

				{#if importResult}
					<div class="import-result" role="status">
						<div class="import-stat">
							<span class="import-figure">{formatCount(importResult.imported)}</span>
							<span class="import-word">imported</span>
						</div>
						<div class="import-stat">
							<span class="import-figure muted-figure">{formatCount(importResult.skipped)}</span>
							<span class="import-word">skipped</span>
						</div>
					</div>
				{:else}
					<p class="hint">
						The gateway answers with how many rows it imported and how many it skipped. The audience
						count above refreshes when the import finishes.
					</p>
				{/if}

				{#if importError}
					<Notice tone="danger" title="The import did not finish">{importError}</Notice>
				{/if}
			</div>
		</div>
	</section>
{/if}

<ConfirmDialog
	open={pendingDelete !== null}
	title={pendingDelete ? `Delete ${pendingDelete.name}?` : 'Delete template'}
	confirmLabel="Delete template"
	pending={deleting}
	error={deleteError}
	onconfirm={() => void confirmDelete()}
	oncancel={cancelDelete}
>
	<p class="confirm-copy">
		The template leaves the library and nothing can use it again. Messages already sent keep the
		text they went out with.
	</p>
</ConfirmDialog>

<style>
	.read-only {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		margin-bottom: var(--df-p-space-4);
		padding: 10px var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-base);
		line-height: 1.5;
	}

	.read-only :global(svg) {
		margin-top: 2px;
		color: var(--df-text-meta);
	}

	.flash {
		margin-bottom: var(--df-p-space-4);
	}

	/* ---------- composer ---------- */

	.composer {
		margin-bottom: var(--df-p-space-5);
		border-color: color-mix(in srgb, var(--df-accent-text) 24%, var(--df-border-hairline));
	}

	.composer-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
		gap: var(--df-p-space-5);
		padding: var(--df-p-space-4);
	}

	.fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--df-p-space-4);
		align-content: start;
		min-width: 0;
	}

	.field-wide {
		grid-column: 1 / -1;
	}

	.wa-row {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
	}

	.body-input {
		font-family: var(--df-p-font-sans);
		font-size: var(--df-p-text-md);
		line-height: 1.55;
	}

	.sample-input {
		resize: vertical;
	}

	.form-problem {
		margin: 0;
	}

	/* ---------- preview ---------- */

	.preview-rail {
		display: grid;
		gap: var(--df-p-space-3);
		align-content: start;
		min-width: 0;
	}

	.preview,
	.audience {
		padding: var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
		min-width: 0;
	}

	.preview-head,
	.audience-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		margin-bottom: var(--df-p-space-3);
	}

	.rail-title {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.preview-channel {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.bubble-out {
		padding: var(--df-c-bubble-padding);
		border-radius: var(--df-c-bubble-radius) var(--df-c-bubble-radius)
			var(--df-c-bubble-radius-tail) var(--df-c-bubble-radius);
		background: var(--df-c-bubble-out-bg);
		color: var(--df-c-bubble-out-ink);
		font-size: var(--df-c-bubble-body-size);
		line-height: var(--df-c-bubble-body-leading);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.bubble-empty {
		color: var(--df-text-meta);
		font-style: italic;
	}

	.bubble-meta {
		margin-top: var(--df-p-space-2);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.json-warning,
	.audience-error {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin-top: var(--df-p-space-2);
		color: var(--df-state-danger-ink);
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
	}

	.json-warning :global(svg),
	.audience-error :global(svg) {
		margin-top: 2px;
	}

	/* The segment count is the number an operator is actually deciding about,
	   so it is the one display-size figure in the card. */
	.measure {
		margin-top: var(--df-p-space-4);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.measure-number {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
	}

	.measure-value {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-3xl);
		font-weight: 800;
		line-height: 1;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
		color: var(--df-text-primary);
	}

	.measure-word {
		font-size: var(--df-p-text-sm);
		font-weight: 600;
		color: var(--df-text-secondary);
	}

	.meter {
		display: flex;
		gap: var(--df-p-space-1);
		margin-top: var(--df-p-space-2);
	}

	.meter-bar {
		flex: 1;
		height: var(--df-p-space-1);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-accent-decor);
	}

	.meter-empty {
		background: var(--df-border-hairline);
	}

	.measure-facts {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--df-p-space-2);
		margin-top: var(--df-p-space-3);
	}

	.measure-facts dt {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.measure-facts dd {
		margin: 2px 0 0;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-sm);
		color: var(--df-text-primary);
		font-variant-numeric: tabular-nums;
	}

	.measure-hint {
		margin-top: var(--df-p-space-2);
	}

	.missing {
		margin-top: var(--df-p-space-3);
		padding-top: var(--df-p-space-3);
		border-top: 1px dashed var(--df-border-hairline);
	}

	.missing-label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--df-p-text-sm);
		font-weight: 600;
		color: var(--df-state-warn-ink);
	}

	.missing-label :global(svg) {
		color: currentColor;
	}

	.missing-list {
		display: flex;
		flex-wrap: wrap;
		gap: var(--df-p-space-1);
		margin-top: var(--df-p-space-2);
		list-style: none;
		padding: 0;
	}

	.missing-chip {
		padding: 2px 6px;
		border: 1px solid var(--df-state-warn-ink);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-state-warn-bg);
		color: var(--df-state-warn-ink);
		font-size: var(--df-p-text-2xs);
		overflow-wrap: anywhere;
	}

	.variables-line {
		margin-top: var(--df-p-space-3);
	}

	/* ---------- audience ---------- */

	.audience-line {
		font-size: var(--df-p-text-base);
		line-height: 1.55;
		color: var(--df-text-secondary);
	}

	.audience-figure {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-lg);
		font-weight: 800;
		color: var(--df-text-primary);
		font-variant-numeric: tabular-nums;
	}

	.audience-skeleton {
		height: var(--df-p-space-7);
	}

	/* ---------- library ---------- */

	.panel-meta {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.loading-stack {
		display: grid;
		gap: var(--df-p-space-3);
	}

	.loading-stack .skeleton {
		height: var(--df-p-space-7);
	}

	.retry {
		margin-top: var(--df-p-space-3);
	}

	/* A fixed layout above the tablet breakpoint keeps the channel and variable
	   columns from drifting apart; below it the table is a card list. */
	@media (min-width: 1101px) {
		.template-table {
			table-layout: fixed;
		}

		.template-table th:nth-child(2) {
			width: 9.5rem;
		}

		.template-table th:nth-child(3) {
			width: 12rem;
		}

		.template-table th:nth-child(4) {
			width: 7.5rem;
		}

		.template-table th:nth-child(5) {
			width: 6.5rem;
		}
	}

	/* A WhatsApp template name can be longer than the channel column. The table
	   is a summary, so it truncates with the full name in the title. */
	.wa-name {
		display: block;
		max-width: 100%;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.body-line {
		display: -webkit-box;
		-webkit-line-clamp: 1;
		line-clamp: 1;
		-webkit-box-orient: vertical;
		overflow: hidden;
		max-width: 52ch;
	}

	.channel-tag {
		display: inline-flex;
		align-items: center;
		height: var(--df-c-chip-height);
		padding: 0 var(--df-c-chip-padding-inline);
		border-radius: var(--df-c-chip-radius);
		background: var(--df-state-filter-bg);
		color: var(--df-state-filter-ink);
		font-size: var(--df-c-chip-font-size);
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.var-names {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		overflow-wrap: anywhere;
	}

	.row-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 2px;
	}

	.row-actions :global(.btn) {
		width: var(--df-p-space-6);
		padding: 0;
		justify-content: center;
	}

	/* ---------- import ---------- */

	.import-panel {
		margin-top: var(--df-p-space-5);
	}

	.import-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.35fr) minmax(0, 0.65fr);
		gap: var(--df-p-space-4);
		padding: var(--df-p-space-4);
	}

	.csv-input {
		min-height: calc(var(--df-p-space-8) * 2);
		resize: vertical;
	}

	.import-side {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		min-width: 0;
	}

	/* The label is the whole control: the file input fills it invisibly, so a
	   click anywhere on the box opens the picker and the focus ring is drawn on
	   the label rather than on a 1px input. */
	.file-btn {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-2);
		min-height: var(--df-c-composer-min-height);
		padding: 0 var(--df-p-space-3);
		border: 1px dashed var(--df-border-control);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-field);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-base);
		font-weight: 600;
		cursor: pointer;
		max-width: 100%;
	}

	.file-btn:focus-within {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	.file-input {
		position: absolute;
		/* The label's 1px border sits outside its content box, so the input has to
		   cover one pixel past it: otherwise the click target is 42px inside a
		   44px label. */
		inset: -1px;
		width: calc(100% + 2px);
		height: calc(100% + 2px);
		opacity: 0;
		cursor: pointer;
	}

	.file-input:disabled {
		cursor: not-allowed;
	}

	.file-name {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.import-run {
		width: 100%;
	}

	.import-result {
		display: flex;
		gap: var(--df-p-space-4);
		width: 100%;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-c-tint-edge-ok);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-state-ok-bg);
	}

	.import-stat {
		display: flex;
		align-items: baseline;
		gap: 6px;
	}

	.import-figure {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-2xl);
		font-weight: 800;
		line-height: 1;
		color: var(--df-state-ok-ink);
		font-variant-numeric: tabular-nums;
	}

	.muted-figure {
		color: var(--df-text-secondary);
	}

	.import-word {
		font-size: var(--df-p-text-sm);
		color: var(--df-text-secondary);
	}

	.confirm-copy {
		font-size: var(--df-p-text-base);
		line-height: 1.55;
		color: var(--df-text-secondary);
	}

	/* ---------- narrow ---------- */

	@media (max-width: 1100px) {
		.composer-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.preview-rail {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			align-items: start;
		}

		.import-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.import-side {
			flex-direction: row;
			flex-wrap: wrap;
			align-items: center;
		}

		.import-run {
			width: auto;
		}

		.import-result {
			width: auto;
		}
	}

	@media (max-width: 760px) {
		.fields {
			grid-template-columns: minmax(0, 1fr);
		}

		.wa-row,
		.preview-rail {
			grid-template-columns: minmax(0, 1fr);
		}

		.body-line {
			-webkit-line-clamp: 2;
			line-clamp: 2;
			max-width: none;
		}

		/* The table becomes a stack of labelled rows. Each cell keeps its own
		   label, so nothing has to be inferred from position. */
		.template-table thead {
			display: none;
		}

		.template-table,
		.template-table tbody {
			display: block;
			width: 100%;
		}

		.template-table tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0 var(--df-p-space-2);
			padding: var(--df-p-space-4);
			border-bottom: 1px solid var(--df-border-hairline);
		}

		.template-table tr:last-child {
			border-bottom: 0;
		}

		.template-table td {
			display: grid;
			grid-template-columns: 6.5rem minmax(0, 1fr);
			grid-column: 1 / -1;
			align-items: baseline;
			gap: var(--df-p-space-2);
			padding: var(--df-p-space-1) 0;
			border-bottom: 0;
			justify-items: start;
		}

		.template-table td:first-child {
			padding-left: 0;
		}

		.template-table td:last-child {
			padding-right: 0;
		}

		.template-table td::before {
			content: attr(data-label);
			font-family: var(--df-p-font-mono);
			font-size: var(--df-p-text-2xs);
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--df-text-meta);
		}

		.template-table td:first-child {
			grid-template-columns: minmax(0, 1fr);
			grid-column: 1;
			padding-bottom: var(--df-p-space-2);
		}

		.template-table td:first-child::before {
			display: none;
		}

		/* The two row actions ride at the top right of the card, so the name and
		   the body keep the full width they need. */
		.template-table .row-actions {
			grid-column: 2;
			grid-row: 1;
			justify-self: end;
			align-self: start;
			justify-content: flex-end;
			padding-top: 0;
		}

		.template-table .row-actions::before {
			display: none;
		}

		.template-table .row-actions :global(.btn) {
			width: 44px;
			min-height: 44px;
		}

		/* Touch targets: every control in this page clears 44px, including the
		   compact row buttons that the global sheet leaves at 36px. */
		.btn,
		.btn-sm {
			min-height: 44px;
		}

		.btn-icon,
		.btn-icon.btn-sm {
			width: 44px;
			height: 44px;
		}

		.input {
			min-height: 44px;
		}

		.file-btn {
			min-height: 44px;
		}

		.import-side {
			flex-direction: column;
			align-items: stretch;
		}

		/* ConfirmDialog is a child component, so its buttons carry the global
		   classes without this page's scope. Raise them here, where the dialog is
		   opened at this width. */
		:global(.dialog .btn) {
			min-height: 44px;
		}

		:global(.dialog .btn-icon) {
			width: 44px;
			height: 44px;
		}

		.import-run {
			width: 100%;
		}

		.measure-facts {
			gap: var(--df-p-space-3);
		}
	}

	@media (hover: hover) and (pointer: fine) {
		.file-btn:hover {
			border-color: var(--df-border-strong);
			background: var(--df-surface-well);
		}

		.template-table tbody tr:hover {
			background: var(--df-c-table-row-bg-hover);
		}
	}
</style>
