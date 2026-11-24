import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { tick } from 'svelte';
import type { AuditStateKey } from './fixtures';

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

function setInputValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function driveAuditState(
	stageEl: HTMLElement,
	state: AuditStateKey,
	signal: AbortSignal
): Promise<void> {
	if (state === 'loading' || state === 'member-no-access') return;
	await tick();

	if (state === 'loading-more' || state === 'pagination-stalled') {
		const loadMore = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('.audit-foot button'),
			signal
		);
		if (!loadMore || signal.aborted) return;
		loadMore.click();
		return;
	}

	if (state === 'detail-expanded') {
		const table = await waitFor(() => stageEl.querySelector<HTMLTableElement>('table.audit-table'), signal);
		if (!table || signal.aborted) return;
		const toggles = Array.from(table.querySelectorAll<HTMLButtonElement>('button.detail-toggle'));
		// Row 0 has structured JSON detail + UA; Row 1 (sign_in.failure) has detail: null + UA.
		if (toggles[0]) toggles[0].click();
		if (toggles[1]) toggles[1].click();
		return;
	}

	if (state === 'filtered-results' || state === 'filtered-empty') {
		const form = await waitFor(() => stageEl.querySelector<HTMLFormElement>('form.filters'), signal);
		if (!form || signal.aborted) return;
		await waitFor(
			() => (stageEl.querySelector('.loading-rows') ? null : form),
			signal
		);
		if (signal.aborted) return;

		const categoryEl = stageEl.querySelector<HTMLSelectElement>('#filter-category');
		const qEl = stageEl.querySelector<HTMLInputElement>('#filter-q');
		if (!categoryEl || !qEl) return;

		if (state === 'filtered-results') {
			categoryEl.value = 'security';
			qEl.value = 'grant';
			qEl.dispatchEvent(new Event('input', { bubbles: true }));
		} else {
			setInputValue(qEl, '198.51.100.99');
		}

		form.requestSubmit();

		// Protect against audit/+page.svelte's syncUrl() overwriting pathname to /admin/audit.
		await waitFor(
			() => (stageEl.querySelector('.loading-rows') ? null : stageEl.querySelector('.audit-foot, .empty')),
			signal
		);
		if (signal.aborted) return;
		const benchUrl = `${resolve('/states/audit')}?__state=${encodeURIComponent(state)}`;
		await goto(benchUrl, { replace: true, reset: false });
	}
}
