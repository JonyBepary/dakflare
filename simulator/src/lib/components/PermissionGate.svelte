<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { app } from '$lib/stores/app.svelte';

	/**
	 * The five checks a gateway needs, in the order a new phone meets them.
	 * `send_sms` and `receive_sms` share one Android dialog, so one tap there
	 * can grant both rows.
	 */
	const CHECKS = [
		{
			key: 'battery_exempt',
			title: 'Keep the phone awake',
			why: 'Android pauses the app between messages. This is what makes a reply go out in seconds instead of minutes.',
			action: 'Allow battery exemption',
			command: 'request_battery_exemption'
		},
		{
			key: 'sms_role',
			title: 'Become the default messaging app',
			why: 'A gateway can only answer a text if it is the app Android delivers texts to.',
			action: 'Choose DakFlare',
			command: 'request_default_sms_role'
		},
		{
			key: 'send_sms',
			title: 'Send text messages',
			why: 'Without this the gateway can read a message but cannot reply.',
			action: 'Allow sending',
			command: 'request_sms_permissions'
		},
		{
			key: 'receive_sms',
			title: 'Receive text messages',
			why: 'Without this no message ever reaches the gateway.',
			action: 'Allow receiving',
			command: 'request_sms_permissions'
		},
		{
			key: 'notifications',
			title: 'Show the gateway status',
			why: 'The notification is the only place the phone says whether the live connection is up.',
			action: 'Allow notifications',
			command: 'request_notifications'
		}
	] as const;

	type Check = (typeof CHECKS)[number];
	type CheckKey = Check['key'];
	/** Every key is `false` when missing; Android, not this panel, is the judge. */
	type PermissionState = Record<CheckKey, boolean>;

	let supported = $state(false);
	let missing = $state<Check[]>([]);
	let readFailed = $state(false);
	let dismissed = $state(false);
	let busy = $state<CheckKey | null>(null);
	let failure = $state<{ key: CheckKey; text: string } | null>(null);
	let panel = $state<HTMLElement | null>(null);

	/** The read in flight, so focus and visibility cannot ask twice at once. */
	let inFlight: Promise<void> | null = null;

	const shown = $derived(supported && !dismissed && missing.length > 0);

	function pause(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	/** A plugin refusal already reads as a sentence; only the stop may be missing. */
	function sentence(error: unknown): string {
		const text = String(error).trim();
		if (!text) return 'Android did not open that setting.';
		return /[.!?]$/.test(text) ? text : `${text}.`;
	}

	async function readState(again = false) {
		if (!supported) return;
		if (inFlight) {
			if (!again) return inFlight;
			// A tap has already waited out the system dialog, so its answer must be
			// newer than the resume read that may still be running.
			await inFlight;
		}
		inFlight = (async () => {
			try {
				const state = await invoke<PermissionState>('permission_state');
				missing = CHECKS.filter((check) => state[check.key] !== true);
				readFailed = false;
				if (missing.length === 0) failure = null;
			} catch {
				// A read that failed is not evidence that a permission is missing, so
				// the last answer stays and gets an honest note instead of new rows.
				readFailed = true;
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	}

	async function ask(check: Check) {
		if (busy) return;
		busy = check.key;
		failure = null;
		try {
			await invoke(check.command);
			// The system dialog closes before Android records the answer, so read
			// again after it has settled. The next resume reads once more, for a
			// setting that handed off to the Settings app.
			await pause(800);
			await readState(true);
		} catch (error) {
			failure = { key: check.key, text: sentence(error) };
		} finally {
			busy = null;
		}
	}

	function dismiss() {
		if (!shown) return;
		dismissed = true;
		failure = null;
	}

	onMount(() => {
		// A plain browser has no Tauri IPC: no panel, no error.
		if (!('__TAURI_INTERNALS__' in window)) return;
		supported = true;

		// A resumed phone is a fresh answer. The panel comes back so a grant made
		// in system Settings is seen, and a dismissal never outlives the pause.
		const resume = () => {
			if (document.visibilityState !== 'visible') return;
			dismissed = false;
			void readState();
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape') dismiss();
		};

		window.addEventListener('focus', resume);
		document.addEventListener('visibilitychange', resume);
		window.addEventListener('keydown', escape);
		return () => {
			window.removeEventListener('focus', resume);
			document.removeEventListener('visibilitychange', resume);
			window.removeEventListener('keydown', escape);
		};
	});

	// The shell starts boot in the same mount pass. Wait for its flag rather than
	// calling app.boot() again, which returns early and would read too soon.
	$effect(() => {
		if (!supported || app.loading.boot) return;
		void readState();
	});

	// Move the keyboard into the panel when it opens, without stealing focus on
	// every re-read: `shown` only changes when the panel changes visibility.
	$effect(() => {
		if (shown) panel?.focus();
	});
</script>

{#if shown}
	<div class="gate">
		<div
			class="gate-panel"
			role="dialog"
			aria-labelledby="gate-title"
			aria-describedby="gate-summary"
			tabindex="-1"
			bind:this={panel}
		>
			<header class="gate-head">
				<span class="gate-rule" aria-hidden="true"></span>
				<div class="gate-kicker">
					<p class="eyebrow">Permissions</p>
					<p class="gate-count">{missing.length} left</p>
				</div>
				<h2 id="gate-title">Finish setting up this gateway</h2>
				<p class="gate-summary" id="gate-summary">
					The app keeps running, but it cannot do its job until these are allowed.
				</p>
			</header>

			<ul class="gate-list">
				{#each missing as check, index (check.key)}
					<li class="gate-row">
						<div class="gate-row-head">
							<h3>{check.title}</h3>
							<span class="gate-index" aria-hidden="true">
								{String(index + 1).padStart(2, '0')}
							</span>
						</div>
						<p class="gate-why" id={`gate-why-${check.key}`}>{check.why}</p>
						<button
							class="btn wide"
							class:primary={index === 0}
							type="button"
							onclick={() => ask(check)}
							disabled={busy !== null}
							aria-describedby={`gate-why-${check.key}`}
						>
							{busy === check.key ? 'Opening…' : check.action}
						</button>
						{#if failure?.key === check.key}
							<p class="notice gate-failure" data-tone="error" role="alert">{failure.text}</p>
						{/if}
					</li>
				{/each}
			</ul>

			<footer class="gate-foot">
				{#if readFailed}
					<p class="gate-note" data-tone="error">
						Android did not answer the permission check just now. The list above is from its
						last answer.
					</p>
				{/if}
				<p class="gate-note">
					The gateway keeps running either way. This panel returns when you come back to the
					app.
				</p>
				<button class="btn quiet wide" type="button" onclick={dismiss}>Not now</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.gate {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: flex;
		align-items: flex-end;
		justify-content: center;
		background: var(--df-c-dialog-scrim);
		animation: gate-fade var(--df-p-dur-settle) var(--df-p-ease-standard) both;
	}

	.gate-panel {
		display: flex;
		flex-direction: column;
		width: min(100%, 640px);
		/* Both spellings: an older WebView ignores dvh but keeps the vh cap. */
		max-height: calc(100vh - 24px);
		max-height: calc(100dvh - 24px);
		background: var(--df-c-dialog-bg);
		color: var(--df-c-dialog-ink);
		border: 1px solid var(--df-c-dialog-border);
		border-bottom: 0;
		border-radius: var(--df-p-radius-lg) var(--df-p-radius-lg) 0 0;
		box-shadow: var(--df-c-dialog-shadow);
		animation: gate-rise var(--df-p-dur-settle) var(--df-p-ease-standard) both;
	}

	/* The panel takes focus on open so a screen reader starts here. The ring
	   belongs on the buttons inside, not around the whole sheet. */
	.gate-panel:focus {
		outline: none;
	}

	.gate-head {
		flex: none;
		padding: 14px 18px 13px;
		border-bottom: 1px solid var(--df-border-hairline);
	}

	/* The dock's active mark, carried onto the sheet: coral, 3px, centred. */
	.gate-rule {
		display: block;
		width: 32px;
		height: 3px;
		margin: 0 auto 11px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-accent-decor);
	}

	.gate-kicker {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
	}

	.gate-count {
		flex: none;
		font-family: var(--mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-3);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.gate-head h2 {
		margin-top: 2px;
		font-family: var(--display);
		font-size: 20px;
		line-height: 1.25;
		font-weight: 800;
		letter-spacing: -0.015em;
		color: var(--ink);
		text-wrap: pretty;
	}

	.gate-summary {
		margin-top: 5px;
		max-width: 46ch;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--ink-2);
	}

	.gate-list {
		flex: 1 1 auto;
		min-height: 0;
		list-style: none;
		margin: 0;
		padding: 0 18px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scrollbar-width: thin;
	}

	.gate-row {
		padding: 14px 0 16px;
		border-bottom: 1px solid var(--df-border-hairline);
	}

	.gate-row:last-child {
		border-bottom: 0;
	}

	.gate-row-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 10px;
	}

	.gate-row h3 {
		margin: 0;
		font-family: var(--display);
		font-size: 15px;
		line-height: 1.3;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	.gate-index {
		flex: none;
		font-family: var(--mono);
		font-size: 10px;
		letter-spacing: 0.06em;
		color: var(--ink-3);
		font-variant-numeric: tabular-nums;
	}

	.gate-why {
		margin-top: 3px;
		max-width: 48ch;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--ink-2);
		text-wrap: pretty;
	}

	.gate-row .btn {
		margin-top: 10px;
	}

	.gate-failure {
		margin-top: 8px;
	}

	.gate-foot {
		flex: none;
		padding: 12px 18px 16px;
		border-top: 1px solid var(--df-c-dialog-foot-border);
		background: var(--df-c-dialog-foot-bg);
	}

	.gate-note {
		font-size: 11px;
		line-height: 1.45;
		color: var(--ink-3);
		text-wrap: pretty;
	}

	.gate-note + .gate-note {
		margin-top: 6px;
	}

	.gate-note[data-tone='error'] {
		color: var(--df-state-danger-ink);
	}

	.gate-foot .btn {
		margin-top: 8px;
	}

	@keyframes gate-fade {
		from {
			opacity: 0;
		}
	}

	@keyframes gate-rise {
		from {
			transform: translateY(16px);
		}
	}
</style>
