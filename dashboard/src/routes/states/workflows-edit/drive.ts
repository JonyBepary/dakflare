import { handPatchToEditor, workflowPatchSinkReady } from '$lib/assistant';
import { tick } from 'svelte';
import type { WorkflowEditScenario } from './fixtures';

async function waitFor<T>(
	fn: () => T | null,
	signal: AbortSignal,
	timeoutMs = 6_000
): Promise<T | null> {
	const deadline = performance.now() + timeoutMs;
	while (!signal.aborted && performance.now() < deadline) {
		const hit = fn();
		if (hit) return hit;
		await new Promise<void>((r) => requestAnimationFrame(() => r()));
	}
	return null;
}

function setField(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

function findButton(root: ParentNode, text: string): HTMLButtonElement | null {
	return (
		Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
			(btn) => btn.textContent?.trim().includes(text) ?? false
		) ?? null
	);
}

export async function driveWorkflowEditState(
	stageEl: HTMLElement,
	scenario: WorkflowEditScenario,
	signal: AbortSignal
): Promise<void> {
	const state = scenario.key;
	if (
		state === 'loading' ||
		state === 'not-found' ||
		state === 'load-error' ||
		state === 'new-draft' ||
		state === 'empty-steps' ||
		state === 'steps-populated'
	) {
		return;
	}

	await tick();

	// Wait for initial load to finish
	const ready = await waitFor(() => {
		if (stageEl.querySelector('.loading-grid')) return null;
		return stageEl.querySelector('.work-panel') ?? stageEl.querySelector('.panel');
	}, signal);
	if (!ready || signal.aborted) return;

	if (state === 'steps-inspector') {
		const smsRow = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('[data-step-id="n_sms"]'),
			signal
		);
		smsRow?.click();
		return;
	}

	if (state === 'steps-extract-sample') {
		const extractRow = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('[data-step-id="n_extract"]'),
			signal
		);
		if (!extractRow || signal.aborted) return;
		extractRow.click();
		const wbBtn = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('.btn-workbench-toggle'),
			signal
		);
		wbBtn?.click();
		return;
	}

	if (state === 'map-populated' || state === 'map-inspector' || state === 'map-unsupported') {
		const targetNodeId = state === 'map-unsupported' ? 'n_ai_step' : 'n_cond';
		const nodeEl = await waitFor(
			() =>
				stageEl.querySelector<HTMLElement>(
					state === 'map-populated'
						? '.svelte-flow__node'
						: `.svelte-flow__node[data-id="${targetNodeId}"]`
				),
			signal
		);
		if (!nodeEl || signal.aborted || state === 'map-populated') return;
		nodeEl.click();
		return;
	}

	if (state === 'checks-clean' || state === 'checks-issues') {
		const checksBtn = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('button.checks-button'),
			signal
		);
		checksBtn?.click();
		return;
	}

	if (state === 'preview-idle' || state === 'preview-delivered' || state === 'preview-filtered') {
		await waitFor(() => stageEl.querySelector('.svelte-flow__node'), signal);
		if (signal.aborted) return;
		const previewBtn = stageEl.querySelector<HTMLButtonElement>(
			'button[title*="Preview the flow"]'
		);
		if (!previewBtn) return;
		previewBtn.click();
		if (state === 'preview-idle') return;

		const simForm = await waitFor(
			() => stageEl.querySelector<HTMLFormElement>('form.sim-form'),
			signal
		);
		if (!simForm || signal.aborted) return;
		const senderEl = simForm.querySelector<HTMLInputElement>('#sim-sender');
		const bodyEl = simForm.querySelector<HTMLTextAreaElement>('#sim-body');
		if (!senderEl || !bodyEl) return;

		if (state === 'preview-delivered') {
			setField(senderEl, 'bKash');
			setField(bodyEl, 'You have received Tk 800.00 from 01712345678. TrxID 8G56H7J8K9');
		} else {
			setField(senderEl, 'Nagad');
			setField(bodyEl, 'Weekend cashback promo: 10% back tonight');
		}
		await tick();
		simForm.requestSubmit();
		return;
	}

	if (state === 'settings-open') {
		const btn = stageEl.querySelector<HTMLButtonElement>('button[aria-label="Flow settings"]');
		btn?.click();
		return;
	}

	if (state === 'add-palette') {
		const btn = stageEl.querySelector<HTMLButtonElement>('.add-anchor > button');
		btn?.click();
		return;
	}

	if (state === 'source-readonly' || state === 'source-error') {
		const moreBtn = stageEl.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
		if (!moreBtn) return;
		moreBtn.click();
		const sourceItem = await waitFor(
			() => findButton(stageEl, 'Source'),
			signal
		);
		if (!sourceItem || signal.aborted) return;
		sourceItem.click();
		if (state === 'source-readonly') return;

		const editToggle = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('.source-sheet input[type="checkbox"]'),
			signal
		);
		if (!editToggle || signal.aborted) return;
		editToggle.checked = true;
		editToggle.dispatchEvent(new Event('change', { bubbles: true }));

		const area = await waitFor(
			() => stageEl.querySelector<HTMLTextAreaElement>('textarea.code-textarea:not([readonly])'),
			signal
		);
		if (!area || signal.aborted) return;
		area.value = '{\n  "nodes": [\n    { "id": "broken" \n}';
		area.dispatchEvent(new Event('input', { bubbles: true }));
		await tick();
		const applyBtn = findButton(stageEl.querySelector('.source-sheet') ?? stageEl, 'Apply');
		applyBtn?.click();
		return;
	}

	if (
		state === 'finder-steps' ||
		state === 'finder-agent' ||
		state === 'finder-agent-unavailable' ||
		state === 'ghost-judged-approval' ||
		state === 'ghost-missing-token'
	) {
		if (state === 'finder-steps') {
			const findBtn = stageEl.querySelector<HTMLButtonElement>('button.find-button');
			findBtn?.click();
			return;
		}
		const moreBtn = stageEl.querySelector<HTMLButtonElement>('button[aria-label="More actions"]');
		if (!moreBtn) return;
		moreBtn.click();
		const askItem = await waitFor(() => findButton(stageEl, 'Ask the agent'), signal);
		if (!askItem || signal.aborted) return;
		askItem.click();

		const finderInput = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('input.finder-input'),
			signal
		);
		if (!finderInput || signal.aborted) return;
		setField(finderInput, '> add a delay after 2');
		await tick();
		finderInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

		if (state === 'finder-agent' || state === 'finder-agent-unavailable') return;

		const stageBtn = await waitFor(
			() => findButton(stageEl, 'Stage for review'),
			signal
		);
		if (!stageBtn || signal.aborted) return;
		stageBtn.click();
		return;
	}

	if (
		state === 'ghost-unjudged' ||
		state === 'ghost-blocking-problems' ||
		state === 'member-ghost'
	) {
		const sinkReady = await waitFor(
			() => (workflowPatchSinkReady() ? true : null),
			signal
		);
		if (!sinkReady || signal.aborted || !scenario.externalPatch) return;
		handPatchToEditor(scenario.externalPatch);
		return;
	}

	if (
		state === 'dirty-unsaved' ||
		state === 'saving' ||
		state === 'save-error' ||
		state === 'server-rejected' ||
		state === 'leave-confirm'
	) {
		const nameInput = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('#wf-inline-name'),
			signal
		);
		if (!nameInput || signal.aborted) return;
		setField(nameInput, 'bKash Payment Confirmation · Revised');
		await tick();
		if (state === 'dirty-unsaved') return;

		if (state === 'leave-confirm') {
			const backLink = stageEl.querySelector<HTMLAnchorElement>('a[aria-label="Back to workflows"]');
			backLink?.click();
			return;
		}

		const saveBtn = findButton(stageEl, 'Save');
		saveBtn?.click();
	}
}
