<script lang="ts">
	import CopyButton from '$lib/components/CopyButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import VariableHints from './VariableHints.svelte';
	import type {
		BodyMode,
		ConditionData,
		ConditionOp,
		ExtractData,
		ModeSpec,
		SendSmsData,
		SenderMode,
		StopData,
		TriggerData
	} from '$lib/types';
	import {
		NODE_META,
		SMS_BODY_LIMIT,
		SMS_TO_LIMIT,
		branchTarget,
		checkRegex,
		extractGroupNames,
		fieldErrorsForNode,
		issuesForNode,
		nodeData,
		nodeSummary,
		templateVariables,
		type EditorIssue,
		type FlowEdge,
		type FlowNode
	} from '$lib/workflow/graph';

	let {
		node,
		nodes,
		edges,
		issues,
		onupdate,
		ondelete,
		onselect
	}: {
		node: FlowNode;
		nodes: FlowNode[];
		edges: FlowEdge[];
		issues: EditorIssue[];
		onupdate: (patch: Record<string, unknown>) => void;
		ondelete: () => void;
		onselect: (id: string) => void;
	} = $props();

	const HELP: Record<string, string> = {
		trigger: 'Starts the flow when a matching message arrives.',
		extract: 'Pulls a value out of the message with a named capture group.',
		condition: 'Sends the flow down the true or false branch.',
		send_sms: 'Writes a message. In this console it is previewed, not sent.',
		stop: 'Ends the flow. Nothing after this step runs.'
	};

	const meta = $derived(NODE_META[node.type]);
	const index = $derived(nodes.findIndex((item) => item.id === node.id));
	const fieldErrors = $derived(fieldErrorsForNode(issues, node, nodes));
	const nodeIssues = $derived(
		issuesForNode(issues, node).filter((issue) => !issue.path.startsWith(`nodes[${index}].data.`))
	);
	const variables = $derived(templateVariables(nodes));

	const trigger = $derived(nodeData<TriggerData>(node));
	const extract = $derived(nodeData<ExtractData>(node));
	const condition = $derived(nodeData<ConditionData>(node));
	const sms = $derived(nodeData<SendSmsData>(node));
	const stop = $derived(nodeData<StopData>(node));

	const senderMode = $derived(trigger.sender?.mode ?? 'any');
	const bodyMode = $derived(trigger.body?.mode ?? 'any');
	const extractCheck = $derived(
		checkRegex(extract.pattern ?? '', extract.flags === 'i' ? 'i' : '')
	);
	const matchCheck = $derived(checkRegex(condition.right ?? ''));
	const trueTarget = $derived(branchTarget(node, 'true', edges, nodes));
	const falseTarget = $derived(branchTarget(node, 'false', edges, nodes));

	function setSender(patch: Partial<ModeSpec<SenderMode>>) {
		const current = trigger.sender ?? { mode: 'any' as SenderMode };
		onupdate({ sender: { ...current, ...patch } });
	}

	function setBody(patch: Partial<ModeSpec<BodyMode>>) {
		const current = trigger.body ?? { mode: 'any' as BodyMode };
		onupdate({ body: { ...current, ...patch } });
	}

	function error(field: string): string | null {
		return fieldErrors[field] ?? null;
	}

	function describedBy(field: string, hintId?: string): string | undefined {
		const ids = [error(field) ? `err-${node.id}-${field.replace('.', '-')}` : null, hintId ?? null];
		return ids.filter(Boolean).join(' ') || undefined;
	}

	function token(name: string): string {
		return `{{${name}}}`;
	}

	function setOp(next: ConditionOp) {
		if (next === 'exists') onupdate({ op: next, right: undefined });
		else onupdate({ op: next, right: condition.right ?? '' });
	}
</script>

