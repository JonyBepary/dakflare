<script lang="ts">
	import { untrack } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import {
		suggestSpans,
		synthesizeTemplate,
		type TemplateSpan,
		type TemplateTestMatch
	} from '$lib/workflow/wasm-engine';
	import { STARTER_TEMPLATES, type StarterTemplate } from '$lib/workflow/starter-templates';

	let {
		initialPattern = '',
		initialSample = '',
		initialSpans = [],
		onapply
	}: {
		initialPattern?: string;
		initialSample?: string;
		initialSpans?: TemplateSpan[];
		onapply: (result: {
			pattern: string;
			sampleBody: string;
			spans: TemplateSpan[];
			variables: string[];
			testSamples: Array<{ body: string; expect_match: boolean }>;
		}) => void;
	} = $props();

	// State, seeded from the props ONCE.
	//
	// `untrack` is the documented way to say that: the parent keys this component
	// on the node id, so it remounts per node and these props never change under
	// it. Writing `$state(initialSample)` read as "capture the first value and
	// ignore the rest", which is what the compiler warned about, and which was a
	// real bug before the key existed.
	let sampleBody = $state(
		untrack(() => initialSample) ||
			'You have received Tk 800.00 from 01999999999. Ref INV102. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 8G56H7J8K9 at 15/07/2026 11:24'
	);
	let spans = $state<TemplateSpan[]>(
		untrack(() => (initialSpans.length > 0 ? [...initialSpans] : []))
	);
	let additionalSamples = $state<string[]>([
		'You have received Tk 1,250.50 from 01812345678. Ref ORDER88. Fee Tk 0.00. Balance Tk 2,500.00. TrxID 9K12L3M4N5 at 16/07/2026 12:00',
		'Cash In Tk 540.00 from 01961116866 successful. Fee Tk 0.00. Balance Tk 1,090.78. TrxID 3277235345 at 14/09/2026 12:38'
	]);

	let compiledPattern = $state(untrack(() => initialPattern));
	let capturedVariables = $state<string[]>([]);
	let testMatches = $state<TemplateTestMatch[]>([]);
	let synthError = $state<string | null>(null);
	let isSynthesizing = $state(false);

	// Selection state for token highlighting
	let selectionStart = $state<number | null>(null);
	let selectionEnd = $state<number | null>(null);
	let selectedSpanIndex = $state<number | null>(null);

	// Floating edit form state
	let editRole = $state<'trigger' | 'extract' | 'ignore'>('extract');
	let editName = $state('amount');
	let editType = $state('money_bdt');
	let editOptional = $state(false);

	const SLOT_TYPES = [
		{ id: 'money_bdt', label: 'Money (Tk / BDT)', defaultName: 'amount' },
		{ id: 'phone_bd', label: 'Phone Number (BD)', defaultName: 'sender_account' },
		{ id: 'trx_id', label: 'Transaction ID', defaultName: 'trx_id' },
		{ id: 'datetime_bd', label: 'Date & Time', defaultName: 'timestamp' },
		{ id: 'bank_account', label: 'Bank Account (*1234)', defaultName: 'account_no' },
		{ id: 'number', label: 'Plain Number', defaultName: 'num' },
		{ id: 'free_text', label: 'Free Text / Reference', defaultName: 'reference' }
	];

	// Tokenize sample text for token-chip click-to-select
	interface TextToken {
		text: string;
		start: number;
		end: number;
		span?: TemplateSpan;
		spanIndex?: number;
	}

	const tokens = $derived.by(() => {
		const result: TextToken[] = [];
		const regex = /([A-Za-z0-9_০-৯]+|[^\sA-Za-z0-9_০-৯]+|\s+)/gu;
		let match: RegExpExecArray | null;

		while ((match = regex.exec(sampleBody)) !== null) {
			const text = match[0];
			const start = match.index;
			const end = start + text.length;

			// Find if this token overlaps any span
			let matchingSpan: TemplateSpan | undefined;
			let matchingIndex: number | undefined;

			for (let i = 0; i < spans.length; i++) {
				const s = spans[i];
				if (start >= s.start && end <= s.end) {
					matchingSpan = s;
					matchingIndex = i;
					break;
				}
			}

			result.push({
				text,
				start,
				end,
				span: matchingSpan,
				spanIndex: matchingIndex
			});
		}
		return result;
	});

	// Trigger synthesis on span or sample change
	async function runSynthesis() {
		isSynthesizing = true;
		synthError = null;
		try {
			const res = await synthesizeTemplate(sampleBody, spans, additionalSamples);
			if (res.ok && res.result) {
				compiledPattern = res.result.pattern;
				capturedVariables = res.result.variables;
				testMatches = res.result.test_results;
			} else {
				synthError = res.message || res.reason || 'Failed to synthesize pattern';
			}
		} catch (e) {
			synthError = String(e);
		} finally {
			isSynthesizing = false;
		}
	}

	// Auto-suggest spans via Rust WASM
	async function runAutoSuggest() {
		try {
			const res = await suggestSpans(sampleBody);
			if (res.ok && res.spans && res.spans.length > 0) {
				spans = [...res.spans];
				await runSynthesis();
			}
		} catch (e) {
			console.warn('[TemplateWorkbench] auto-suggest failed:', e);
		}
	}

	function handleTokenClick(token: TextToken) {
		if (token.spanIndex !== undefined) {
			// Clicked an existing span: open for editing
			selectedSpanIndex = token.spanIndex;
			const s = spans[token.spanIndex];
			editRole = s.role as 'trigger' | 'extract' | 'ignore';
			editName = s.name;
			editType = s.slot_type || 'free_text';
			editOptional = Boolean(s.optional);
			selectionStart = s.start;
			selectionEnd = s.end;
			return;
		}

		if (selectionStart === null) {
			// First click: start selection
			selectionStart = token.start;
			selectionEnd = token.end;
			selectedSpanIndex = null;
			guessSpanDefaults(token.text);
		} else {
			// Second click: extend selection
			if (token.end >= selectionStart) {
				selectionEnd = token.end;
			} else {
				selectionEnd = selectionStart;
				selectionStart = token.start;
			}
		}
	}

	function guessSpanDefaults(text: string) {
		const trimmed = text.trim();
		if (/^01[3-9]\d{8}/.test(trimmed)) {
			editRole = 'extract';
			editType = 'phone_bd';
			editName = 'sender_account';
		} else if (/^[0-9,]+(\.[0-9]{1,2})?$/.test(trimmed)) {
			editRole = 'extract';
			editType = 'money_bdt';
			editName = 'amount';
		} else if (/^[A-Z0-9]{8,12}$/.test(trimmed)) {
			editRole = 'extract';
			editType = 'trx_id';
			editName = 'trx_id';
		} else if (/You have|Cash In|Payment|Received/i.test(trimmed)) {
			editRole = 'trigger';
			editName = 'trigger';
		} else {
			editRole = 'extract';
			editType = 'free_text';
			editName = 'val_' + (spans.length + 1);
		}
	}

	function applySelection() {
		if (selectionStart === null || selectionEnd === null) return;
		const start = Math.min(selectionStart, selectionEnd);
		const end = Math.max(selectionStart, selectionEnd);

		const newSpan: TemplateSpan = {
			role: editRole,
			name: editName.trim() || 'val',
			slot_type: editRole === 'extract' ? editType : undefined,
			start,
			end,
			optional: editOptional
		};

		if (selectedSpanIndex !== null && selectedSpanIndex >= 0) {
			spans[selectedSpanIndex] = newSpan;
		} else {
			spans = [...spans, newSpan];
		}

		selectionStart = null;
		selectionEnd = null;
		selectedSpanIndex = null;
		void runSynthesis();
	}

	function removeSpan(index: number) {
		spans = spans.filter((_, i) => i !== index);
		selectionStart = null;
		selectionEnd = null;
		selectedSpanIndex = null;
		void runSynthesis();
	}

	function loadPreset(preset: StarterTemplate) {
		sampleBody = preset.sampleBody;
		spans = [];
		additionalSamples = preset.testSamples.map((s) => s.body);
		void runAutoSuggest();
	}

	function commitTemplate() {
		onapply({
			pattern: compiledPattern,
			sampleBody,
			spans,
			variables: capturedVariables,
			testSamples: [
				{ body: sampleBody, expect_match: true },
				...additionalSamples.map((body) => ({ body, expect_match: true }))
			]
		});
	}

	// Run initial synthesis or auto-suggest on mount
	$effect(() => {
		if (spans.length === 0) {
			void runAutoSuggest();
		} else {
			void runSynthesis();
		}
	});
