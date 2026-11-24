import { tick } from 'svelte';
import type { DeviceDetailStateKey } from './fixtures';

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

function setField(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Puts a row at the top of the drawer's scrollport once it has grown, so the
 * state opens on the thing it exists to show. scrollIntoView centres against
 * the window as well, which leaves tall rows half out of the drawer.
 */
function revealRow(stageEl: HTMLElement, row: HTMLElement | null): void {
	const body = stageEl.querySelector<HTMLElement>('.drawer-body');
	if (!body || !row) return;
	const offset = row.getBoundingClientRect().top - body.getBoundingClientRect().top;
	body.scrollTop += offset - 16;
}

function findButton(root: ParentNode, text: string): HTMLButtonElement | null {
	return (
		Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
			(btn) => btn.textContent?.trim().includes(text) ?? false
		) ?? null
	);
}

export async function driveDeviceDetailState(
	stageEl: HTMLElement,
	state: DeviceDetailStateKey,
	signal: AbortSignal
): Promise<void> {
	await tick();

	if (state === 'unarchive-error') {
		const btn = await waitFor(() => findButton(stageEl, 'Unarchive'), signal);
		if (!btn || signal.aborted) return;
		btn.click();
		return;
	}

	if (state === 'outbound-tracker-live') {
		const cmdList = await waitFor(() => stageEl.querySelector('ul.cmd-list'), signal);
		if (!cmdList || signal.aborted) return;
		const trackBtns = cmdList.querySelectorAll<HTMLButtonElement>('button.cmd-track-btn');
		trackBtns[0]?.click();
		return;
	}

	if (state === 'outbound-tracker-failed-trace') {
		const cmdList = await waitFor(() => stageEl.querySelector('ul.cmd-list'), signal);
		if (!cmdList || signal.aborted) return;
		const trackBtns = Array.from(cmdList.querySelectorAll<HTMLButtonElement>('button.cmd-track-btn'));
		// Index 3 is cmd_failed_04 (FAILED)
		const target = trackBtns[3];
		if (!target) return;
		target.click();
		const traceBtn = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('.cmd-tracker button.trace-toggle'),
			signal
		);
		if (!traceBtn || signal.aborted) return;
		traceBtn.click();
		return;
	}

	if (state === 'messages-follow-in-slice') {
		const followLink = await waitFor(
			() => stageEl.querySelector<HTMLAnchorElement>('a.fate-link'),
			signal
		);
		if (!followLink || signal.aborted) return;
		followLink.click();
		return;
	}

	if (state === 'outbound-expanded') {
		const toggle = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('.cmd-list button.expand-inline'),
			signal
		);
		if (!toggle || signal.aborted) return;
		toggle.click();
		await tick();
		revealRow(stageEl, toggle.closest<HTMLElement>('.cmd-row'));
		return;
	}

	if (state === 'messages-expanded') {
		const toggle = await waitFor(
			() => stageEl.querySelector<HTMLButtonElement>('.dlog button.expand-inline'),
			signal
		);
		if (!toggle || signal.aborted) return;
		toggle.click();
		await tick();
		revealRow(stageEl, toggle.closest<HTMLElement>('.dlog-row'));
		return;
	}

	if (
		state === 'send-open' ||
		state === 'send-ucs2-bangla' ||
		state === 'send-queued' ||
		state === 'send-error'
	) {
		const sendBtn = await waitFor(() => findButton(stageEl, 'Send SMS'), signal);
		if (!sendBtn || signal.aborted) return;
		sendBtn.click();
		if (state === 'send-open') return;

		const form = await waitFor(
			() => stageEl.querySelector<HTMLFormElement>('.send-section form'),
			signal
		);
		if (!form || signal.aborted) return;
		const toInput = form.querySelector<HTMLInputElement>('input[placeholder="+15551234567"]');
		const bodyInput = form.querySelector<HTMLTextAreaElement>('textarea.body-field');
		if (!toInput || !bodyInput) return;

		if (state === 'send-ucs2-bangla') {
			setField(toInput, '+8801712345678');
			setField(bodyInput, 'আপনার পেমেন্ট নিশ্চিত হয়েছে। ধন্যবাদ।');
			return;
		}

		setField(toInput, '+8801712345678');
		setField(bodyInput, 'Order A-1042 dispatched via Steadfast.');
		await tick();
		form.requestSubmit();
		return;
	}

	if (state === 'archive-dialog' || state === 'archive-error') {
		const btn = await waitFor(() => findButton(stageEl, 'Archive'), signal);
		if (!btn || signal.aborted) return;
		btn.click();
		if (state === 'archive-dialog') return;
		const confirmBtn = await waitFor(() => {
			const dialog = stageEl.querySelector<HTMLDialogElement>('dialog.dialog[open]');
			return dialog ? findButton(dialog, 'Archive device') : null;
		}, signal);
		confirmBtn?.click();
		return;
	}

	if (state === 'revoke-dialog' || state === 'revoke-pending' || state === 'revoke-error') {
		const btn = await waitFor(() => findButton(stageEl, 'Revoke'), signal);
		if (!btn || signal.aborted) return;
		btn.click();
		if (state === 'revoke-dialog') return;
		const confirmBtn = await waitFor(() => {
			const dialog = stageEl.querySelector<HTMLDialogElement>('dialog.dialog[open]');
			return dialog ? findButton(dialog, 'Revoke device') : null;
		}, signal);
		confirmBtn?.click();
		return;
	}

	if (state === 'purge-dialog' || state === 'purge-error' || state === 'purged-notice') {
		const btn = await waitFor(() => findButton(stageEl, 'Purge log'), signal);
		if (!btn || signal.aborted) return;
		btn.click();
		if (state === 'purge-dialog') return;
		const confirmBtn = await waitFor(() => {
			const dialog = stageEl.querySelector<HTMLDialogElement>('dialog.dialog[open]');
			return dialog ? findButton(dialog, 'Delete messages') : null;
		}, signal);
		confirmBtn?.click();
	}
}
