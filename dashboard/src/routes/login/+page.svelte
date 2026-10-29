<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		ApiError,
		createSession,
		describeError,
		getAuthSession,
		getHealth,
		getMe,
		getSession,
		signOutAccount
	} from '$lib/api';
	import { passkeySupport, signInWithPasskey, verifyAuthenticatorCode, verifyRecoveryCode } from '$lib/passkey';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import Brand from '$lib/components/Brand.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/*
	 * Which door this deployment opens is answered by `GET /v1/admin/health`
	 * (`auth_mode`, `auth_configured`). That route sits behind the admin gate, so
	 * before sign-in it usually answers 401 — the flag is simply not readable
	 * from here yet. The `unknown` state below is that honest case: the admin
	 * token form stays first because it is the only thing that works in
	 * `legacy`, and the passkey path is offered only when `/api/auth` is live.
	 * See the report for why this cannot be resolved in the dashboard alone.
	 */
	type Gate =
		| { kind: 'checking' }
		| { kind: 'legacy' }
		| { kind: 'new' }
		| { kind: 'new-unconfigured' }
		| { kind: 'unknown'; authLive: boolean }
		| { kind: 'unreachable'; message: string }
		| { kind: 'failed'; message: string };

	// Deliberately no token state: the field is uncontrolled and its value is read
	// once, immediately before the request, then cleared. Only emptiness is tracked.
	let hasToken = $state(false);
	let showToken = $state(false);
	let pending = $state(false);
	let error = $state<string | null>(null);
	let input = $state<HTMLInputElement | null>(null);
	let gate = $state<Gate>({ kind: 'checking' });

	/** Passkey path: which step of it is on screen. */
	let step = $state<'passkey' | 'second-factor'>('passkey');
	let useRecovery = $state(false);
	let codeInput = $state<HTMLInputElement | null>(null);
	let passkeyBusy = $state(false);
	let passkeyError = $state<string | null>(null);

	const nextTarget = $derived.by(() => {
		const requested = page.url.searchParams.get('next');
		if (
			requested &&
			requested.startsWith(`${BASE}/`) &&
			requested !== ROUTES.login &&
			requested !== ROUTES.invite &&
			requested !== ROUTES.enrol
		) {
			return requested;
		}
		return ROUTES.overview;
	});

	/** Better Auth is mounted (a secret exists) — the only pre-login signal there is. */
	async function authIsLive(): Promise<boolean> {
		try {
			await getAuthSession();
			return true;
		} catch {
			return false;
		}
	}

	async function resolveGate(): Promise<void> {
		gate = { kind: 'checking' };
		let raw: (Record<string, unknown> & { auth_mode?: string; auth_configured?: boolean }) | null =
			null;
		try {
			const { health } = await getHealth(true);
			raw = health as unknown as Record<string, unknown>;
		} catch (failure) {
			// Status 0 is the console's own "no answer" (timeout or transport).
			if (!(failure instanceof ApiError) || failure.status === 0) {
				gate = { kind: 'unreachable', message: describeError(failure) };
				return;
			}
			if (failure.status >= 500) {
				gate = { kind: 'failed', message: describeError(failure) };
				return;
			}
			// 401/403: the gate answered before we could read the flag.
			gate = { kind: 'unknown', authLive: await authIsLive() };
			await focusArrival();
			return;
		}

		if (raw.auth_mode === 'new') {
			gate =
				raw.auth_configured === true
					? { kind: 'new' }
					: { kind: 'new-unconfigured' };
		} else if (raw.auth_mode === 'legacy') {
			gate = { kind: 'legacy' };
		} else if (String(raw.error ?? '') === 'auth_unavailable') {
			// Only `new` reports a missing secret here: in `legacy` the token gate
			// would have answered 401 instead of reaching the auth guard.
			gate = { kind: 'new-unconfigured' };
		} else {
			gate = { kind: 'unknown', authLive: await authIsLive() };
		}
		await focusArrival();
	}

	async function focusArrival(): Promise<void> {
		await tick();
		if (gate.kind === 'new' && step === 'passkey') {
			document.getElementById('passkey-start')?.focus();
			return;
		}
		if (gate.kind === 'new-unconfigured' || gate.kind === 'unreachable' || gate.kind === 'failed')
			return;
		input?.focus();
	}

	onMount(() => {
		void (async () => {
			// Already signed in? The cookie endpoint is asked first, exactly as
			// before; the account endpoint only answers when the flag is `new`.
			try {
				const info = await getSession();
				session.markAuthed(info.expires_at);
				await goto(nextTarget, { replaceState: true });
				return;
			} catch {
				// Not a token session.
			}
			try {
				const me = await getMe();
				session.applyMe(me);
				await goto(nextTarget, { replaceState: true });
				return;
			} catch {
				// Not an account session either: offer the doors below.
			}
			await resolveGate();
		})();
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		if (pending) return;
		const field = input;
		const value = field?.value.trim() ?? '';
		if (!value) {
			error = 'Enter the admin token for this deployment.';
			field?.focus();
			return;
		}

		pending = true;
		error = null;
		// The token lives only in this request body. Clear the field before awaiting so
		// nothing lingers in the DOM or in reactive state.
		if (field) field.value = '';
		hasToken = false;
		try {
			const info = await createSession(value);
			session.markAuthed(info.expires_at);
			await goto(nextTarget, { replaceState: true });
		} catch (failure) {
			error =
				failure instanceof ApiError && failure.status === 401
					? 'That token was not accepted.'
					: describeError(failure);
			input?.focus();
		} finally {
			pending = false;
		}
	}

	/** A passkey answer is only useful if the console's own gate accepts it. */
	async function landAccountSession(): Promise<boolean> {
		try {
			const me = await getMe();
			// `/v1/auth/me` is not admin-gated. Health is, so it answers the real
			// question: would the pages that follow accept this session?
			await getHealth(true);
			session.applyMe(me);
			await goto(nextTarget, { replaceState: true });
			return true;
		} catch (failure) {
			if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) {
				await signOutAccount();
				gate = { kind: 'legacy' };
				error =
					'This deployment still signs in with the admin token. The passkey worked, but the console does not accept it yet; use the token below.';
				await focusArrival();
				return false;
			}
			error = describeError(failure);
			return false;
		}
	}

	async function passkeySignIn() {
		if (passkeyBusy) return;
		passkeyBusy = true;
		passkeyError = null;
		error = null;
		try {
			await signInWithPasskey();
			// A TOTP account answers without a session; ask rather than assume.
			const current = await getAuthSession();
			if (current === null) {
				step = 'second-factor';
				useRecovery = false;
				await tick();
				codeInput?.focus();
				return;
			}
			await landAccountSession();
		} catch (failure) {
			passkeyError = failure instanceof ApiError ? describeError(failure) : errorCopy(failure);
			if (failure instanceof ApiError && failure.status === 503) {
				gate = { kind: 'new-unconfigured' };
			}
		} finally {
			passkeyBusy = false;
		}
	}

	function errorCopy(failure: unknown): string {
		if (failure instanceof Error && failure.message) return failure.message;
		return 'The passkey step did not finish. Try again.';
	}

	async function submitCode(event: SubmitEvent) {
		event.preventDefault();
		if (passkeyBusy) return;
		const value = codeInput?.value.trim() ?? '';
		if (value === '') {
			passkeyError = useRecovery
				? 'Enter one of the recovery codes you saved.'
				: 'Enter the 6-digit code from the authenticator app.';
			codeInput?.focus();
			return;
		}
		passkeyBusy = true;
		passkeyError = null;
		try {
			if (useRecovery) await verifyRecoveryCode(value);
			else await verifyAuthenticatorCode(value);
			if (codeInput) codeInput.value = '';
			const current = await getAuthSession();
			if (current === null) {
				passkeyError = useRecovery
					? 'That recovery code was not accepted. Check it and try again.'
					: 'That code was not accepted. Wait for the next one and try again.';
				codeInput?.focus();
				return;
			}
			await landAccountSession();
		} catch (failure) {
			passkeyError =
				failure instanceof ApiError && failure.status === 401
					? 'That code was not accepted. Wait for the next one and try again.'
					: errorCopy(failure);
			codeInput?.focus();
		} finally {
			passkeyBusy = false;
		}
	}

	function availableSupport(): string | null {
		const support = passkeySupport();
		if (support === 'yes') return null;
		return support === 'insecure'
			? 'Passkeys need a secure address. Open the console over https, or on localhost.'
			: 'This browser cannot use passkeys. Open the console in a browser that can, or use an invite.';
	}

	const supportNote = $derived(availableSupport());
