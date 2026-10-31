<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ApiError, describeError, getMe } from '$lib/api';
	import {
		MAGIC_LINK_MINUTES,
		MagicFailure,
		consumeMagicLink,
		readMagicAddress,
		readMagicToken
	} from '$lib/magic';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/*
	 * Where a sign-in link lands.
	 *
	 * The one rule this page exists for: opening it must not spend the token.
	 * Corporate mail scanners (Outlook SafeLinks, Gmail, Proton) prefetch every
	 * URL in a message, so a landing page that consumed on load would burn the
	 * credential before its owner ever clicked. Nothing here calls
	 * `consumeMagicLink` until the button is pressed — the token sits in a local
	 * variable and goes nowhere else.
	 *
	 * The token is not in a form field, not in storage, and never re-rendered
	 * into the DOM.
	 */

	type View =
		| 'ready'
		| 'pending'
		| 'done'
		| 'expired'
		| 'used'
		| 'unusable'
		| 'missing';

	let view = $state<View>('ready');
	let token = $state<string | null>(null);
	/** The address the link was minted for, when the link carries it. */
	let address = $state<string | null>(null);
	let error = $state<string | null>(null);
	let action = $state<HTMLButtonElement | null>(null);

	const nextTarget = $derived.by(() => {
		const requested = page.url.searchParams.get('next');
		if (
			requested &&
			requested.startsWith(`${BASE}/`) &&
			requested !== ROUTES.login &&
			requested !== ROUTES.invite &&
			requested !== ROUTES.enrol &&
			requested !== ROUTES.magic
		) {
			return requested;
		}
		return ROUTES.overview;
	});

	const newLink = `${ROUTES.login}?door=magic`;

	onMount(() => {
		token = readMagicToken(page.url.searchParams);
		address = readMagicAddress(page.url.searchParams);
		if (token === null) {
			view = 'missing';
			return;
		}
		// Still no request: this page only reads its own URL.
		void tick().then(() => action?.focus());
	});

	/** The one call that spends the token. Runs from the button, never on load. */
	async function signIn(): Promise<void> {
		if (view === 'pending' || token === null) return;
		view = 'pending';
		error = null;
		try {
			await consumeMagicLink(token);
			// Spent. Drop the reference so nothing can send it twice.
			token = null;
		} catch (failure) {
			view = 'ready';
			if (failure instanceof MagicFailure) {
				if (failure.kind === 'expired') view = 'expired';
				else if (failure.kind === 'used') view = 'used';
				else if (failure.kind === 'unusable') view = 'unusable';
				else error = failure.message;
			} else {
				error = describeError(failure);
			}
			await tick();
			if (view === 'ready') action?.focus();
			return;
		}
		await land();
	}

	/**
	 * The cookie is set. Who it belongs to decides the next screen: an account
	 * with an authenticator owes a code before the console opens, and the login
	 * page owns that step.
	 */
	async function land(): Promise<void> {
		view = 'done';
		try {
			const me = await getMe();
			session.applyMe(me);
			await hold();
			if (me.user.twoFactorEnabled) {
				await goto(`${ROUTES.login}?step=code&next=${encodeURIComponent(nextTarget)}`, {
					replaceState: true
				});
				return;
			}
			await goto(nextTarget, { replaceState: true });
		} catch (failure) {
			if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
				// The Worker withheld the session pending an authenticator code.
				await hold();
				await goto(`${ROUTES.login}?step=code&next=${encodeURIComponent(nextTarget)}`, {
					replaceState: true
				});
				return;
			}
			// The link worked, but the console could not confirm the session.
			error = describeError(failure);
		}
	}

	/**
	 * A short beat on the success screen. Without it the page would vanish
	 * between the click and the console, and a person would not know the link
	 * worked — which is the one thing this page has to say.
	 */
	function hold(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 700));
	}
</script>

<svelte:head>
	<title>Sign-in link · DakFlare</title>
</svelte:head>

