<!--
	The assistant workbench.

	Every state the real `Assistant.svelte` / `AssistantProposalCard.svelte` can
	reach, grouped in the operator's words, driven via `?__state=` with the real
	launcher, field, and card buttons mounted in the console shell.
-->
<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy } from 'svelte';
	import { registerWorkflowPatchSink } from '$lib/assistant';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import {
		GROUPS,
		STATE_TABLE,
		type SinkVerdict,
		type StateConfig,
		type StateKey
	} from './fixtures';
	import { setMock } from './stub';

	let { data }: { data: { state: StateKey } } = $props();

	const SWITCHER_GROUPS: ReadonlyArray<StateGroup> = GROUPS.map((group) => ({
		heading: group.label,
		states: group.keys.map((key) => ({
			key,
			label: key,
			title: STATE_TABLE[key].note
		}))
	}));

	const current = $derived(data.state);
	let running = $state(true);
	let lastError = $state<string | null>(null);

	let releaseSink: (() => void) | null = null;
	let runToken = 0;

	class CancelledError extends Error {
		constructor() {
			super('cancelled');
		}
	}

	const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

	async function waitFor(
		check: () => boolean,
		what: string,
		token: number,
		timeoutMs = 12_000
	): Promise<void> {
		const started = Date.now();
		for (;;) {
			if (token !== runToken) throw new CancelledError();
			if (check()) return;
			if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
			await sleep(40);
		}
	}

	function panel(): HTMLElement | null {
		return document.querySelector<HTMLElement>('section.panel');
	}

	function launcher(): HTMLButtonElement | null {
		return document.querySelector<HTMLButtonElement>('button.launcher');
	}

	function sendButton(): HTMLButtonElement | null {
		return panel()?.querySelector<HTMLButtonElement>('form.ask button[type="submit"]') ?? null;
	}

	async function closePanel(token: number): Promise<void> {
		const button = launcher();
		if (button === null) return;
		if (button.getAttribute('aria-expanded') === 'true') {
			button.click();
			await waitFor(() => panel() === null, 'the panel to close', token);
		}
	}

	async function openPanel(token: number): Promise<void> {
		const button = launcher();
		if (button === null) throw new Error('the launcher is not mounted');
		if (button.getAttribute('aria-expanded') !== 'true') button.click();
		await waitFor(() => panel() !== null, 'the panel to open', token);
	}

	/**
	 * Put the open panel into the presentation the state asks for.
	 *
	 * The choice is remembered per tab, so a state that follows an expanded one
	 * inherits it: every state therefore states which presentation it wants, and the
	 * driver sets it rather than assuming the panel opened the way it did last time.
	 */
	async function setPresentation(fullscreen: boolean, token: number): Promise<void> {
		await waitFor(
			() => panel()?.querySelector('button.presentation') !== null,
			'the presentation control',
			token
		);
		const control = panel()?.querySelector<HTMLButtonElement>('button.presentation');
		if (control === null || control === undefined) {
			throw new Error('the presentation control is missing');
		}
		const expanded = (control.getAttribute('aria-label') ?? '').startsWith('Collapse');
		if (expanded !== fullscreen) control.click();
		await waitFor(
			() => panel()?.getAttribute('data-presentation') === (fullscreen ? 'fullscreen' : 'floating'),
			fullscreen ? 'the panel to expand' : 'the panel to float again',
			token
		);
	}

	async function typeQuestion(question: string, token: number): Promise<void> {
		await waitFor(() => {
			const input = panel()?.querySelector<HTMLInputElement>('input.ask-input');
			return input !== null && input !== undefined && !input.disabled;
		}, 'the question field', token);
		const input = panel()?.querySelector<HTMLInputElement>('input.ask-input');
		if (!input) throw new Error('the question field is missing');
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
		setter?.call(input, question);
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await sleep(30);
		if (token !== runToken) throw new CancelledError();
	}

	async function submitQuestion(token: number): Promise<void> {
		await waitFor(() => {
			const button = sendButton();
			return button !== null && !button.disabled;
		}, 'Ask to become ready', token);
		sendButton()?.click();
	}

	/** A button inside the panel, by the start of its visible text. */
	function panelButton(label: string): HTMLButtonElement | null {
		const buttons = Array.from(panel()?.querySelectorAll<HTMLButtonElement>('button') ?? []);
		return buttons.find((button) => (button.textContent ?? '').trim().startsWith(label)) ?? null;
	}

	async function clickPanelButton(label: string, token: number): Promise<void> {
		await waitFor(() => panelButton(label) !== null, `the ${label} button`, token);
		panelButton(label)?.click();
		await sleep(40);
		if (token !== runToken) throw new CancelledError();
	}

	/**
	 * Choose a file through the panel's real control.
	 *
	 * `DataTransfer` is how a browser hands files to an input it did not open a
	 * picker for; the component's own change handler then runs unchanged.
	 */
	async function attachFile(
		file: { name: string; bytes: number; type?: string },
		token: number
	): Promise<void> {
		await waitFor(() => {
			const input = panel()?.querySelector<HTMLInputElement>('input[type="file"]');
			return input !== null && input !== undefined && !input.disabled;
		}, 'the file control', token);
		const input = panel()?.querySelector<HTMLInputElement>('input[type="file"]');
		if (!input) throw new Error('the file control is missing');

		const chosen = new File([new Uint8Array(file.bytes)], file.name, {
			type: file.type ?? 'application/octet-stream'
		});
		const transfer = new DataTransfer();
		transfer.items.add(chosen);
		input.files = transfer.files;
		input.dispatchEvent(new Event('change', { bubbles: true }));
		await sleep(60);
		if (token !== runToken) throw new CancelledError();
	}

	function matches(config: StateConfig): boolean {
		if (document.querySelector(config.expect) === null) return false;
		if (config.expectGone !== undefined && document.querySelector(config.expectGone) !== null) {
			return false;
		}
		if (config.expectCount !== undefined) {
			const found = document.querySelectorAll(config.expectCount.selector).length;
			if (found !== config.expectCount.count) return false;
		}
		if (config.open && config.question !== undefined) {
			const typed = panel()?.querySelector<HTMLInputElement>('input.ask-input')?.value;
			if (typed !== config.question) return false;
		}
		const body = document.body.textContent ?? '';
		const wanted = Array.isArray(config.expectText) ? config.expectText : [config.expectText];
		return wanted.every((needle) => body.includes(needle));
	}

	/** The editor's own handover, faked at the seam the editor really registers. */
	function sinkFor(verdict: SinkVerdict) {
		return () => {
			if (verdict === 'throw') {
				throw new Error('The editor is still loading the flow. Try again in a moment.');
			}
			if (verdict === 'fail') {
				return { ok: false, message: 'The patch leaves the flow with two triggers.' };
			}
			return {
				ok: true,
				message:
					'Staged for review: Add a reply step to the bKash receipt flow. The operator must accept it; nothing is applied or saved.'
			};
		};
	}

	async function apply(key: StateKey): Promise<void> {
		const token = ++runToken;
		const config = STATE_TABLE[key];
		running = true;
		lastError = null;

		releaseSink?.();
		releaseSink = null;

		try {
			// The panel lives in the console shell, which mounts after its own
			// session read; wait for that shell rather than guessing.
			await waitFor(() => launcher() !== null, 'the console shell', token);
			await closePanel(token);
			if (token !== runToken) return;

			setMock({
				chat: config.chat,
				accept: config.accept,
				runtime: config.runtime,
				ticket: config.ticket,
				ticketAfter: config.ticketAfter,
				socket: config.socket,
				sse: config.sse,
				conversation: config.conversation,
				clear: config.clear,
				attachments: config.attachments,
				upload: config.upload,
				remove: config.remove,
				say: config.say,
				sayAfter: config.sayAfter
			});
			if (config.sink !== undefined) {
				releaseSink = registerWorkflowPatchSink(sinkFor(config.sink));
			}

			if (config.open) {
				await openPanel(token);
				await setPresentation(config.presentation === 'fullscreen', token);
				if (config.file !== undefined) await attachFile(config.file, token);
				if (config.question !== undefined) await typeQuestion(config.question, token);
				if (config.submit === true) await submitQuestion(token);
				if (config.clearThen === true) {
					await clickPanelButton('Clear', token);
					await clickPanelButton('Delete transcript', token);
				}
				if (config.click !== undefined) await clickPanelButton(config.click, token);
				if (config.clickSelector !== undefined) {
					const selector = config.clickSelector;
					if (config.clickWhen !== undefined) {
						await waitFor(
							() => panel()?.querySelector(config.clickWhen ?? '') !== null,
							`the state ${config.clickWhen} names`,
							token
						);
					}
					await waitFor(
						() => panel()?.querySelector(selector) !== null,
						`${selector} to appear`,
						token
					);
					panel()?.querySelector<HTMLElement>(selector)?.click();
					await sleep(60);
					if (token !== runToken) throw new CancelledError();
				}
			}

			await waitFor(() => matches(config), `state ${key}`, token);
			if (token !== runToken) return;

			// `Assistant.svelte` focuses `input.ask-input` on open; blur it after
			// setup so Arrow keys and `H` continue to drive the workbench switcher.
			const active = document.activeElement;
			const askInput = panel()?.querySelector<HTMLInputElement>('input.ask-input');
			if (askInput && active === askInput) {
				askInput.blur();
			}
		} catch (error) {
			if (error instanceof CancelledError || token !== runToken) return;
			lastError = error instanceof Error ? error.message : String(error);
		} finally {
			if (token === runToken) running = false;
		}
	}

	$effect(() => {
		const key = current;
		void apply(key);
		return () => {
			runToken += 1;
		};
	});

	function selectState(next: string): void {
		if (!Object.prototype.hasOwnProperty.call(STATE_TABLE, next)) return;
		const key = next as StateKey;
		if (key === current) {
			void apply(key);
			return;
		}
		const url = new URL(page.url.href);
		url.searchParams.set('__state', key);
		void goto(`${url.pathname}?${url.searchParams.toString()}`, {
			reset: false
		});
	}

	onDestroy(() => {
		runToken += 1;
		releaseSink?.();
		releaseSink = null;
	});
