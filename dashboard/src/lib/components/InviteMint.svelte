<script lang="ts">
	/**
	 * Minting one invite, and the one moment its token exists.
	 *
	 * The token lives in this component's state and nowhere else: the page that
	 * renders the list is handed a "something changed" callback, never the token.
	 * Dismissing the result panel sets it to `null`, so closing the panel is the
	 * end of the credential in this browser — which is the same promise the
	 * gateway makes by storing only its hash.
	 */
	import { tick } from 'svelte';
	import { ApiError, createInvite, describeError } from '$lib/api';
	import { formatAbsolute } from '$lib/format';
	import { BASE } from '$lib/paths';
	import type { InviteRole, MintedInvite, Role } from '$lib/types';
	import CopyButton from './CopyButton.svelte';
	import Icon from './Icon.svelte';
	import Notice from './Notice.svelte';
	import Spinner from './Spinner.svelte';

	let {
		open = $bindable(false),
		actorRole = null,
		oncreated
	}: {
		open?: boolean;
		actorRole?: Role | null;
		oncreated: () => void;
	} = $props();

	/** Which control the refusal is about, so only that one reads as invalid. */
	type MintFailure = { title: string; body: string; field: 'email' | 'role' | null };

	/* The gateway's own order (`INVITE_ROLES`); the default selection is still
	   `member`, the least this form can hand out. */
	const ROLE_OPTIONS: Array<{ value: InviteRole; label: string; line: string }> = [
		{
			value: 'owner',
			label: 'Owner',
			line: 'Everything an admin has, and the only role that may mint another owner.'
		},
		{
			value: 'admin',
			label: 'Admin',
			line: 'Devices, messages, rules, workflows, the audit log and this page. Cannot mint an owner.'
		},
		{
			value: 'member',
			label: 'Member',
			line: 'Signs in with no operator rights: devices, rules, invites and automation are refused for this role.'
		}
	];

	const TTL_OPTIONS = [
		{ value: 3_600, label: '1 hour' },
		{ value: 86_400, label: '1 day' },
		{ value: 604_800, label: '7 days' }
	];

	let email = $state('');
	let role = $state<InviteRole>('member');
	let ttl = $state(604_800);
	let pending = $state(false);
	let formError = $state<MintFailure | null>(null);
	/** The one response that carries the raw token. Cleared on dismissal. */
	let minted = $state<MintedInvite | null>(null);

	let emailField = $state<HTMLInputElement | null>(null);
	let roleField = $state<HTMLSelectElement | null>(null);
	let resultHeading = $state<HTMLHeadingElement | null>(null);
	let errorBox = $state<HTMLDivElement | null>(null);

	const roleLine = $derived(ROLE_OPTIONS.find((option) => option.value === role)?.line ?? '');
	const ownerRefused = $derived(role === 'owner' && actorRole !== 'owner');
	const inviteUrl = $derived(minted === null ? '' : invitePageUrl(minted.token));
	const appUrl = $derived(minted === null ? '' : appInviteUrl(minted.token));

	$effect(() => {
		if (!open) return;
		void tick().then(() => emailField?.focus());
	});

	/*
	 * Browser-check hook. `import.meta.env.DEV` is a compile-time constant, so the
	 * production bundle carries no such global; it exists so a driver can read
	 * this component's state and prove the token is gone once the panel closes.
	 */
	if (import.meta.env.DEV) {
		(window as Window & { __dfInviteToken?: () => string | null }).__dfInviteToken = () =>
			minted?.token ?? null;
	}

	function invitePageUrl(token: string): string {
		const path = `${BASE}/invite?code=${encodeURIComponent(token)}`;
		return new URL(path, window.location.origin).toString();
	}

	/** The shape `cli/bin/dakflare.js` prints: host `invite`, `u` = deployment, `t` = token. */
	function appInviteUrl(token: string): string {
		return `dakflare://invite?u=${encodeURIComponent(window.location.origin)}&t=${encodeURIComponent(token)}`;
	}

	function close(): void {
		minted = null;
		email = '';
		formError = null;
		open = false;
	}

	function mintAnother(): void {
		minted = null;
		email = '';
		formError = null;
		void tick().then(() => emailField?.focus());
	}

	async function mint(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (pending) return;
		const address = email.trim();
		if (address === '') {
			formError = {
				title: 'The address is missing',
				body: 'Enter the address the account is for.',
				field: 'email'
			};
			emailField?.focus();
			return;
		}
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
			formError = {
				title: 'That is not an address',
				body: 'Enter it as an email, name@example.com. Nothing was minted.',
				field: 'email'
			};
			emailField?.focus();
			return;
		}

		pending = true;
		formError = null;
		try {
			minted = await createInvite({ email: address, role, expires_in_s: ttl });
			email = '';
			oncreated();
			await tick();
			resultHeading?.focus({ preventScroll: true });
			resultHeading?.scrollIntoView({
				block: 'center',
				behavior: prefersReducedMotion() ? 'auto' : 'smooth'
			});
		} catch (error) {
			formError = readFailure(error);
			await revealError();
		} finally {
			pending = false;
		}
	}

	/**
	 * The three refusals an operator will actually meet, each with its cause. A
	 * 409 is never retried: the same address will be refused again until an
	 * account is removed, so the field keeps what was typed for the fix.
	 */
	function readFailure(error: unknown): MintFailure {
		if (error instanceof ApiError) {
			if (error.code === 'already_registered' || error.status === 409) {
				return {
					title: 'That address already has an account',
					body: 'The gateway refused it and nothing was minted: an invite for an existing account is a no-op when redeemed. Use a different address, or have them sign in.',
					field: 'email'
				};
			}
			if (error.status === 403) {
				if (role === 'owner') {
					return {
						title: 'Only an owner can mint another owner',
						body: `The gateway refused it: this account is ${actorRole ?? 'not an owner'}. Choose admin or member, or ask an owner to mint this one.`,
						field: 'role'
					};
				}
				return {
					title: 'The gateway refused this',
					body: 'This account may no longer be an owner or admin. Sign in again to pick up the current role.',
					field: null
				};
			}
			if (error.code === 'bad_request') {
				return {
					title: 'The gateway rejected that',
					body: 'Check the address and the role, then try again. Nothing was minted.',
					field: 'email'
				};
			}
		}
		return { title: 'The invite was not minted', body: describeError(error), field: null };
	}

	async function revealError(): Promise<void> {
		await tick();
		if (formError?.field === 'role') {
			roleField?.focus({ preventScroll: true });
		} else {
			emailField?.focus({ preventScroll: true });
		}
		errorBox?.scrollIntoView({
			block: 'center',
			behavior: prefersReducedMotion() ? 'auto' : 'smooth'
		});
	}

	function prefersReducedMotion(): boolean {
		return (
			typeof window !== 'undefined' &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}
</script>

{#if minted !== null}
	<section class="mint-result" aria-labelledby="mint-result-title">
		<header class="result-head">
			<div>
				<h3 id="mint-result-title" tabindex="-1" bind:this={resultHeading}>
					Invite for <span class="result-email">{minted.email}</span>
				</h3>
				<p class="result-meta">
					<span class="chip" data-tone="info">{minted.role}</span>
					<span class="mono">expires {formatAbsolute(minted.expires_at)}</span>
				</p>
			</div>
			<span class="chip" data-tone="warn">shown once</span>
		</header>

		<p class="result-lede">
			This token is shown once. The gateway keeps only its hash, so neither this page nor the
			CLI can read the link back after this panel is closed. Copy it now.
		</p>

		<div class="links">
			<div class="link-row">
				<span class="link-label mono">Invite page</span>
				<div class="secret">
					<code class="mono">{inviteUrl}</code>
					<CopyButton value={inviteUrl} label="Copy link" />
				</div>
			</div>
			<div class="link-row">
				<span class="link-label mono">App link</span>
				<div class="secret">
					<code class="mono">{appUrl}</code>
					<CopyButton value={appUrl} label="Copy link" />
				</div>
			</div>
		</div>

		<p class="hint">
			The invite page opens in a browser. The app link opens DakFlare on the phone. Either one
			spends the invite, once; after that both stop working.
		</p>

		<div class="result-actions">
			<button type="button" class="btn btn-primary" onclick={close}>
				<Icon name="check" size={14} /> Done — hide the link
			</button>
			<button type="button" class="btn btn-ghost" onclick={mintAnother}>Mint another</button>
		</div>
	</section>
{:else}
	<form class="mint-form" onsubmit={mint} novalidate>
		<div class="mint-grid">
			<div class="field mint-email">
				<label class="label" for="invite-email">Email</label>
				<input
					bind:this={emailField}
					bind:value={email}
					id="invite-email"
					class="input input-mono"
					type="email"
					inputmode="email"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					placeholder="name@example.com"
					disabled={pending}
					aria-invalid={formError?.field === 'email' ? 'true' : undefined}
					aria-describedby="invite-email-hint"
				/>
				<p id="invite-email-hint" class="hint">
					The only address this invite works for. The gateway stores it lower-cased.
				</p>
			</div>

			<div class="field">
				<label class="label" for="invite-role">Role</label>
				<select
					bind:this={roleField}
					id="invite-role"
					class="input"
					value={role}
					disabled={pending}
					aria-invalid={formError?.field === 'role' ? 'true' : undefined}
					aria-describedby="invite-role-hint"
					onchange={(event) => (role = event.currentTarget.value as InviteRole)}
				>
					{#each ROLE_OPTIONS as option (option.value)}
						<option value={option.value}>{option.label}</option>
					{/each}
				</select>
				<p id="invite-role-hint" class="hint">{roleLine}</p>
				{#if ownerRefused && formError === null}
					<p class="hint warn-line">
						Only an owner may mint another owner. This account is {actorRole ?? 'not an owner'}, so
						the gateway will refuse this one.
					</p>
				{/if}
			</div>

			<div class="field">
				<span class="label" id="invite-expiry-label">Expires</span>
				<div class="seg" role="group" aria-labelledby="invite-expiry-label">
					{#each TTL_OPTIONS as option (option.value)}
						<label class="seg-item">
							<input
								type="radio"
								name="invite-expiry"
								value={option.value}
								bind:group={ttl}
								disabled={pending}
							/>
							<span>{option.label}</span>
						</label>
					{/each}
				</div>
				<p class="hint">
					The link stops working at this time. An unused invite can be revoked sooner from the
					list.
				</p>
			</div>
		</div>

		{#if formError}
			<div class="form-error" bind:this={errorBox} id="invite-mint-error">
				<Notice tone="danger" title={formError.title}>{formError.body}</Notice>
			</div>
		{/if}

		<div class="mint-actions">
			<button type="submit" class="btn btn-primary" disabled={pending} aria-busy={pending}>
				{#if pending}<Spinner />{:else}<Icon name="key" size={14} />{/if}
				{pending ? 'Minting' : 'Mint the invite'}
			</button>
			<button type="button" class="btn btn-ghost" onclick={close} disabled={pending}>
				Cancel
			</button>
		</div>
	</form>
{/if}

<style>
	/* Scrolling a form or a reveal into view must clear the sticky shell header,
	   and the tab strip the phone adds under it. */
	.mint-form,
	.mint-result {
		scroll-margin-top: calc(var(--df-c-shell-header) + 12px);
	}

	.mint-form {
		margin-top: var(--s-3);
		padding: var(--s-3);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--surface-2) 55%, var(--surface));
	}

	.mint-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1.1fr);
		gap: var(--s-3);
	}

	.mint-grid .hint {
		max-width: 52ch;
	}

	.warn-line {
		color: var(--warn);
	}

	.form-error {
		margin-top: var(--s-3);
	}

	.form-error :global(.callout > div) {
		max-width: 76ch;
	}

	.mint-actions {
		display: flex;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: var(--s-3);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
	}

	/* ------------------------------------------------------------- the reveal */

	.mint-result {
		margin-top: var(--s-3);
		padding: var(--s-4);
		border: 1px solid color-mix(in srgb, var(--warn) 34%, var(--line));
		border-radius: var(--r);
		background: color-mix(in srgb, var(--warn) 6%, var(--surface));
	}

	.result-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--s-3);
		flex-wrap: wrap;
	}

	.result-head h3 {
		font-family: var(--df-font-display);
		font-size: var(--text-md);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	/* The heading is focused after minting so the reveal is announced; it is not
	   a control and needs no ring. */
	.result-head h3:focus {
		outline: none;
	}

	.result-email {
		overflow-wrap: anywhere;
	}

	.result-meta {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: 6px;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.result-lede {
		margin-top: var(--s-3);
		max-width: 74ch;
		color: var(--ink-2);
		font-size: var(--text-sm);
		line-height: 1.55;
	}

	.links {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		margin-top: var(--s-3);
	}

	.link-label {
		display: block;
		font-size: 10px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.secret {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: 4px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
	}

	.secret code {
		flex: 1;
		min-width: 0;
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
		user-select: all;
	}

	.result-actions {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: var(--s-4);
		padding-top: var(--s-3);
		border-top: 1px solid color-mix(in srgb, var(--warn) 24%, var(--line));
	}

	.mint-result .hint {
		margin-top: var(--s-3);
		max-width: 74ch;
	}

	@media (max-width: 900px) {
		.mint-form,
		.mint-result {
			scroll-margin-top: calc(var(--df-c-shell-header) + var(--df-c-shell-tabs) + 12px);
		}

		.mint-grid {
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		}

		.mint-email {
			grid-column: 1 / -1;
		}
	}

	@media (max-width: 720px) {
		.mint-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.mint-email {
			grid-column: auto;
		}

		/* 48dp: the field, the select and every button here are typed or tapped
		   with a thumb, and a role choice changes what an account can do. */
		.mint-form .input,
		.mint-actions .btn,
		.result-actions .btn,
		.secret :global(.btn) {
			min-height: 48px;
		}

		.seg-item span {
			min-height: 48px;
			padding: 0 12px;
		}

		.seg {
			display: flex;
		}

		.seg-item {
			flex: 1;
		}

		.result-head {
			flex-direction: column;
		}

		.secret {
			align-items: stretch;
			flex-direction: column;
			gap: 6px;
		}

		.result-actions {
			align-items: stretch;
			flex-direction: column;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.seg-item span {
			transition: none;
		}
	}
</style>