</script>

<svelte:head>
	<title>Sign in · DakFlare</title>
</svelte:head>

<div class="login">
	<div class="login-inner">
		<Brand href={ROUTES.login} />

		<div class="login-card">
			<div class="login-accent"></div>
			<div class="login-body">
				{#if gate.kind === 'checking'}
					<p class="eyebrow">Operator access</p>
					<h1>Sign in to the console</h1>
					<p class="login-lede">Checking how this deployment signs people in.</p>
					<div class="login-wait" aria-busy="true" aria-live="polite">
						<Spinner /> <span class="mono">reading the deployment</span>
					</div>
				{:else if gate.kind === 'new-unconfigured'}
					<p class="eyebrow">Operator access</p>
					<h1>This deployment has no auth secret yet</h1>
					<p class="login-lede">
						Account sign-in cannot start until the Worker has a secret to sign sessions with.
						Set it, then reload this page.
					</p>
					<div class="command">
						<code>wrangler secret put BETTER_AUTH_SECRET</code>
						<CopyButton value="wrangler secret put BETTER_AUTH_SECRET" iconOnly label="Copy command" />
					</div>
					<p class="hint">
						<code>dakflare</code> will set this for you in a later release. Until then the command
						above is the only way; a value of 32 random bytes is enough.
					</p>
					<button
						type="button"
						class="btn btn-primary btn-wide login-submit"
						onclick={() => void resolveGate()}
					>
						<Icon name="refresh" size={14} /> Check again
					</button>
					<p class="login-note">
						<span class="note-icon"><Icon name="key" size={13} /></span>
						<span>
							The admin token still works on this deployment until it switches. Sign in with
							<code>ADMIN_TOKEN</code> if you need the console now.
						</span>
					</p>
				{:else if gate.kind === 'unreachable' || gate.kind === 'failed'}
					<p class="eyebrow">Operator access</p>
					<h1>{gate.kind === 'unreachable' ? 'The gateway is not answering' : 'Sign-in could not be checked'}</h1>
					<p class="login-lede">
						{gate.kind === 'unreachable'
							? 'Sign-in cannot be checked until it answers. Nothing was changed.'
							: 'The gateway answered with an error. Nothing was changed; try again in a moment.'}
					</p>
					<Notice tone="danger" title={gate.kind === 'unreachable' ? 'No answer from the gateway' : 'The check failed'}>
						{gate.message}
					</Notice>
					<button
						type="button"
						class="btn btn-primary btn-wide login-submit"
						onclick={() => void resolveGate()}
					>
						<Icon name="refresh" size={14} /> Try again
					</button>
				{:else if gate.kind === 'new'}
					<p class="eyebrow">Operator access</p>
					<h1>Sign in to the console</h1>
					<p class="login-lede">
						This deployment signs in with a passkey. The key stays on this device; there is no
						password.
					</p>

					{#if step === 'second-factor'}
						<form onsubmit={submitCode} novalidate>
							<div class="field">
								<label class="label" for="second-factor">
									{useRecovery ? 'Recovery code' : 'Authenticator code'}
								</label>
								<input
									bind:this={codeInput}
									id="second-factor"
									class="input input-mono"
									inputmode={useRecovery ? 'text' : 'numeric'}
									autocomplete="one-time-code"
									autocapitalize="none"
									spellcheck="false"
									placeholder={useRecovery ? 'xxxx-xxxx' : '000000'}
									disabled={passkeyBusy}
									aria-invalid={passkeyError ? 'true' : undefined}
									aria-describedby="second-factor-hint"
								/>
								<p id="second-factor-hint" class="hint">
									{useRecovery
										? 'One of the single-use codes saved when two-factor was set up. Each works once.'
										: 'The 6-digit code from the authenticator app on the account.'}
								</p>
							</div>

							{#if passkeyError}
								<div class="login-error"><Notice tone="danger">{passkeyError}</Notice></div>
							{/if}

							<button
								type="submit"
								class="btn btn-primary btn-wide login-submit"
								disabled={passkeyBusy}
								aria-busy={passkeyBusy}
							>
								{#if passkeyBusy}<Spinner />{:else}<Icon name="shield" size={14} />{/if}
								{passkeyBusy ? 'Checking' : 'Continue'}
							</button>
							<button
								type="button"
								class="link-btn login-alternate"
								onclick={async () => {
									useRecovery = !useRecovery;
									passkeyError = null;
									await tick();
									codeInput?.focus();
								}}
							>
								{useRecovery ? 'Use the authenticator instead' : 'Use a recovery code instead'}
							</button>
						</form>
					{:else}
						{#if supportNote}
							<Notice tone="warn" title="This browser cannot use passkeys">{supportNote}</Notice>
							<a class="btn btn-primary btn-wide login-submit" href={ROUTES.invite}>
								<Icon name="key" size={14} /> Use an invite
							</a>
						{:else}
							<button
								id="passkey-start"
								type="button"
								class="btn btn-primary btn-wide login-submit"
								onclick={() => void passkeySignIn()}
								disabled={passkeyBusy}
								aria-busy={passkeyBusy}
							>
								{#if passkeyBusy}<Spinner />{:else}<Icon name="fingerprint" size={16} />{/if}
								{passkeyBusy ? 'Waiting for the passkey' : 'Sign in with a passkey'}
							</button>
						{/if}

						{#if passkeyError}
							<div class="login-error"><Notice tone="danger">{passkeyError}</Notice></div>
						{/if}

						<p class="login-note">
							<span class="note-icon"><Icon name="shield" size={13} /></span>
							<span>
								The passkey never leaves the device. Only an HttpOnly, SameSite=Strict session
								cookie is kept.
							</span>
						</p>

						<details class="login-more">
							<summary>Trouble signing in?</summary>
							<div class="login-more-body">
								<p>
									A passkey is the only way into an account on this deployment. If the device
									holding it is gone, an owner has to help: there is no password to reset.
								</p>
								<p>
									Two-factor on the account? After the passkey the console asks for an
									authenticator code, and a saved recovery code is accepted there instead.
								</p>
								<p>
									Invited but never signed in? Open the invite link the owner sent. It becomes an
									account and asks for a passkey in the same step.
								</p>
								<a class="btn btn-sm" href={ROUTES.invite}>
									<Icon name="key" size={13} /> Open an invite
								</a>
							</div>
						</details>
					{/if}
				{:else}
					<p class="eyebrow">Operator access</p>
					<h1>Sign in to the console</h1>
					<p class="login-lede">
						Enter the admin token for this deployment. It is exchanged for a short-lived session
						cookie.
					</p>

					<form onsubmit={submit} novalidate>
					<div class="field">
						<label class="label" for="admin-token">Admin token</label>
						<div class="input-row">
							<input
								bind:this={input}
								id="admin-token"
								class="input input-mono"
								type={showToken ? 'text' : 'password'}
								oninput={(event) => {
									hasToken = event.currentTarget.value.trim() !== '';
								}}
								autocomplete="off"
								autocapitalize="none"
								autocorrect="off"
								spellcheck="false"
								placeholder="Paste token"
								disabled={pending}
								aria-invalid={error ? 'true' : undefined}
								aria-describedby="token-hint"
							/>
							<button
								type="button"
								class="btn btn-sm show-btn"
								onclick={() => (showToken = !showToken)}
								aria-pressed={showToken}
								aria-label={showToken ? 'Hide token' : 'Show token'}
							>
								{showToken ? 'Hide' : 'Show'}
							</button>
						</div>
						<p id="token-hint" class="hint">
							Set with <code>wrangler secret put ADMIN_TOKEN</code> on the Worker.
						</p>
					</div>

					{#if error}
						<div class="login-error">
							<Notice tone="danger">{error}</Notice>
						</div>
					{/if}

					<button
						type="submit"
						class="btn btn-primary btn-wide login-submit"
						disabled={pending || !hasToken}
						aria-busy={pending}
					>
						{#if pending}<Spinner />{:else}<Icon name="key" size={14} />{/if}
						{pending ? 'Verifying' : 'Sign in'}
					</button>
				</form>

					<p class="login-note">
						<span class="note-icon"><Icon name="shield" size={13} /></span>
						<span>
							The token is never stored in this browser. Only an HttpOnly, SameSite=Strict session
							cookie is kept.
						</span>
					</p>

					{#if gate.kind === 'unknown'}
						<p class="login-switch">
							Account sign-in arrives when this deployment switches. Until then the admin token
							is the way in.
						</p>
						{#if gate.authLive && !supportNote}
							<div class="login-alt">
								<span class="login-alt-rule" aria-hidden="true"></span>
								<button
									type="button"
									class="btn btn-wide"
									onclick={() => {
										gate = { kind: 'new' };
										void tick().then(() => document.getElementById('passkey-start')?.focus());
									}}
								>
									<Icon name="fingerprint" size={15} /> Sign in with a passkey
								</button>
								<p class="hint">
									Use this after the deployment has switched to account sign-in.
								</p>
							</div>
						{/if}
					{:else if gate.kind === 'legacy'}
						<p class="login-switch">
							Account sign-in arrives when this deployment switches. Until then the admin token
							is the way in.
						</p>
					{/if}
				{/if}
			</div>
		</div>

		<p class="login-foot">
			<span class="mono">DAKFLARE</span> · self-hosted SMS gateway console
		</p>
	</div>
</div>

<style>
	.login {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: var(--s-6) var(--s-4);
	}

	.login-inner {
		width: min(398px, 100%);
	}

	.login-inner :global(.brand) {
		padding-left: 0;
	}

	.login-card {
		margin-top: var(--s-5);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow);
		overflow: hidden;
	}

	.login-accent {
		height: 2px;
		background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 25%, transparent));
	}

	.login-body {
		padding: var(--s-5);
	}

	h1 {
		margin-top: 6px;
		font-size: 1.375rem;
		letter-spacing: -0.02em;
	}

	.login-lede {
		margin-top: var(--s-2);
		margin-bottom: var(--s-5);
		color: var(--ink-3);
		font-size: var(--text-base);
		line-height: 1.55;
	}

	.show-btn {
		flex: none;
		height: auto;
		min-width: 56px;
		align-self: stretch;
	}

	.login-error {
		margin-top: var(--s-3);
	}

	.login-submit {
		height: 38px;
		margin-top: var(--s-4);
	}

	.login-note {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		margin-top: var(--s-5);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
		color: var(--ink-3);
		font-size: 11.5px;
		line-height: 1.5;
	}

	.note-icon {
		display: inline-flex;
		margin-top: 1px;
		color: var(--ok);
	}

	.login-foot {
		margin-top: var(--s-4);
		text-align: center;
		color: var(--ink-3);
		font-size: 11px;
		letter-spacing: 0.02em;
	}

	.login-foot .mono {
		letter-spacing: 0.14em;
		font-size: 10px;
	}

	/* The one line that explains the deployment's state without competing with
	   the form. Meta ink, small, separated by a hairline. */
	.login-switch {
		margin-top: var(--s-4);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
		color: var(--ink-3);
		font-size: 11.5px;
		line-height: 1.5;
	}

	.login-alt {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: var(--s-4);
	}

	.login-alt-rule {
		height: 1px;
		margin-bottom: 6px;
		background: var(--line);
	}

	.login-alt .hint {
		text-align: center;
	}

	.login-wait {
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

	.command :global(.btn) {
		flex: none;
	}

	.hint code {
		font-family: var(--font-mono);
		font-size: 10.5px;
		padding: 1px 4px;
		border-radius: 3px;
		background: var(--df-surface-well);
		border: 1px solid var(--line);
	}

	.login-submit + .login-error {
		margin-top: var(--s-3);
	}

	.login-alternate {
		display: block;
		margin: var(--s-3) auto 0;
		font-size: 12px;
	}

	.login-more {
		margin-top: var(--s-4);
		border-top: 1px solid var(--line);
		padding-top: var(--s-3);
	}

	.login-more summary {
		/* A summary is a control: give it a full-height hit area, not just the
		   glyph line. */
		cursor: pointer;
		display: flex;
		align-items: center;
		min-height: 36px;
		margin-top: -4px;
		color: var(--ink-2);
		font-size: 12px;
		font-weight: 500;
		border-radius: 2px;
	}

	.login-more summary:hover {
		color: var(--ink);
	}

	.login-more-body {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--s-2);
		margin-top: var(--s-2);
		color: var(--ink-3);
		font-size: 11.5px;
		line-height: 1.55;
	}

	.login-more-body .btn {
		margin-top: 2px;
	}

	@media (max-width: 720px) {
		.login-more summary {
			min-height: 44px;
		}
	}

	/* The command row is the one place a long string may wrap on a phone. */
	@media (max-width: 420px) {
		.command code {
			white-space: normal;
			overflow-wrap: anywhere;
		}
	}
</style>
