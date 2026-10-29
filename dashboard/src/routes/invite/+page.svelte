<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ApiError, describeError, getMe, redeemInvite } from '$lib/api';
	import { readInvite } from '$lib/invite';
	import { listPasskeys } from '$lib/passkey';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import AuthGate from '$lib/components/AuthGate.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/*
	 * The only way an account is created (AUTH_PLAN §4). A single-use token is
	 * spent here, the Worker issues the session, and the first passkey is forced
	 * before Overview: an account with no passkey cannot sign in again.
	 */
	let typed = $state('');
	let input = $state<HTMLInputElement | null>(null);
	let pending = $state(false);
	let error = $state<string | null>(null);
	let noSecret = $state(false);
	let elsewhere = $state<string | null>(null);
	let link = $state<string | null>(null);

	const nextTarget = $derived.by(() => {
		const requested = page.url.searchParams.get('next');
		if (requested && requested.startsWith(`${BASE}/`) && requested !== ROUTES.invite) {
			return requested;
		}
		return ROUTES.overview;
	});

	function readFromUrl(): string | null {
		const params = page.url.searchParams;
		return (
			params.get('code') ??
			params.get('invite') ??
			params.get('token') ??
			params.get('t')
		);
	}

	onMount(() => {
		const value = readFromUrl();
		if (value === null) {
			input?.focus();
			return;
		}
		const parsed = readInvite(value);
		if (parsed === null) {
			typed = value;
			error = 'That does not look like an invite. Paste the whole link, or the code on its own.';
			input?.focus();
			return;
		}
		if (parsed.origin !== null && parsed.origin !== window.location.origin) {
			// The token is only valid on the deployment that minted it.
			typed = parsed.token;
			link = `${parsed.origin}/admin/invite?code=${encodeURIComponent(parsed.token)}`;
			elsewhere = parsed.origin;
			return;
		}
		void redeem(parsed.token);
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (pending) return;
		const parsed = readInvite(typed);
		if (parsed === null) {
			error = 'That does not look like an invite. Paste the whole link, or the code on its own.';
			input?.focus();
			return;
		}
		if (parsed.origin !== null && parsed.origin !== window.location.origin) {
			link = `${parsed.origin}/admin/invite?code=${encodeURIComponent(parsed.token)}`;
			elsewhere = parsed.origin;
			return;
		}
		await redeem(parsed.token);
	}

	async function redeem(token: string) {
		pending = true;
		error = null;
		noSecret = false;
		try {
			const info = await redeemInvite(token);
			try {
				session.applyMe(await getMe());
			} catch {
				session.applyMe({
					ok: true,
					user: { ...info.user, twoFactorEnabled: false },
					expires_at: info.expires_at,
					auth_mode: 'new'
				});
			}
			// Enrolment is a step, not an offer: ask whether one already exists.
			let existing = 0;
			try {
				existing = (await listPasskeys()).length;
			} catch {
				existing = 0;
			}
			if (existing === 0) {
				await goto(`${ROUTES.enrol}?next=${encodeURIComponent(nextTarget)}`, { replaceState: true });
				return;
			}
			await goto(nextTarget, { replaceState: true });
		} catch (failure) {
			if (failure instanceof ApiError && failure.code === 'auth_unavailable') {
				noSecret = true;
			} else if (failure instanceof ApiError && failure.code === 'invite_invalid') {
				error = 'That invite was already used or has expired. Ask the owner for a new one.';
			} else if (failure instanceof ApiError && failure.code === 'already_registered') {
				error = 'That address already has an account. Sign in with its passkey instead.';
			} else if (failure instanceof ApiError && failure.status === 400) {
				error = 'That does not look like an invite. Paste the whole link, or the code on its own.';
			} else {
				error = describeError(failure);
			}
			input?.focus();
		} finally {
			pending = false;
		}
	}
</script>

<svelte:head>
	<title>Invite · DakFlare</title>
</svelte:head>

<AuthGate>
	{#if noSecret}
		<p class="eyebrow">Invite</p>
		<h1>This deployment has no auth secret yet</h1>
		<p class="lede">
			An invite cannot become an account until the Worker has a secret to sign sessions with.
			Set it, then open the link again.
		</p>
		<div class="command">
			<code>wrangler secret put BETTER_AUTH_SECRET</code>
			<CopyButton value="wrangler secret put BETTER_AUTH_SECRET" iconOnly label="Copy command" />
		</div>
		<p class="hint">
			<code>dakflare</code> will set this for you in a later release. Until then the command above
			is the only way. The invite is still valid; it is spent only when it is redeemed.
		</p>
		<div class="row" style="margin-top: 16px">
			<button type="button" class="btn" onclick={() => (noSecret = false)}>
				<Icon name="refresh" size={14} /> Try the invite again
			</button>
			<a class="btn btn-ghost" href={ROUTES.login}>Sign-in screen</a>
		</div>
	{:else if elsewhere}
		<p class="eyebrow">Invite</p>
		<h1>This invite is for another deployment</h1>
		<p class="lede">
			It was minted on <span class="mono">{elsewhere}</span>, and the code only redeems there.
		</p>
		<a class="btn btn-primary btn-wide" href={link ?? ROUTES.login}>
			<Icon name="arrow-up-right" size={14} /> Open the invite there
		</a>
		{#if error}
			<div class="gate-error"><Notice tone="danger">{error}</Notice></div>
		{/if}
		<p class="note">
			Open that address first, then paste the code again if the link does not carry it.
		</p>
		<div class="row" style="margin-top: 12px">
			<button
				type="button"
				class="link-btn"
				onclick={() => {
					elsewhere = null;
					error = null;
					void redeem(typed.trim());
				}}
			>
				Redeem on this deployment anyway
			</button>
		</div>
	{:else if pending}
		<p class="eyebrow">Invite</p>
		<h1>Opening the invite</h1>
		<p class="lede">Spending the single-use code and starting the session.</p>
		<div class="wait" aria-busy="true" aria-live="polite">
			<Spinner /> <span class="mono">redeeming</span>
		</div>
	{:else}
		<p class="eyebrow">Invite</p>
		<h1>Set up your account</h1>
		<p class="lede">
			An owner invited this address. The code works once; it becomes an account and asks for a
			passkey in the same step.
		</p>

		<form onsubmit={submit} novalidate>
			<div class="field">
				<label class="label" for="invite-code">Invite code or link</label>
				<input
					bind:this={input}
					bind:value={typed}
					id="invite-code"
					class="input input-mono"
					autocomplete="off"
					autocapitalize="none"
					autocorrect="off"
					spellcheck="false"
					placeholder="dki_… or dakflare://invite?…"
					disabled={pending}
					aria-invalid={error ? 'true' : undefined}
					aria-describedby="invite-hint"
				/>
				<p id="invite-hint" class="hint">
					Paste the whole <code>dakflare://invite</code> link if you have it, or the code on its
					own.
				</p>
			</div>

			{#if error}
				<div class="gate-error"><Notice tone="danger">{error}</Notice></div>
			{/if}

			<button
				type="submit"
				class="btn btn-primary btn-wide gate-submit"
				disabled={pending || typed.trim() === ''}
				aria-busy={pending}
			>
				{#if pending}<Spinner />{:else}<Icon name="key" size={14} />{/if}
				{pending ? 'Opening' : 'Redeem invite'}
			</button>
		</form>

		<p class="note">
			No invitation yet? Ask the owner of the deployment for one. There is no public sign-up, and
			no password to create.
		</p>
	{/if}

	<p class="gate-foot-link">
		<a href={ROUTES.login}>Already have a passkey? Sign in</a>
	</p>
</AuthGate>

<style>
	.gate-error {
		margin-top: var(--s-3);
	}

	.gate-submit {
		height: 38px;
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

	.hint code {
		font-family: var(--font-mono);
		font-size: 10.5px;
		padding: 1px 4px;
		border-radius: 3px;
		background: var(--df-surface-well);
		border: 1px solid var(--line);
	}

	.wait {
		display: flex;
		align-items: center;
		gap: 8px;
		color: var(--ink-3);
		font-size: 11.5px;
		letter-spacing: 0.04em;
	}

	.command {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding: 8px 10px;
		background: var(--df-surface-well);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
	}

	.command code {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11.5px;
		color: var(--ink);
	}

	.gate-foot-link {
		margin-top: var(--s-4);
		padding-top: var(--s-2);
		border-top: 1px solid var(--line);
		text-align: center;
		font-size: 12px;
	}

	/* The link is the only way across to the passkey door: give it a control's
	   height rather than a line of text's. */
	.gate-foot-link a {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		padding: 0 var(--s-2);
	}

	@media (max-width: 420px) {
		.command code {
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}
</style>
