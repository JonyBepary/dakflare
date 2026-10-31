<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ApiError, describeError, getMe, signOutAccount } from '$lib/api';
	import { addPasskey, listPasskeys, passkeySupport } from '$lib/passkey';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/*
	 * First sign-in, after an invite has been redeemed. The account has no other
	 * factor, so this page is not an offer: a passkey here is the only way back in
	 * later. The honest exception is a browser that cannot make one (below), which
	 * says so instead of offering a button that does nothing.
	 */
	type Phase = 'checking' | 'ready' | 'existing' | 'unsupported' | 'signed-out' | 'failed';

	let phase = $state<Phase>('checking');
	let support = $state<'yes' | 'insecure' | 'no'>('yes');
	let deviceName = $state('This browser');
	let nameInput = $state<HTMLInputElement | null>(null);
	let pending = $state(false);
	let error = $state<string | null>(null);
	let failure = $state<string | null>(null);

	const nextTarget = $derived.by(() => {
		const requested = page.url.searchParams.get('next');
		if (requested && requested.startsWith(`${BASE}/`) && requested !== ROUTES.enrol) {
			return requested;
		}
		return ROUTES.overview;
	});

	onMount(() => {
		void (async () => {
			try {
				const me = await getMe();
				session.applyMe(me);
			} catch (caught) {
				if (caught instanceof ApiError && (caught.status === 401 || caught.status === 403)) {
					await goto(`${ROUTES.login}?next=${encodeURIComponent(ROUTES.enrol)}`, {
						replaceState: true
					});
					return;
				}
				phase = 'failed';
				failure = describeError(caught);
				return;
			}

			support = passkeySupport();
			if (support !== 'yes') {
				phase = 'unsupported';
				return;
			}

			try {
				if ((await listPasskeys()).length > 0) {
					phase = 'existing';
					return;
				}
			} catch {
				// Not knowing is not a reason to skip enrolment.
			}

			phase = 'ready';
			await Promise.resolve();
			nameInput?.focus();
		})();
	});

	async function create() {
		if (pending) return;
		pending = true;
		error = null;
		try {
			await addPasskey(deviceName);
			await goto(nextTarget, { replaceState: true });
		} catch (caught) {
			if (caught instanceof ApiError) {
				error =
					caught.code === 'CHALLENGE_NOT_FOUND' || caught.status === 400
						? 'The passkey attempt expired before it finished. Try again.'
						: describeError(caught);
			} else {
				error = caught instanceof Error ? caught.message : 'The passkey was not created. Try again.';
			}
			await Promise.resolve();
			nameInput?.focus();
		} finally {
			pending = false;
		}
	}

	async function leave() {
		await signOutAccount();
		session.clear();
		await goto(ROUTES.login, { replaceState: true });
	}
</script>

<svelte:head>
	<title>Make a passkey · DakFlare</title>
</svelte:head>

<AuthGate>
	{#if phase === 'checking'}
		<p class="eyebrow">First sign-in</p>
		<h1>Setting up the account</h1>
		<p class="lede">Checking what this browser can do and whether a passkey already exists.</p>
		<div class="wait" aria-busy="true" aria-live="polite">
			<Spinner /> <span class="mono">checking the account</span>
		</div>
	{:else if phase === 'failed'}
		<p class="eyebrow">First sign-in</p>
		<h1>The account could not be read</h1>
		<p class="lede">No passkey was made. Check the session, then open the invite again.</p>
		<Notice tone="danger" title="No answer from the gateway">
			{failure ?? 'The session check failed.'}
		</Notice>
		<div class="row" style="margin-top: 16px">
			<a class="btn btn-primary" href={ROUTES.login}>Sign-in screen</a>
		</div>
	{:else if phase === 'existing'}
		<p class="eyebrow">First sign-in</p>
		<h1>This account already has a passkey</h1>
		<p class="lede">
			Nothing else is needed. Sign in with it on this device, or add another from the device that
			holds one.
		</p>
		<a class="btn btn-primary btn-wide gate-submit" href={nextTarget}>
			<Icon name="arrow-up-right" size={14} /> Continue to the console
		</a>
	{:else if phase === 'unsupported'}
		<p class="eyebrow">First sign-in</p>
		<h1>This browser cannot make a passkey</h1>
		<p class="lede">
			A passkey is the only way back into this account, and this browser cannot create one.
			{support === 'insecure'
				? 'Passkeys need a secure address: https, or localhost during setup.'
				: 'The account exists now, but nothing has been saved for it yet.'}
		</p>

		<Notice tone="warn" title="Read this before leaving">
			The session in this tab lasts 7 days. After that, this account cannot sign in from a
			browser without a passkey, and there is no password to reset.
		</Notice>

		<div class="unsupported-actions">
			<a class="btn btn-wide" href={nextTarget}>
				<Icon name="arrow-up-right" size={14} /> Continue in this tab
			</a>
			<button type="button" class="btn btn-ghost btn-wide" onclick={() => void leave()}>
				Sign out
			</button>
		</div>

		<p class="note">
			On a phone or a laptop with a screen lock, sign in from the invite again: the passkey is
			created there and works everywhere afterwards.
		</p>
	{:else}
		<p class="eyebrow">First sign-in</p>
		<h1>Make a passkey for this account</h1>
		<p class="lede">
			The account exists. A passkey is now the only way back in: it stays on this device and is
			unlocked the way the device is unlocked. There is no password.
		</p>

		{#if session.email}
			<p class="account-line">
				<span class="eyebrow">Account</span>
				<span class="mono">{session.email}</span>
			</p>
		{/if}

		<form onsubmit={(event) => { event.preventDefault(); void create(); }} novalidate>
			<div class="field">
				<label class="label" for="device-name">Device name <span class="optional">optional</span></label>
				<input
					bind:this={nameInput}
					bind:value={deviceName}
					id="device-name"
					class="input"
					autocomplete="off"
					spellcheck="false"
					maxlength="60"
					disabled={pending}
					aria-describedby="device-name-hint"
				/>
				<p id="device-name-hint" class="hint">
					A label for this device in the account's passkey list. "This browser" is fine.
				</p>
			</div>

			{#if error}
				<div class="gate-error"><Notice tone="danger">{error}</Notice></div>
			{/if}

			<button
				type="submit"
				class="btn btn-primary btn-wide gate-submit"
				disabled={pending}
				aria-busy={pending}
			>
				{#if pending}<Spinner />{:else}<Icon name="fingerprint" size={16} />{/if}
				{pending ? 'Waiting for the passkey' : 'Create a passkey'}
			</button>
		</form>

		<p class="note">
			The browser asks for the device unlock, then the key is stored here. Nothing is sent except
			the public half, which cannot sign in on its own.
		</p>
	{/if}
</AuthGate>

<style>
	.gate-error {
		margin-top: var(--s-3);
	}

	.gate-submit {
		height: 38px;
		margin-top: var(--s-4);
	}

	.wait {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ink-3);
		font-size: 11.5px;
		letter-spacing: 0.04em;
	}

	.account-line {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: var(--s-4);
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--df-surface-well);
		font-size: 12px;
		overflow-wrap: anywhere;
	}

	.unsupported-actions {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		margin-top: var(--s-4);
	}

	.note {
		margin-top: var(--s-5);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
		color: var(--ink-3);
		font-size: 11.5px;
		line-height: 1.55;
	}

	.label .optional {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--ink-3);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
</style>
