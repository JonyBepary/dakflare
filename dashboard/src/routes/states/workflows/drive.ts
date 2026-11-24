import { tick } from 'svelte';
import type { WorkflowsStateKey } from './fixtures';

async function waitFor<T>(
	fn: () => T | null,
	signal: AbortSignal,
	timeoutMs = 5_000
): Promise<T | null> {
	const deadline = performance.now() + timeoutMs;
	while (!signal.aborted && performance.now() < deadline) {
		const hit = fn();
		if (hit) return hit;
		await new Promise<void>((r) => requestAnimationFrame(() => r()));
	}
	return null;
}

export async function driveWorkflowsState(
	stageEl: HTMLElement,
	state: WorkflowsStateKey,
	signal: AbortSignal
): Promise<void> {
	if (state === 'loading' || state === 'empty' || state === 'one-flow' || state === 'populated' || state === 'load-error') {
		return;
	}
	await tick();

	if (state === 'refreshing') {
		const list = await waitFor(() => stageEl.querySelector('ul.flow-list'), signal);
		if (!list || signal.aborted) return;
		const refreshBtn = stageEl.querySelector<HTMLButtonElement>('.page-actions button, header button');
		const buttons = Array.from(stageEl.querySelectorAll<HTMLButtonElement>('button'));
		const target = refreshBtn ?? buttons.find((btn) => btn.textContent?.includes('Refresh')) ?? null;
		target?.click();
		return;
	}

	// Deletion states
	const deleteBtn = await waitFor(
		() => stageEl.querySelector<HTMLButtonElement>('.flow-actions button.btn-danger-ghost'),
		signal
	);
	if (!deleteBtn || signal.aborted) return;
	deleteBtn.click();

	if (state === 'delete-confirm') return;

	const confirmBtn = await waitFor(() => {
		const dialog = stageEl.querySelector<HTMLDialogElement>('dialog.dialog[open]');
		if (!dialog) return null;
		return dialog.querySelector<HTMLButtonElement>('.dialog-foot button.btn-danger-solid');
	}, signal);
	if (!confirmBtn || signal.aborted) return;
	confirmBtn.click();
}