<AuthGate>
	{#if view === 'missing'}
		<p class="eyebrow">Sign-in link</p>
		<h1>This link is incomplete</h1>
		<p class="lede">
			The address was opened without a token, so there is nothing to sign in with. Open the button
			in the email again, or ask for a new link.
		</p>
		<a class="btn btn-primary btn-wide gate-submit" href={newLink}>
			<Icon name="mail" size={15} /> Ask for a new link
		</a>
		<p class="note">
			Links are single use and last {MAGIC_LINK_MINUTES} minutes. A new one arrives in a moment.
		</p>
	{:else if view === 'expired'}
		<p class="eyebrow">Sign-in link</p>
		<h1>This link has expired</h1>
		<p class="lede">
			A sign-in link lasts {MAGIC_LINK_MINUTES} minutes. Ask for a new one and it will arrive in a
			moment.
		</p>
		<a class="btn btn-primary btn-wide gate-submit" href={newLink}>
			<Icon name="mail" size={15} /> Ask for a new link
		</a>
		<p class="note">The expired link cannot be revived. Nothing was signed in.</p>
	{:else if view === 'used'}
		<p class="eyebrow">Sign-in link</p>
		<h1>This link was already used</h1>
		<p class="lede">
			Each link signs in once, so this one cannot be used again. Ask for a new one and it will
			arrive in a moment.
		</p>
		<a class="btn btn-primary btn-wide gate-submit" href={newLink}>
			<Icon name="mail" size={15} /> Ask for a new link
		</a>
		<p class="note">
			If you did not use it, someone else did — a new link is safe, and the old one stays dead.
		</p>
	{:else if view === 'unusable'}
		<p class="eyebrow">Sign-in link</p>
		<h1>This link no longer works</h1>
		<p class="lede">
			It may have expired or already been used. Ask for a new one and it will arrive in a moment.
		</p>
		<a class="btn btn-primary btn-wide gate-submit" href={newLink}>
			<Icon name="mail" size={15} /> Ask for a new link
		</a>
		<p class="note">Nothing was signed in.</p>
	{:else if view === 'done'}
		<p class="eyebrow">Sign-in link</p>
		<h1>Signed in</h1>
		<p class="lede">
			{#if error}
				The link worked, but the console could not confirm the session.
			{:else}
				The link was accepted. Opening the console.
			{/if}
		</p>
		{#if error}
			<Notice tone="danger" title="The session did not answer">{error}</Notice>
			<a class="btn btn-primary btn-wide gate-submit" href={nextTarget}>
				<Icon name="arrow-up-right" size={14} /> Open the console
			</a>
		{:else}
			<div class="wait" aria-busy="true" aria-live="polite">
				<Spinner /> <span class="mono">starting the session</span>
			</div>
		{/if}
	{:else if view === 'pending'}
		<p class="eyebrow">Sign-in link</p>
		<h1>Signing you in</h1>
		<p class="lede">Spending the link and starting the session.</p>
		<div class="wait" aria-busy="true" aria-live="polite">
			<Spinner /> <span class="mono">checking the link</span>
		</div>
	{:else}
		<p class="eyebrow">Sign-in link</p>
		<h1>Finish signing in</h1>
		<p class="lede">
			{#if address}
				This link was sent to <span class="mono address">{address}</span>.
			{:else}
				This link was sent to the address on the account.
			{/if}
		</p>

		<div class="scanner">
			<span class="scanner-icon" aria-hidden="true"><Icon name="shield" size={14} /></span>
			<div>
				<p class="scanner-title">Opening this page did not use the link</p>
				<p class="scanner-body">
					Mail checkers open links on their own. This page waits for the button, so a scanner
					cannot spend your sign-in.
				</p>
			</div>
		</div>

		{#if error}
			<div class="gate-error"><Notice tone="danger">{error}</Notice></div>
		{/if}

		<button
			bind:this={action}
			type="button"
			class="btn btn-primary btn-wide gate-submit"
			onclick={() => void signIn()}
		>
			<Icon name="key" size={15} /> Sign in
		</button>

		<p class="note">
			The link works once and expires {MAGIC_LINK_MINUTES} minutes after it was sent. Only an
			HttpOnly, SameSite=Strict session cookie is kept.
		</p>
	{/if}

	{#if view !== 'done' && view !== 'pending'}
		<p class="gate-foot-link">
			<a href={ROUTES.login}>Use a different way to sign in</a>
		</p>
	{/if}
</AuthGate>

<style>
	.gate-error {
		margin-bottom: var(--s-3);
	}

	.gate-submit {
		height: 38px;
		margin-top: var(--s-4);
	}

	.address {
		overflow-wrap: anywhere;
	}

	/* The one sentence that explains why this page has a button at all. It sits
	   in the card's own well rather than a tinted callout: the palette is warm,
	   and this is reassurance, not a system state. */
	.scanner {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 10px 12px;
		background: var(--df-surface-well);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}

	.scanner-icon {
		display: inline-flex;
		margin-top: 1px;
		color: var(--ok);
	}

	.scanner-title {
		color: var(--ink-2);
		font-size: 12px;
		font-weight: 600;
		line-height: 1.4;
	}

	.scanner-body {
		margin-top: 2px;
		color: var(--ink-3);
		font-size: 11.5px;
		line-height: 1.5;
	}

	.note {
		margin-top: var(--s-5);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
		color: var(--ink-3);
		font-size: 11.5px;
		line-height: 1.55;
	}

	.wait {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: var(--s-4);
		color: var(--ink-3);
		font-size: 11.5px;
		letter-spacing: 0.04em;
	}

	.gate-foot-link {
		margin-top: var(--s-4);
		padding-top: var(--s-2);
		border-top: 1px solid var(--line);
		text-align: center;
		font-size: 12px;
	}

	/* The link is the only way across to the sign-in screen: give it a control's
	   height rather than a line of text's. */
	.gate-foot-link a {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		padding: 0 var(--s-2);
	}

	@media (max-width: 720px) {
		.gate-submit,
		.gate-foot-link a {
			min-height: 48px;
		}

		.gate-foot-link a {
			justify-content: center;
		}
	}
</style>