</script>

<div class="workbench">
	<!-- Preset Picker Bar -->
	<div class="wb-header">
		<div class="wb-title">
			<Icon name="zap" size={16} />
			<span>Highlight-to-Template (PBE) Workbench</span>
		</div>
		<div class="preset-pills">
			<span class="preset-label">Presets:</span>
			{#each STARTER_TEMPLATES.slice(0, 4) as preset}
				<button type="button" class="btn-pill" onclick={() => loadPreset(preset)}>
					{preset.name.split(' ')[0]}
				</button>
			{/each}
			<button type="button" class="btn-pill btn-suggest" onclick={runAutoSuggest}>
				<Icon name="zap" size={16} /> Auto-Detect Fields
			</button>
		</div>
	</div>

	<!-- Interactive Token Highlighting Surface -->
	<div class="token-surface-container">
		<label class="surface-label" for="sample-input">
			1. Highlight or tap words in this message to assign fields:
		</label>
		<div class="token-chips-surface" role="region" aria-label="Interactive SMS token chips">
			{#each tokens as token (token.start + '-' + token.end)}
				{#if token.text.trim() === ''}
					<span class="space-token">{token.text}</span>
				{:else if token.span}
					<button
						type="button"
						class={`token-chip span-${token.span.role} ${token.spanIndex === selectedSpanIndex ? 'is-selected' : ''}`}
						onclick={() => handleTokenClick(token)}
						title={`${token.span.role.toUpperCase()}: ${token.span.name} (${token.span.slot_type || 'anchor'})`}
					>
						<span class="token-text">{token.text}</span>
						<span class="span-tag">
							{#if token.span.role === 'trigger'}<Icon name="zap" size={16} />{:else if token.span.role === 'ignore'}<Icon name="x" size={16} />{:else}<Icon name="filter" size={16} /> {token.span.name}{/if}
						</span>
					</button>
				{:else}
					<button
						type="button"
						class={`token-chip unassigned ${selectionStart !== null && token.start >= selectionStart && token.end <= (selectionEnd ?? selectionStart) ? 'is-selecting' : ''}`}
						onclick={() => handleTokenClick(token)}
					>
						{token.text}
					</button>
				{/if}
			{/each}
		</div>
	</div>

	<!-- Floating/Inline Span Role Editor -->
	{#if selectionStart !== null && selectionEnd !== null}
		<div class="span-editor-popover">
			<div class="popover-row">
				<span class="popover-title">
					{selectedSpanIndex !== null ? 'Edit Span' : 'Assign Highlighted Span'}
				</span>
				<div class="role-selector">
					<button
						type="button"
						class={`role-btn ${editRole === 'trigger' ? 'active trigger' : ''}`}
						onclick={() => (editRole = 'trigger')}
					>
						<Icon name="zap" size={16} /> Trigger
					</button>
					<button
						type="button"
						class={`role-btn ${editRole === 'extract' ? 'active extract' : ''}`}
						onclick={() => (editRole = 'extract')}
					>
						<Icon name="filter" size={16} /> Extract
					</button>
					<button
						type="button"
						class={`role-btn ${editRole === 'ignore' ? 'active ignore' : ''}`}
						onclick={() => (editRole = 'ignore')}
					>
						<Icon name="x" size={16} /> Ignore
					</button>
				</div>
			</div>

			{#if editRole === 'extract'}
				<div class="popover-fields">
					<div class="popover-field">
						<label for="span-name">Variable Name</label>
						<input
							id="span-name"
							class="wb-input"
							bind:value={editName}
							placeholder="amount"
							autocomplete="off"
						/>
					</div>
					<div class="popover-field">
						<label for="span-type">Type</label>
						<select id="span-type" class="wb-select" bind:value={editType}>
							{#each SLOT_TYPES as st}
								<option value={st.id}>{st.label}</option>
							{/each}
						</select>
					</div>
					<label class="optional-check">
						<input type="checkbox" bind:checked={editOptional} />
						<span>Optional clause</span>
					</label>
				</div>
			{/if}

			<div class="popover-actions">
				<button type="button" class="btn-primary" onclick={applySelection}>
					<Icon name="check" size={16} /> Apply Span
				</button>
				{#if selectedSpanIndex !== null}
					<button
						type="button"
						class="btn-danger"
						onclick={() => removeSpan(selectedSpanIndex!)}
					>
						Remove
					</button>
				{/if}
				<button
					type="button"
					class="btn-secondary"
					onclick={() => {
						selectionStart = null;
						selectionEnd = null;
						selectedSpanIndex = null;
					}}
				>
					Cancel
				</button>
			</div>
		</div>
	{/if}

	<!-- Live Match Preview Across Samples -->
	<div class="preview-section">
		<div class="section-head">
			<span class="section-title">2. Live Multi-Sample Match & Extraction Preview</span>
			{#if isSynthesizing}
				<span class="synthesizing-pill">Evaluating in flow.wasm...</span>
			{/if}
		</div>

		{#if synthError}
			<div class="error-banner">
				<Icon name="alert" size={16} /> {synthError}
			</div>
		{/if}

		<div class="match-list">
			{#each testMatches as match, i}
				<div class={`match-row ${match.matched ? 'matched' : 'unmatched'}`}>
					<div class="row-status">
						{#if match.matched}
							<span class="badge-ok"><Icon name="check" size={16} /> Matched</span>
						{:else}
							<span class="badge-fail"><Icon name="alert" size={16} /> Unmatched</span>
						{/if}
						<span class="sample-num">Sample #{i + 1}</span>
					</div>
					<div class="row-body">{match.body}</div>
					{#if match.matched && Object.keys(match.extracted).length > 0}
						<div class="row-vars">
							{#each Object.entries(match.extracted) as [k, v]}
								<span class="var-pill">
									<code>{k}</code> = <strong>{v}</strong>
								</span>
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<!-- Compiled Pattern & Footer Actions -->
	<div class="wb-footer">
		<div class="pattern-preview">
			<span class="pattern-label">Compiled RE2 Pattern:</span>
			<code class="pattern-code">{compiledPattern || '(Highlight a span to synthesize pattern)'}</code>
		</div>
		<button
			type="button"
			class="btn-apply-step"
			disabled={!compiledPattern || capturedVariables.length === 0}
			onclick={commitTemplate}
		>
			<Icon name="check" size={16} /> Use Template in Step ({capturedVariables.length} Variables)
		</button>
	</div>
</div>

<style>
	.workbench {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		background: var(--df-surface-card);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		padding: var(--df-p-space-4);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-base);
	}

	.wb-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		padding-bottom: var(--df-p-space-2);
		border-bottom: 1px solid var(--df-border-hairline);
	}

	.wb-title {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-1);
		font-weight: 600;
		color: var(--df-accent-text);
	}

	.preset-pills {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-1);
		flex-wrap: wrap;
	}

	.preset-label {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.btn-pill {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--df-surface-well);
		border: 1px solid var(--df-border-control);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		padding: 2px 8px;
		border-radius: var(--df-p-radius-pill);
		cursor: pointer;
		transition:
			background-color 140ms ease-out,
			border-color 140ms ease-out,
			color 140ms ease-out;
	}

	.btn-pill:hover {
		background: var(--df-surface-press);
		color: var(--df-text-primary);
	}

	.btn-suggest {
		background: var(--df-state-ok-bg);
		border-color: var(--df-state-ok-ink);
		color: var(--df-state-ok-ink);
		font-weight: 600;
	}

	.token-surface-container {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.surface-label {
		font-size: var(--df-p-text-sm);
		color: var(--df-text-meta);
		font-weight: 500;
	}

	.token-chips-surface {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 3px;
		padding: var(--df-p-space-3);
		background: var(--df-surface-well);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		line-height: 1.8;
		user-select: none;
	}

	.space-token {
		white-space: pre;
	}

	.token-chip {
		font-family: inherit;
		font-size: var(--df-p-text-base);
		padding: 2px 6px;
		border-radius: var(--df-p-radius-xs);
		cursor: pointer;
		border: 1px solid transparent;
		background: transparent;
		color: var(--df-text-secondary);
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		transition:
			background-color 140ms ease-out,
			border-color 140ms ease-out,
			color 140ms ease-out;
	}

	.token-chip.unassigned:hover {
		background: var(--df-surface-card);
		border-color: var(--df-accent-text);
	}

	.token-chip.is-selecting {
		background: var(--df-accent-soft);
		border-color: var(--df-accent-text);
		color: var(--df-text-primary);
	}

	.token-chip.span-trigger {
		background: var(--df-accent-soft);
		border-color: var(--df-accent-text);
		color: var(--df-accent-text);
	}

	.token-chip.span-extract {
		background: var(--df-state-info-bg);
		border-color: var(--df-state-info-ink);
		color: var(--df-state-info-ink);
	}

	.token-chip.span-ignore {
		background: var(--df-state-neutral-bg);
		border-color: var(--df-state-neutral-ink);
		color: var(--df-state-neutral-ink);
		text-decoration: line-through;
	}

	.token-chip.is-selected {
		box-shadow: 0 0 0 2px var(--df-accent-text);
	}

	.span-tag {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: var(--df-p-text-2xs);
		opacity: 0.9;
		font-weight: 600;
	}

	.span-editor-popover {
		background: var(--df-surface-well);
		border: 1px solid var(--df-accent-text);
		border-radius: var(--df-p-radius-md);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
	}

	.popover-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
	}

	.popover-title {
		font-weight: 600;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
	}

	.role-selector {
		display: flex;
		gap: var(--df-p-space-1);
	}

	.role-btn {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: var(--df-p-text-xs);
		padding: 2px 7px;
		border-radius: var(--df-p-radius-xs);
		border: 1px solid var(--df-border-control);
		background: var(--df-surface-card);
		color: var(--df-text-meta);
		cursor: pointer;
	}

	.role-btn.active.trigger {
		background: var(--df-accent-fill);
		color: var(--df-text-on-accent);
		border-color: var(--df-accent-fill);
	}

	.role-btn.active.extract {
		background: var(--df-state-ok-bg);
		color: var(--df-state-ok-ink);
		border-color: var(--df-state-ok-ink);
	}

	.role-btn.active.ignore {
		background: var(--df-state-neutral-bg);
		color: var(--df-state-neutral-ink);
		border-color: var(--df-state-neutral-ink);
	}

	.popover-fields {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--df-p-space-2);
	}

	.popover-field {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.popover-field label {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.wb-input,
	.wb-select {
		background: var(--df-surface-well);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		padding: 3px 7px;
	}

	.optional-check {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
		cursor: pointer;
		margin-top: var(--df-p-space-3);
	}

	.popover-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--df-p-space-1);
	}

	.btn-primary {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--df-accent-fill);
		color: var(--df-text-on-accent);
		border: 1px solid var(--df-accent-fill);
		border-radius: var(--df-p-radius-sm);
		padding: 4px 10px;
		font-size: var(--df-p-text-sm);
		font-weight: 500;
		cursor: pointer;
	}

	.btn-danger {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		background: var(--df-state-danger-fill);
		color: var(--df-text-on-danger);
		border: 1px solid var(--df-state-danger-fill);
		border-radius: var(--df-p-radius-sm);
		padding: 4px 8px;
		font-size: var(--df-p-text-sm);
		cursor: pointer;
	}

	.btn-secondary {
		background: var(--df-surface-press);
		color: var(--df-text-primary);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-sm);
		padding: 4px 8px;
		font-size: var(--df-p-text-sm);
		cursor: pointer;
	}

	.preview-section {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-1);
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
	}

	.section-title {
		font-size: var(--df-p-text-sm);
		font-weight: 600;
		color: var(--df-text-meta);
	}

	.synthesizing-pill {
		font-size: var(--df-p-text-2xs);
		color: var(--df-accent-text);
		font-style: italic;
	}

	.error-banner {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-1);
		background: var(--df-state-danger-bg);
		border: 1px solid var(--df-state-danger-ink);
		color: var(--df-state-danger-ink);
		padding: var(--df-p-space-2);
		border-radius: var(--df-p-radius-sm);
		font-size: var(--df-p-text-sm);
	}

	.match-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
		max-height: 220px;
		overflow-y: auto;
	}

	.match-row {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding: 6px 10px;
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		border-left: 3px solid transparent;
	}

	.match-row.matched {
		border-left-color: var(--df-state-ok-ink);
	}

	.match-row.unmatched {
		border-left-color: var(--df-state-warn-ink);
	}

	.row-status {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
	}

	.badge-ok {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		background: var(--df-state-ok-bg);
		color: var(--df-state-ok-ink);
		padding: 2px 6px;
		border-radius: var(--df-p-radius-xs);
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
	}

	.badge-fail {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		background: var(--df-state-warn-bg);
		color: var(--df-state-warn-ink);
		padding: 2px 6px;
		border-radius: var(--df-p-radius-xs);
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
	}

	.sample-num {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.row-body {
		font-size: var(--df-p-text-sm);
		color: var(--df-text-meta);
		word-break: break-word;
	}

	.row-vars {
		display: flex;
		flex-wrap: wrap;
		gap: var(--df-p-space-1);
	}

	.var-pill {
		background: var(--df-surface-card);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		padding: 2px 6px;
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-primary);
	}

	.var-pill code {
		color: var(--df-state-info-ink);
	}

	.var-pill strong {
		color: var(--df-state-ok-ink);
	}

	.wb-footer {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding-top: var(--df-p-space-2);
		border-top: 1px solid var(--df-border-hairline);
	}

	.pattern-preview {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.pattern-label {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.pattern-code {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		background: var(--df-surface-well);
		padding: 5px 8px;
		border-radius: var(--df-p-radius-xs);
		color: var(--df-accent-text);
		border: 1px solid var(--df-border-hairline);
		word-break: break-all;
	}

	.btn-apply-step {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		background: var(--df-state-ok-bg);
		color: var(--df-state-ok-ink);
		border: 1px solid var(--df-state-ok-ink);
		border-radius: var(--df-p-radius-sm);
		padding: 7px 12px;
		font-weight: 600;
		font-size: var(--df-p-text-base);
		cursor: pointer;
		transition:
			background-color 140ms ease-out,
			border-color 140ms ease-out,
			color 140ms ease-out;
	}

	.btn-apply-step:hover:not(:disabled) {
		background: var(--df-state-ok-ink);
		color: var(--df-state-ok-bg);
	}

	.btn-apply-step:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@container (width < 420px) {
		.wb-header {
			flex-direction: column;
			align-items: stretch;
		}

		.preset-pills {
			width: 100%;
		}

		.popover-row {
			flex-direction: column;
			align-items: stretch;
		}

		.popover-fields {
			flex-direction: column;
			align-items: stretch;
		}

		.popover-field {
			width: 100%;
		}

		.optional-check {
			margin-top: 0;
		}
	}
</style>