<section class="panel inspector" aria-labelledby="inspector-title">
	<div class="inspector-head">
		<span class="inspector-icon"><Icon name={meta.icon} size={15} /></span>
		<div class="inspector-title">
			<p class="eyebrow">Selected step</p>
			<h2 id="inspector-title">{meta.title}</h2>
		</div>
		<span class="copy-slot"><CopyButton value={node.id} label="Copy node id" iconOnly /></span>
	</div>

	<p class="inspector-help">{HELP[node.type]}</p>
	<p class="inspector-summary mono">{nodeSummary(node)}</p>

	<div class="inspector-body">
		{#if node.type === 'trigger'}
			<div class="field">
				<label class="label" for={`sender-mode-${node.id}`}>Sender filter</label>
				<select
					id={`sender-mode-${node.id}`}
					class="input"
					value={senderMode}
					onchange={(event) => setSender({ mode: event.currentTarget.value as SenderMode })}
				>
					<option value="any">Any sender</option>
					<option value="exact">Exactly</option>
					<option value="prefix">Starts with</option>
					<option value="regex">Matches regex</option>
				</select>
				{#if senderMode !== 'any'}
					<input
						id={`sender-value-${node.id}`}
						class="input input-mono"
						placeholder={senderMode === 'regex' ? '^\\+1555\\d{7}$' : '+15551234567'}
						value={trigger.sender?.value ?? ''}
						oninput={(event) => setSender({ value: event.currentTarget.value })}
						aria-label="Sender filter value"
						aria-invalid={error('sender.value') ? 'true' : undefined}
						aria-describedby={describedBy('sender.value', `sender-hint-${node.id}`)}
						spellcheck="false"
					/>
					{#if error('sender.value')}
						<p class="field-error" id={`err-${node.id}-sender-value`}>{error('sender.value')}</p>
					{:else if senderMode === 'regex'}
						{@const senderCheck = checkRegex(trigger.sender?.value ?? '')}
						<p class="hint" class:invalid={!senderCheck.valid && Boolean(trigger.sender?.value)}>
							{senderCheck.valid
								? 'Regex is valid.'
								: (senderCheck.error ?? 'Waiting for a pattern.')}
						</p>
					{/if}
				{/if}
				<p class="hint" id={`sender-hint-${node.id}`}>
					{trigger.sender?.mode === 'any'
						? 'Every sender is accepted.'
						: 'Only messages from this sender start the flow.'}
				</p>
			</div>

			<div class="field">
				<label class="label" for={`body-mode-${node.id}`}>Message filter</label>
				<select
					id={`body-mode-${node.id}`}
					class="input"
					value={bodyMode}
					onchange={(event) => setBody({ mode: event.currentTarget.value as BodyMode })}
				>
					<option value="any">Any message</option>
					<option value="keyword">Contains</option>
					<option value="regex">Matches regex</option>
				</select>
				{#if bodyMode !== 'any'}
					<input
						id={`body-value-${node.id}`}
						class="input input-mono"
						placeholder={bodyMode === 'regex' ? '^ORDER\\s+[A-Z0-9]+$' : 'ORDER'}
						value={trigger.body?.value ?? ''}
						oninput={(event) => setBody({ value: event.currentTarget.value })}
						aria-label="Message filter value"
						aria-invalid={error('body.value') ? 'true' : undefined}
						aria-describedby={describedBy('body.value', `body-hint-${node.id}`)}
						spellcheck="false"
					/>
					{#if error('body.value')}
						<p class="field-error" id={`err-${node.id}-body-value`}>{error('body.value')}</p>
					{:else if bodyMode === 'regex'}
						{@const bodyCheck = checkRegex(trigger.body?.value ?? '')}
						<p class="hint" class:invalid={!bodyCheck.valid && Boolean(trigger.body?.value)}>
							{bodyCheck.valid ? 'Regex is valid.' : (bodyCheck.error ?? 'Waiting for a pattern.')}
						</p>
					{/if}
				{/if}
				<p class="hint" id={`body-hint-${node.id}`}>
					Keywords are case-sensitive and match anywhere in the message.
				</p>
			</div>
		{:else if node.type === 'extract'}
			<div class="field">
				<label class="label" for={`extract-source-${node.id}`}>Read from</label>
				<select
					id={`extract-source-${node.id}`}
					class="input"
					value={extract.source ?? 'body'}
					onchange={(event) => onupdate({ source: event.currentTarget.value })}
				>
					<option value="body">Message body</option>
					<option value="sender">Sender number</option>
				</select>
			</div>

			<div class="field">
				<label class="label" for={`extract-pattern-${node.id}`}>Pattern</label>
				<input
					id={`extract-pattern-${node.id}`}
					class="input input-mono"
					placeholder="ORDER (?<order_id>[A-Z0-9-]+)"
					value={extract.pattern ?? ''}
					oninput={(event) => onupdate({ pattern: event.currentTarget.value })}
					aria-label="Extract pattern"
					aria-invalid={error('pattern') ? 'true' : undefined}
					aria-describedby={`${!extract.pattern || extractCheck.valid ? `pattern-hint-${node.id}` : ''} ${error('pattern') ? `err-${node.id}-pattern` : ''}`.trim() || undefined}
					spellcheck="false"
					autocomplete="off"
				/>
				{#if error('pattern')}
					<p class="field-error" id={`err-${node.id}-pattern`}>{error('pattern')}</p>
				{:else if extract.pattern && !extractCheck.valid}
					<p class="field-error">{extractCheck.error}</p>
				{:else if extract.pattern && extractCheck.groups.length > 0}
					<p class="hint ok">
						Valid. Captures {extractCheck.groups.map((group) => `{{${group}}}`).join(', ')}.
					</p>
				{:else if extract.pattern}
					<p class="hint invalid">No named group yet — add one like (?&lt;name&gt;...).</p>
				{/if}
				<p class="hint" id={`pattern-hint-${node.id}`}>
					Use a named group so later steps can reference the value. If the pattern does not
					match, the flow stops here.
				</p>
			</div>

			<div class="field">
				<label class="label" for={`extract-flags-${node.id}`}>Matching</label>
				<select
					id={`extract-flags-${node.id}`}
					class="input"
					value={extract.flags ?? ''}
					onchange={(event) => onupdate({ flags: event.currentTarget.value })}
				>
					<option value="">Case-sensitive</option>
					<option value="i">Ignore case</option>
				</select>
			</div>

			{#if extract.pattern && extractGroupNames(extract.pattern).length > 0}
				<div class="captures">
					<p class="eyebrow">This step captures</p>
					<ul class="capture-list">
						{#each extractGroupNames(extract.pattern) as group (group)}
							<li><code>{token(group)}</code></li>
						{/each}
					</ul>
				</div>
			{/if}
		{:else if node.type === 'condition'}
			<div class="field">
				<label class="label" for={`condition-left-${node.id}`}>Value to test</label>
				<input
					id={`condition-left-${node.id}`}
					class="input input-mono"
					placeholder={'{{order_id}}'}
					value={condition.left ?? ''}
					oninput={(event) => onupdate({ left: event.currentTarget.value })}
					aria-label="Value to test"
					aria-invalid={error('left') ? 'true' : undefined}
					aria-describedby={describedBy('left', `condition-vars-${node.id}`)}
					spellcheck="false"
					autocomplete="off"
				/>
				{#if error('left')}
					<p class="field-error" id={`err-${node.id}-left`}>{error('left')}</p>
				{/if}
			</div>

			<div class="field">
				<label class="label" for={`condition-op-${node.id}`}>Comparison</label>
				<select
					id={`condition-op-${node.id}`}
					class="input"
					value={condition.op ?? 'equals'}
					onchange={(event) => setOp(event.currentTarget.value as ConditionOp)}
				>
					<option value="equals">equals</option>
					<option value="not_equals">does not equal</option>
					<option value="contains">contains</option>
					<option value="matches">matches regex</option>
					<option value="exists">exists</option>
				</select>
			</div>

			{#if condition.op !== 'exists'}
				<div class="field">
					<label class="label" for={`condition-right-${node.id}`}>
						Compare with
						{#if condition.op === 'matches'}
							<span class="optional">regex</span>
						{/if}
					</label>
					<input
						id={`condition-right-${node.id}`}
						class="input input-mono"
						placeholder={condition.op === 'matches' ? '^[A-Z]{2}-\\d+$' : 'A-1042'}
						value={condition.right ?? ''}
						oninput={(event) => onupdate({ right: event.currentTarget.value })}
						aria-label="Compare with"
						aria-invalid={error('right') ? 'true' : undefined}
						aria-describedby={describedBy('right', `condition-vars-${node.id}`)}
						spellcheck="false"
						autocomplete="off"
					/>
					{#if error('right')}
						<p class="field-error" id={`err-${node.id}-right`}>{error('right')}</p>
					{:else if condition.op === 'matches' && condition.right && !matchCheck.valid}
						<p class="field-error">{matchCheck.error}</p>
					{/if}
				</div>
			{/if}

			<div class="field" id={`condition-vars-${node.id}`}>
				<VariableHints {variables} />
			</div>

			<div class="branches">
				<p class="eyebrow">Where each branch goes</p>
				{#each [{ key: 'true', target: trueTarget }, { key: 'false', target: falseTarget }] as branch (branch.key)}
					<div class="branch-row">
						<span class="branch-key {branch.key}">{branch.key}</span>
						<span class="branch-arrow" aria-hidden="true"><Icon name="arrow-up-right" size={11} /></span>
						{#if branch.target}
							<button
								type="button"
								class="link-btn branch-target"
								onclick={() => branch.target && onselect(branch.target.id)}
							>
								{NODE_META[branch.target.type].title}
							</button>
						{:else}
							<span class="branch-missing">Not connected</span>
						{/if}
					</div>
				{/each}
				<p class="hint">
					Drag from the true or false handle on the node to connect each side. Both branches
					are required.
				</p>
			</div>
		{:else if node.type === 'send_sms'}
			<div class="field">
				<label class="label" for={`sms-to-${node.id}`}>To</label>
				<input
					id={`sms-to-${node.id}`}
					class="input input-mono"
					placeholder={'{{sender}}'}
					value={sms.to ?? ''}
					oninput={(event) => onupdate({ to: event.currentTarget.value })}
					aria-label="Send to"
					aria-invalid={error('to') ? 'true' : undefined}
					aria-describedby={describedBy('to', `sms-vars-${node.id}`)}
					spellcheck="false"
					autocomplete="off"
				/>
				{#if error('to')}
					<p class="field-error" id={`err-${node.id}-to`}>{error('to')}</p>
				{/if}
				<p class="hint">Use {'{{sender}}'} to reply to the incoming number. Up to {SMS_TO_LIMIT} characters.</p>
			</div>

			<div class="field">
				<label class="label" for={`sms-body-${node.id}`}>Message</label>
				<textarea
					id={`sms-body-${node.id}`}
					class="input"
					rows="4"
					placeholder={'Thanks — order {{order_id}} is confirmed.'}
					value={sms.body ?? ''}
					oninput={(event) => onupdate({ body: event.currentTarget.value })}
					aria-label="Message body"
					aria-invalid={error('body') ? 'true' : undefined}
					aria-describedby={describedBy('body', `sms-vars-${node.id}`)}
					spellcheck="true"
				></textarea>
				{#if error('body')}
					<p class="field-error" id={`err-${node.id}-body`}>{error('body')}</p>
				{/if}
				<div class="field-foot">
					<span class="hint">{(sms.body ?? '').length} characters</span>
					<span class="hint">Max {SMS_BODY_LIMIT}</span>
				</div>
			</div>

			<div class="field" id={`sms-vars-${node.id}`}>
				<VariableHints {variables} />
			</div>
		{:else if node.type === 'stop'}
			<div class="field">
				<label class="label" for={`stop-reason-${node.id}`}>
					Reason <span class="optional">optional</span>
				</label>
				<input
					id={`stop-reason-${node.id}`}
					class="input"
					placeholder="e.g. Already handled"
					value={stop.reason ?? ''}
					oninput={(event) => onupdate({ reason: event.currentTarget.value })}
					aria-label="Stop reason"
					autocomplete="off"
				/>
				{#if error('reason')}
					<p class="field-error">{error('reason')}</p>
				{/if}
				<p class="hint">A note for whoever reads the flow later. It is not sent anywhere.</p>
			</div>
		{/if}

		{#if nodeIssues.length > 0}
			<ul class="node-issues" aria-label="Problems with this node">
				{#each nodeIssues as issue (issue.path + issue.message)}
					<li><Icon name="alert" size={12} /><span>{issue.message}</span></li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="inspector-foot">
		<span class="mono node-id" title={node.id}>{node.id}</span>
		<button type="button" class="btn btn-danger btn-sm" onclick={ondelete}>
			<Icon name="trash" size={12} /> Delete step
		</button>
	</div>
</section>

<style>
	.inspector {
		min-width: 0;
		border-radius: var(--df-p-radius-lg);
		overflow: hidden;
	}

	.inspector-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.inspector-icon {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		flex: none;
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		color: var(--df-text-secondary);
	}

	.inspector-title {
		min-width: 0;
	}

	.inspector-title h2 {
		margin-top: 1px;
		font-size: var(--df-p-text-md);
		letter-spacing: -0.01em;
	}

	.copy-slot {
		margin-left: auto;
		display: flex;
	}

	.inspector-help {
		padding: var(--df-p-space-2) var(--df-p-space-4) 0;
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.inspector-summary {
		margin: 6px var(--df-p-space-4) 0;
		padding: 5px 7px;
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-2xs);
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.inspector-body {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
	}

	.field-foot {
		display: flex;
		justify-content: space-between;
		gap: var(--df-p-space-2);
	}

	.captures {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding-top: 2px;
	}

	.capture-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.capture-list code {
		padding: 1px 4px;
		border: 1px solid var(--df-border-hairline);
		border-radius: 3px;
		background: var(--df-surface-well);
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
	}

	.branches {
		display: flex;
		flex-direction: column;
		gap: 7px;
		padding-top: 10px;
		border-top: 1px solid var(--df-border-hairline);
	}

	.branch-row {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
	}

	.branch-key {
		display: inline-flex;
		align-items: center;
		height: 17px;
		padding: 0 5px;
		border: 1px solid var(--df-border-control);
		border-radius: 3px;
		font-family: var(--df-p-font-mono);
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.branch-key.true {
		color: var(--df-state-ok-ink);
		border-color: color-mix(in srgb, var(--df-state-ok-ink) 36%, var(--df-border-hairline));
	}

	.branch-key.false {
		color: var(--df-text-meta);
	}

	.branch-arrow {
		color: var(--df-text-meta);
	}

	.branch-target {
		font-size: 11.5px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.branch-missing {
		font-size: 11.5px;
		color: var(--df-state-danger-ink);
	}

	.node-issues {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin: 0;
		padding: 8px;
		border: 1px solid color-mix(in srgb, var(--df-state-danger-ink) 28%, var(--df-border-hairline));
		border-radius: var(--df-p-radius-sm);
		background: color-mix(in srgb, var(--df-state-danger-ink) 5%, var(--df-surface-card));
		list-style: none;
	}

	.node-issues li {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		font-size: 11px;
		line-height: 1.45;
		color: var(--df-state-danger-ink);
	}

	.node-issues :global(svg) {
		margin-top: 1px;
		flex: none;
	}

	.inspector-foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-4);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: 0 0 var(--df-p-radius-lg) var(--df-p-radius-lg);
	}

	.node-id {
		min-width: 0;
		font-size: 9.5px;
		color: var(--df-text-meta);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.hint.ok {
		color: var(--df-state-ok-ink);
	}

	.hint.invalid {
		color: var(--df-state-danger-ink);
	}

	input.input-mono {
		font-size: 11.5px;
	}

	textarea.input {
		min-height: 92px;
		font-size: 11.5px;
	}
</style>
