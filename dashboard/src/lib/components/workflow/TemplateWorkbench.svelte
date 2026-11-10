<script lang="ts">
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

	// State
	let sampleBody = $state(
		initialSample ||
			'You have received Tk 800.00 from 01999999999. Ref INV102. Fee Tk 0.00. Balance Tk 1,200.00. TrxID 8G56H7J8K9 at 15/07/2026 11:24'
	);
	let spans = $state<TemplateSpan[]>(initialSpans.length > 0 ? [...initialSpans] : []);
	let additionalSamples = $state<string[]>([
		'You have received Tk 1,250.50 from 01812345678. Ref ORDER88. Fee Tk 0.00. Balance Tk 2,500.00. TrxID 9K12L3M4N5 at 16/07/2026 12:00',
		'Cash In Tk 540.00 from 01961116866 successful. Fee Tk 0.00. Balance Tk 1,090.78. TrxID 3277235345 at 14/09/2026 12:38'
	]);

	let compiledPattern = $state(initialPattern);
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
		{ id: 'money_bdt', label: '💰 Money (Tk / BDT)', defaultName: 'amount' },
		{ id: 'phone_bd', label: '📱 Phone Number (BD)', defaultName: 'sender_account' },
		{ id: 'trx_id', label: '🔑 Transaction ID', defaultName: 'trx_id' },
		{ id: 'datetime_bd', label: '🕒 Date & Time', defaultName: 'timestamp' },
		{ id: 'bank_account', label: '🏦 Bank Account (*1234)', defaultName: 'account_no' },
		{ id: 'number', label: '🔢 Plain Number', defaultName: 'num' },
		{ id: 'free_text', label: '🏷️ Free Text / Reference', defaultName: 'reference' }
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
				⚡ Auto-Detect Fields
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
							{#if token.span.role === 'trigger'}⚡{:else if token.span.role === 'ignore'}🚫{:else}🎯 {token.span.name}{/if}
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
						⚡ Trigger
					</button>
					<button
						type="button"
						class={`role-btn ${editRole === 'extract' ? 'active extract' : ''}`}
						onclick={() => (editRole = 'extract')}
					>
						🎯 Extract
					</button>
					<button
						type="button"
						class={`role-btn ${editRole === 'ignore' ? 'active ignore' : ''}`}
						onclick={() => (editRole = 'ignore')}
					>
						🚫 Ignore
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
					✓ Apply Span
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
				⚠️ {synthError}
			</div>
		{/if}

		<div class="match-list">
			{#each testMatches as match, i}
				<div class={`match-row ${match.matched ? 'matched' : 'unmatched'}`}>
					<div class="row-status">
						{#if match.matched}
							<span class="badge-ok">✅ Matched</span>
						{:else}
							<span class="badge-fail">⚠️ Unmatched</span>
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
			✓ Use Template in Step ({capturedVariables.length} Variables)
		</button>
	</div>
</div>

<style>
	.workbench {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
		background: #14171f;
		border: 1px solid #2d3343;
		border-radius: 8px;
		padding: 0.85rem;
		color: #e5e7eb;
		font-size: 0.82rem;
	}

	.wb-header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid #222734;
	}

	.wb-title {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		font-weight: 600;
		color: #60a5fa;
	}

	.preset-pills {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
	}

	.preset-label {
		font-size: 0.72rem;
		color: #94a3b8;
	}

	.btn-pill {
		background: #1e2433;
		border: 1px solid #334155;
		color: #cbd5e1;
		font-size: 0.72rem;
		padding: 0.15rem 0.5rem;
		border-radius: 9999px;
		cursor: pointer;
		transition: all 0.15s ease;
	}

	.btn-pill:hover {
		background: #2e384d;
		color: #fff;
	}

	.btn-suggest {
		background: #064e3b;
		border-color: #059669;
		color: #6ee7b7;
		font-weight: 600;
	}

	.token-surface-container {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.surface-label {
		font-size: 0.75rem;
		color: #94a3b8;
		font-weight: 500;
	}

	.token-chips-surface {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.2rem;
		padding: 0.75rem;
		background: #0f1219;
		border: 1px solid #1f2430;
		border-radius: 6px;
		line-height: 1.8;
		user-select: none;
	}

	.space-token {
		white-space: pre;
	}

	.token-chip {
		font-family: inherit;
		font-size: 0.8rem;
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
		cursor: pointer;
		border: 1px solid transparent;
		background: transparent;
		color: #cbd5e1;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		transition: all 0.15s ease;
	}

	.token-chip.unassigned:hover {
		background: #1e293b;
		border-color: #3b82f6;
	}

	.token-chip.is-selecting {
		background: #1e3a5f;
		border-color: #60a5fa;
		color: #fff;
	}

	.token-chip.span-trigger {
		background: #1e2238;
		border-color: #6366f1;
		color: #c7d2fe;
	}

	.token-chip.span-extract {
		background: #064e3b;
		border-color: #10b981;
		color: #a7f3d0;
	}

	.token-chip.span-ignore {
		background: #27272a;
		border-color: #52525b;
		color: #a1a1aa;
		text-decoration: line-through;
	}

	.token-chip.is-selected {
		box-shadow: 0 0 0 2px #f59e0b;
	}

	.span-tag {
		font-size: 0.65rem;
		opacity: 0.9;
		font-weight: 600;
	}

	.span-editor-popover {
		background: #1e2433;
		border: 1px solid #3b82f6;
		border-radius: 6px;
		padding: 0.6rem 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.popover-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.popover-title {
		font-weight: 600;
		color: #93c5fd;
		font-size: 0.75rem;
	}

	.role-selector {
		display: flex;
		gap: 0.25rem;
	}

	.role-btn {
		font-size: 0.7rem;
		padding: 0.15rem 0.45rem;
		border-radius: 4px;
		border: 1px solid #475569;
		background: #0f172a;
		color: #94a3b8;
		cursor: pointer;
	}

	.role-btn.active.trigger {
		background: #4f46e5;
		color: #fff;
		border-color: #6366f1;
	}

	.role-btn.active.extract {
		background: #059669;
		color: #fff;
		border-color: #10b981;
	}

	.role-btn.active.ignore {
		background: #475569;
		color: #fff;
		border-color: #64748b;
	}

	.popover-fields {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}

	.popover-field {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.popover-field label {
		font-size: 0.68rem;
		color: #94a3b8;
	}

	.wb-input,
	.wb-select {
		background: #0f1219;
		border: 1px solid #334155;
		border-radius: 4px;
		color: #f1f5f9;
		font-size: 0.75rem;
		padding: 0.2rem 0.4rem;
	}

	.optional-check {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 0.72rem;
		color: #cbd5e1;
		cursor: pointer;
		margin-top: 1rem;
	}

	.popover-actions {
		display: flex;
		gap: 0.35rem;
	}

	.btn-primary {
		background: #2563eb;
		color: #fff;
		border: none;
		border-radius: 4px;
		padding: 0.25rem 0.6rem;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
	}

	.btn-danger {
		background: #dc2626;
		color: #fff;
		border: none;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.btn-secondary {
		background: #334155;
		color: #e2e8f0;
		border: none;
		border-radius: 4px;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.preview-section {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.section-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.section-title {
		font-size: 0.75rem;
		font-weight: 600;
		color: #94a3b8;
	}

	.synthesizing-pill {
		font-size: 0.68rem;
		color: #60a5fa;
		font-style: italic;
	}

	.error-banner {
		background: #451a1a;
		border: 1px solid #991b1b;
		color: #fca5a5;
		padding: 0.4rem 0.6rem;
		border-radius: 4px;
		font-size: 0.75rem;
	}

	.match-list {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		max-height: 220px;
		overflow-y: auto;
	}

	.match-row {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.45rem 0.6rem;
		border-radius: 4px;
		background: #0f1219;
		border-left: 3px solid transparent;
	}

	.match-row.matched {
		border-left-color: #10b981;
	}

	.match-row.unmatched {
		border-left-color: #f59e0b;
	}

	.row-status {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.badge-ok {
		background: #064e3b;
		color: #6ee7b7;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		font-size: 0.68rem;
		font-weight: 600;
	}

	.badge-fail {
		background: #451a03;
		color: #fcd34d;
		padding: 0.1rem 0.35rem;
		border-radius: 3px;
		font-size: 0.68rem;
		font-weight: 600;
	}

	.sample-num {
		font-size: 0.68rem;
		color: #64748b;
	}

	.row-body {
		font-size: 0.73rem;
		color: #94a3b8;
		word-break: break-word;
	}

	.row-vars {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.var-pill {
		background: #1e293b;
		border: 1px solid #334155;
		border-radius: 3px;
		padding: 0.1rem 0.35rem;
		font-size: 0.68rem;
		color: #e2e8f0;
	}

	.var-pill code {
		color: #38bdf8;
	}

	.var-pill strong {
		color: #34d399;
	}

	.wb-footer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-top: 0.5rem;
		border-top: 1px solid #222734;
	}

	.pattern-preview {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}

	.pattern-label {
		font-size: 0.7rem;
		color: #94a3b8;
	}

	.pattern-code {
		font-family: monospace;
		font-size: 0.72rem;
		background: #0b0e14;
		padding: 0.35rem 0.5rem;
		border-radius: 4px;
		color: #fbbf24;
		border: 1px solid #1e2433;
		word-break: break-all;
	}

	.btn-apply-step {
		background: #059669;
		color: #fff;
		border: none;
		border-radius: 6px;
		padding: 0.45rem 0.85rem;
		font-weight: 600;
		font-size: 0.8rem;
		cursor: pointer;
		transition: background 0.15s ease;
	}

	.btn-apply-step:hover:not(:disabled) {
		background: #10b981;
	}

	.btn-apply-step:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
