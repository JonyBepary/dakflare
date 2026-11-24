/**
 * The hands the workbench uses to reach a state the page only enters by being
 * used: typing in its own fields, pressing its own buttons.
 *
 * The component takes no props and exposes no state, so a state that follows an
 * operator's action is only reachable by making that action. Every selector
 * below is the page's own markup; nothing is inserted, restyled or branched.
 * Each step waits for the control it needs, because the page mounts only after
 * the shell's session check answers.
 */
import { tick } from 'svelte';
import type { Act } from './scenarios';

const FRAMES = 240;

async function settle(): Promise<void> {
	await tick();
	await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitFor<T>(find: () => T | null, signal?: AbortSignal): Promise<T | null> {
	for (let frame = 0; frame < FRAMES; frame += 1) {
		if (signal?.aborted) return null;
		const found = find();
		if (found !== null) return found;
		await settle();
	}
	return null;
}

/** Svelte's `bind:value` reads `input` for fields and `change` for selects. */
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	el.dispatchEvent(new Event('change', { bubbles: true }));
}

const field = (selector: string) => document.querySelector<HTMLInputElement>(selector);

/** A button the page offers, waited for until it is clickable. */
async function button(selector: string, signal?: AbortSignal): Promise<HTMLButtonElement | null> {
	return waitFor(() => {
		const el = document.querySelector<HTMLButtonElement>(selector);
		return el !== null && !el.disabled ? el : null;
	}, signal);
}

export async function drive(acts: Act[] | undefined, signal?: AbortSignal): Promise<void> {
	if (acts === undefined || acts.length === 0) return;

	for (const act of acts) {
		if (signal?.aborted) return;
		switch (act.do) {
			case 'provider': {
				const el = await waitFor(
					() => document.querySelector<HTMLSelectElement>('#ai-provider'),
					signal
				);
				if (signal?.aborted) return;
				if (el !== null) setValue(el, act.value);
				break;
			}
			case 'model': {
				const el = await waitFor(() => field('#ai-model'), signal);
				if (signal?.aborted) return;
				if (el !== null) setValue(el, act.value);
				break;
			}
			case 'base': {
				const el = await waitFor(() => field('#ai-base'), signal);
				if (signal?.aborted) return;
				if (el !== null) setValue(el, act.value);
				break;
			}
			case 's1model': {
				// A free-text input on an external gateway, and a three-alias select
				// on Workers AI: both are `#ai-s1-model`, and both bind the same way.
				const el = await waitFor(
					() =>
						document.querySelector<HTMLInputElement | HTMLSelectElement>('#ai-s1-model'),
					signal
				);
				if (signal?.aborted) return;
				if (el !== null && !el.disabled) setValue(el, act.value);
				break;
			}
			case 'inheritbase': {
				// The page's own checkbox; clicking is what an operator does, and it
				// runs the same handler a property write would skip.
				const el = await waitFor(
					() => document.querySelector<HTMLInputElement>('#ai-s1-inherit-base'),
					signal
				);
				if (signal?.aborted) return;
				if (el !== null && el.checked !== act.value) el.click();
				break;
			}
			case 's1base': {
				const el = await waitFor(() => field('#ai-s1-base'), signal);
				if (signal?.aborted) return;
				if (el !== null) setValue(el, act.value);
				break;
			}
			case 'save': {
				const el = await button('.ai-form .form-foot button[type="submit"]', signal);
				if (signal?.aborted) return;
				el?.click();
				break;
			}
			case 'test': {
				// The chat probe: the second button in the form foot.
				const el = await button('.ai-form .form-foot button[type="button"]', signal);
				if (signal?.aborted) return;
				el?.click();
				break;
			}
			case 's1test': {
				const el = await button('#ai-test-s1', signal);
				if (signal?.aborted) return;
				el?.click();
				break;
			}
			case 'models': {
				const el = await button('#ai-load-models', signal);
				if (signal?.aborted) return;
				el?.click();
				break;
			}
			case 'pick': {
				// The row is the page's own button; clicking it is what an operator
				// does. Waiting for it covers the load that has to resolve first.
				const el = await waitFor(
					() =>
						Array.from(document.querySelectorAll<HTMLButtonElement>('.model-option')).find(
							(option) => (option.querySelector('.model-id')?.textContent ?? '').trim() === act.value
						) ?? null,
					signal
				);
				if (signal?.aborted) return;
				el?.click();
				break;
			}
			case 'ack': {
				const el = await waitFor(
					() => document.querySelector<HTMLInputElement>('#autonomy-ack'),
					signal
				);
				if (signal?.aborted) return;
				if (el !== null && !el.disabled && !el.checked) el.click();
				break;
			}
			case 'cap': {
				const el = await waitFor(
					() => field(act.field === 'sms' ? '#autonomy-sms' : '#autonomy-writes'),
					signal
				);
				if (signal?.aborted) return;
				if (el !== null && !el.disabled) setValue(el, act.value);
				break;
			}
			case 'open-window': {
				const el = await button('.autonomy-form button[type="submit"]', signal);
				if (signal?.aborted) return;
				el?.click();
				break;
			}
			case 'revoke': {
				const el = await button('.autonomy-actions .btn-danger', signal);
				if (signal?.aborted) return;
				el?.click();
				break;
			}
		}
		await settle();
	}
}