</script>

<svelte:head>
	<title>Assistant states · DakFlare workbench</title>
</svelte:head>

<StateSwitcher groups={SWITCHER_GROUPS} {current} onchange={selectState}>
	<section class="assistant-stage card" aria-label="Assistant state readout" data-state={current} data-ready={!running}>
		<header class="stage-head">
			<h1 class="stage-title">Assistant · {current}</h1>
			<p class="stage-status" data-tone={lastError !== null ? 'err' : running ? 'run' : 'ok'} role="status">
				{#if lastError !== null}
					failed: {lastError}
				{:else if running}
					setting up {current}…
				{:else}
					showing {current}
				{/if}
			</p>
		</header>

		<p class="stage-note">{STATE_TABLE[current].note}</p>
		<p class="stage-wire"><code>{STATE_TABLE[current].wire}</code></p>
		<p class="stage-foot">
			The real launcher and panel render in the console shell. Choose a full-screen state to see
			the same panel expanded: at 390 it fills the viewport, at 1280 it is a sheet with the page
			still live around it. Outbound socket frames are recorded on
			<code>window.__assistantWorkbenchSent</code>.
		</p>
	</section>
</StateSwitcher>

<style>
	.assistant-stage {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.stage-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px 12px;
	}

	.stage-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}

	.stage-status {
		margin: 0;
		font-size: 0.8125rem;
		font-weight: 500;
	}

	.stage-status[data-tone='err'] {
		color: var(--df-c-tone-danger-fg, #b42318);
	}

	.stage-note,
	.stage-wire,
	.stage-foot {
		margin: 0;
	}

	.stage-foot {
		font-size: 0.8125rem;
		opacity: 0.8;
	}
</style>
