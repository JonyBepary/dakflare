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
	import {
		PasswordFailure,
		probePasswordSignIn,
		readMode,
		signInWithPassword,
		type PasswordMode
	} from '$lib/password';
	import { isWellFormedCode } from '$lib/totp';
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
	let step = $state<'passkey' | 'password' | 'second-factor'>('passkey');
	let useRecovery = $state(false);
	let codeInput = $state<HTMLInputElement | null>(null);
	let passkeyBusy = $state(false);
	let passkeyError = $state<string | null>(null);
	/** Which first factor this sign-in came through, so the code step names it. */
	let firstFactor = $state<'passkey' | 'password'>('passkey');
	/**
	 * True once the server has burned the challenge: too many wrong codes, or the
	 * ten-minute window closed. The only way forward is a new first factor, so
	 * the form stops offering a retry that cannot work.
	 */
	let challengeSpent = $state(false);

	/**
	 * The password door.
	 *
	 * `password_mode` lives on `/v1/admin/health`, which is admin-gated: before
	 * sign-in it usually answers 401, so the mode is often `unknown` here. The
	 * door is then offered, and opening it asks the sign-in route itself whether
	 * passwords are on — that route is the authority, and it answers
	 * `password_disabled` (403) when the mode is `off`. A deployment known to be
	 * off never offers the door, and no password field is ever shown for one.
	 */
	let passwordAvailable = $state<'on' | 'off' | 'unknown'>('unknown');
	let passwordCheck = $state<'idle' | 'checking'>('idle');
	let passwordRefused = $state<string | null>(null);
	let pwEmail = $state('');
	let pwPassword = $state('');
	let pwShow = $state(false);
	let pwBusy = $state(false);
	let pwError = $state<string | null>(null);
	let pwEmailField = $state<HTMLInputElement | null>(null);
	let pwPasswordField = $state<HTMLInputElement | null>(null);

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
			readPasswordAvailability(raw);
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

	/**
	 * The one pre-sign-in read of the password mode, when health answers at all.
	 * `password_configured: false` means `AUTH_PEPPER` is missing: a password
	 * could be stored in neither mode, so the door stays shut.
	 */
	function readPasswordAvailability(health: Record<string, unknown>): void {
		const mode: PasswordMode = readMode(health.password_mode);
		const configured = health.password_configured === true;
		passwordAvailable = mode !== 'off' && configured ? 'on' : 'off';
	}

	/**
	 * Open the password door.
	 *
	 * When the mode was readable this is immediate. When it was not — the usual
	 * case, because health is admin-gated — the sign-in route is asked once,
	 * with a reserved `.example` address and all-zero material, so the check can
	 * never touch a real account. A deployment that says `password_disabled`
	 * gets a sentence instead of a form, which is the rule: no password field is
	 * ever shown for a deployment whose mode is off.
	 */
	async function openPasswordDoor(): Promise<void> {
		if (passwordCheck === 'checking' || passkeyBusy) return;
		passwordRefused = null;
		passkeyError = null;
		if (passwordAvailable === 'on') {
			await showPasswordStep();
			return;
		}
		passwordCheck = 'checking';
		try {
			const answer = await probePasswordSignIn();
			if (answer === 'off') {
				passwordAvailable = 'off';
				passwordRefused =
					'Passwords are switched off on this deployment. Sign in with the passkey.';
				await tick();
				document.getElementById('passkey-start')?.focus();
				return;
			}
			passwordAvailable = answer;
			await showPasswordStep();
		} finally {
			passwordCheck = 'idle';
		}
	}

	async function showPasswordStep(): Promise<void> {
		step = 'password';
		pwError = null;
		pwPassword = '';
		pwShow = false;
		if (pwEmail === '') pwEmail = session.email ?? '';
		await tick();
		if (pwEmail.trim() === '') pwEmailField?.focus();
		else pwPasswordField?.focus();
	}

	async function backToPasskey(): Promise<void> {
		step = 'passkey';
		pwError = null;
		pwPassword = '';
		pwShow = false;
		await tick();
		document.getElementById('passkey-start')?.focus();
	}

	/** A shape check, not a policy: the gateway is the one that decides. */
	function looksLikeEmail(value: string): boolean {
		return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
	}

	async function passwordSignIn(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (pwBusy) return;
		const email = pwEmail.trim();
		if (!looksLikeEmail(email)) {
			pwError = 'Enter the email address this account uses.';
			pwEmailField?.focus();
			return;
		}
		if (pwPassword === '') {
			pwError = 'Enter the password for this account.';
			pwPasswordField?.focus();
			return;
		}

		pwBusy = true;
		pwError = null;
		try {
			const result = await signInWithPassword({ email, password: pwPassword });
			// The password has been used; keep no copy of it in state or in the DOM.
			pwPassword = '';
			pwShow = false;
			firstFactor = 'password';
			if (result.twoFactorRedirect) {
				await beginSecondFactorStep();
				return;
			}
			const current = await getAuthSession();
			if (current === null) {
				// A TOTP account: this Worker withheld the session. An older one that
				// did not is caught here rather than opening the console unasked.
				await beginSecondFactorStep();
				return;
			}
			await landAccountSession();
		} catch (error) {
			if (error instanceof PasswordFailure) {
				if (error.kind === 'disabled') {
					passwordAvailable = 'off';
					passwordRefused = error.message;
					step = 'passkey';
					await tick();
					document.getElementById('passkey-start')?.focus();
					return;
				}
				pwError = error.message;
			} else {
				pwError = errorCopy(error);
			}
			pwPassword = '';
			await tick();
			pwPasswordField?.focus();
		} finally {
			pwBusy = false;
		}
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
				error = `This deployment still signs in with the admin token. The ${
					firstFactor === 'password' ? 'password' : 'passkey'
				} worked, but the console does not accept it yet; use the token below.`;
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
			const result = await signInWithPasskey();
			// The Worker withholds the session when the account has an
			// authenticator; ask anyway, so an older Worker that does not is also
			// handled the same way.
			if (result.twoFactorRedirect) {
				await beginSecondFactorStep();
				return;
			}
			const current = await getAuthSession();
			if (current === null) {
				await beginSecondFactorStep();
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

	async function beginSecondFactorStep(): Promise<void> {
		step = 'second-factor';
		useRecovery = false;
		challengeSpent = false;
		await tick();
		codeInput?.focus();
	}

	/** Back to the first factor that was used: a spent challenge cannot be revived. */
	async function startOver(): Promise<void> {
		useRecovery = false;
		challengeSpent = false;
		passkeyError = null;
		if (firstFactor === 'password') {
			await showPasswordStep();
			return;
		}
		step = 'passkey';
		await tick();
		document.getElementById('passkey-start')?.focus();
	}

	function errorCopy(failure: unknown): string {
		if (failure instanceof Error && failure.message) return failure.message;
		return 'The passkey step did not finish. Try again.';
	}

	async function submitCode(event: SubmitEvent) {
		event.preventDefault();
		if (passkeyBusy || challengeSpent) return;
		const value = codeInput?.value.trim() ?? '';
		if (value === '') {
			passkeyError = useRecovery
				? 'Enter one of the recovery codes you saved.'
				: 'Enter the 6-digit code from the authenticator app.';
			codeInput?.focus();
			return;
		}
		// Local shape check only: a malformed value cannot be right, and the
		// server spends one of five attempts on every code it is asked about.
		if (!isWellFormedCode(value, useRecovery)) {
			passkeyError = useRecovery
				? 'A recovery code looks like abcde-fghij, with the dash. Check what you saved.'
				: 'Six digits, no spaces. Check the code the app is showing now.';
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
					? 'That recovery code was not accepted. Each one works once; check the one you typed.'
					: 'That code was not accepted. Wait for the next one and try again.';
				codeInput?.focus();
				return;
			}
			await landAccountSession();
		} catch (failure) {
			reportCodeFailure(failure);
		} finally {
			passkeyBusy = false;
		}
	}

	/**
	 * Say what the server said. A retry hint appears only when the response
	 * carried one (`Retry-After` or `retryAfter`); nothing counts down on its own.
	 */
	function reportCodeFailure(failure: unknown): void {
		if (!(failure instanceof ApiError)) {
			passkeyError = errorCopy(failure);
			return;
		}
		const spent =
			failure.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' ||
			failure.code === 'INVALID_TWO_FACTOR_COOKIE' ||
			failure.status === 429;
		challengeSpent = spent;
		const hint =
			failure.retryAfter !== null
				? ` Try again in ${failure.retryAfter} ${failure.retryAfter === 1 ? 'second' : 'seconds'}.`
				: '';
		passkeyError = `${failure.message}${hint}`;
		if (!spent) void tick().then(() => codeInput?.focus());
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
					{#if step === 'second-factor'}
						<p class="eyebrow">Two steps · 2 of 2</p>
						<h1>Enter your {useRecovery ? 'recovery code' : 'authenticator code'}</h1>
						<p class="login-lede">
							{#if challengeSpent}
								This sign-in challenge was used up. Start again with
								{firstFactor === 'password' ? 'the password' : 'the passkey'} to get a fresh one.
							{:else if useRecovery}
								One of the single-use codes saved when the authenticator was set up. Each one works
								once and cannot be reused.
							{:else}
								{firstFactor === 'password' ? 'The password was accepted.' : 'The passkey was accepted.'}
								One code from the authenticator app on this account finishes the sign-in.
							{/if}
						</p>

						<p class="step-done">
							<span class="step-tick" aria-hidden="true"><Icon name="check" size={12} /></span>
							{firstFactor === 'password' ? 'Password accepted' : 'Passkey accepted'}
						</p>

						{#if challengeSpent}
							{#if passkeyError}
								<div class="login-error"><Notice tone="danger">{passkeyError}</Notice></div>
							{/if}
							<button
								type="button"
								class="btn btn-primary btn-wide login-submit"
								onclick={() => void startOver()}
							>
								{#if firstFactor === 'password'}
									<Icon name="key" size={15} /> Start again with the password
								{:else}
									<Icon name="fingerprint" size={15} /> Start again with the passkey
								{/if}
							</button>
						{:else}
							<form onsubmit={submitCode} novalidate>
								<div class="field">
									<label class="label" for="second-factor">
										{useRecovery ? 'Recovery code' : 'Authenticator code'}
									</label>
									<input
										bind:this={codeInput}
										id="second-factor"
										class="input input-mono code-field"
										class:is-recovery={useRecovery}
										inputmode={useRecovery ? 'text' : 'numeric'}
										autocomplete="one-time-code"
										autocapitalize="none"
										autocorrect="off"
										spellcheck="false"
										maxlength={useRecovery ? 11 : 6}
										placeholder={useRecovery ? 'abcde-fghij' : '000000'}
										disabled={passkeyBusy}
										aria-invalid={passkeyError ? 'true' : undefined}
										aria-describedby="second-factor-hint"
									/>
									<p id="second-factor-hint" class="hint">
										{useRecovery
											? 'Each recovery code signs you in once. Copy it exactly as saved, dash included.'
											: 'The 6-digit code from the authenticator app, which changes every 30 seconds.'}
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
										if (codeInput) codeInput.value = '';
										await tick();
										codeInput?.focus();
									}}
								>
									{useRecovery ? 'Use the authenticator instead' : 'Use a recovery code instead'}
								</button>
							</form>
						{/if}

						{#if !challengeSpent}
							<p class="login-note">
								<span class="note-icon"><Icon name="shield" size={13} /></span>
								<span>
									{useRecovery
										? 'Codes are replaced, not topped up: when the set runs low, make a new one from Sign-in security.'
										: 'Five wrong codes end this sign-in; the first step starts a fresh one.'}
								</span>
							</p>
						{/if}
					{:else if step === 'password'}
						<p class="eyebrow">Operator access</p>
						<h1>Sign in with a password</h1>
						<p class="login-lede">
							The address and password on this account. This browser runs the key derivation
							first; the password itself is not sent.
						</p>

						<form onsubmit={passwordSignIn} novalidate>
							<div class="field">
								<label class="label" for="pw-email">Email</label>
								<input
									bind:this={pwEmailField}
									bind:value={pwEmail}
									id="pw-email"
									name="username"
									class="input"
									type="email"
									autocomplete="username"
									autocapitalize="none"
									autocorrect="off"
									spellcheck="false"
									placeholder="you@example.com"
									disabled={pwBusy}
									aria-describedby="pw-email-hint"
								/>
								<p id="pw-email-hint" class="hint">The address this account was invited with.</p>
							</div>

							<div class="field">
								<label class="label" for="pw-secret">Password</label>
								<div class="input-row">
									<input
										bind:this={pwPasswordField}
										bind:value={pwPassword}
										id="pw-secret"
										name="current-password"
										class="input"
										type={pwShow ? 'text' : 'password'}
										autocomplete="current-password"
										autocapitalize="off"
										autocorrect="off"
										spellcheck="false"
										disabled={pwBusy}
										aria-invalid={pwError ? 'true' : undefined}
										aria-describedby="pw-secret-hint"
									/>
									<button
										type="button"
										class="btn btn-sm show-btn"
										onclick={() => (pwShow = !pwShow)}
										aria-pressed={pwShow}
										aria-label={pwShow ? 'Hide the password' : 'Show the password'}
									>
										{pwShow ? 'Hide' : 'Show'}
									</button>
								</div>
								<p id="pw-secret-hint" class="hint">
									8 to 128 characters. Paste from a password manager as usual.
								</p>
							</div>

							{#if pwError}
								<div class="login-error"><Notice tone="danger">{pwError}</Notice></div>
							{/if}

							<button
								type="submit"
								class="btn btn-primary btn-wide login-submit"
								disabled={pwBusy}
								aria-busy={pwBusy}
							>
								{#if pwBusy}<Spinner />{:else}<Icon name="key" size={15} />{/if}
								{pwBusy ? 'Deriving and checking' : 'Sign in'}
							</button>

							<button
								type="button"
								class="link-btn login-alternate"
								onclick={() => void backToPasskey()}
								disabled={pwBusy}
							>
								Use a passkey instead
							</button>
						</form>

						<p class="login-note">
							<span class="note-icon"><Icon name="shield" size={13} /></span>
							<span>
								A wrong password and an address with no account get the same answer, on purpose.
								Only an HttpOnly, SameSite=Strict session cookie is kept.
							</span>
						</p>
					{:else}
						<p class="eyebrow">Operator access</p>
						<h1>Sign in to the console</h1>
						<p class="login-lede">
							This deployment signs in with a passkey. The key stays on this device.
						</p>

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

						<!--
							The password factor, offered under the passkey rather than beside it:
							the passkey is the first factor, and this is the fallback for an
							account that has one. A deployment whose mode is `off` (or whose
							pepper is missing) never renders this.
						-->
						{#if passwordAvailable !== 'off'}
							<div class="login-alt">
								<span class="login-alt-rule" aria-hidden="true"></span>
								<button
									type="button"
									class="btn btn-wide"
									onclick={() => void openPasswordDoor()}
									disabled={passwordCheck === 'checking' || passkeyBusy}
									aria-busy={passwordCheck === 'checking'}
								>
									{#if passwordCheck === 'checking'}
										<Spinner />
									{:else}
										<Icon name="key" size={15} />
									{/if}
									{passwordCheck === 'checking'
										? 'Checking this deployment'
										: 'Use a password instead'}
								</button>
							</div>
						{/if}

						{#if passwordRefused}
							<div class="login-error"><Notice tone="info">{passwordRefused}</Notice></div>
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
									{#if passwordAvailable === 'off'}
										A passkey is the only way into an account on this deployment. If the device
										holding it is gone, an owner has to help: there is no password to reset.
									{:else}
										A passkey is the first way in. If the device holding it is gone, an account with
										a password can use that instead; one without it needs an owner to help.
									{/if}
								</p>
								<p>
									Two-factor on the account? After the first step the console asks for an
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
								<!--
									The same door as on the passkey screen. This is the screen a real
									deployment lands on — health is admin-gated, so the mode is usually
									unreadable before sign-in — and an account whose only way in is a
									password must not have to press "passkey" to find it.
								-->
								{#if passwordAvailable !== 'off'}
									<button
										type="button"
										class="btn btn-wide"
										onclick={() => {
											gate = { kind: 'new' };
											void tick().then(() => openPasswordDoor());
										}}
									>
										<Icon name="key" size={15} /> Use a password instead
									</button>
								{/if}
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

	/* Two stacked fields need air between them: the first one's hint otherwise
	   sits on top of the second one's label. */
	form .field + .field {
		margin-top: var(--s-4);
	}

	.login-submit + .login-error {
		margin-top: var(--s-3);
	}

	.login-alternate {
		display: block;
		margin: var(--s-3) auto 0;
		font-size: 12px;
	}

	/* Step one is finished and nothing else can undo it; the line is a receipt,
	   not a control. */
	.step-done {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: calc(var(--s-2) * -1);
		margin-bottom: var(--s-4);
		color: var(--ink-3);
		font-size: 11.5px;
	}

	.step-tick {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--ok) 14%, transparent);
		color: var(--ok);
	}

	.code-field {
		letter-spacing: 0.2em;
		text-align: center;
		min-height: 44px;
		font-size: var(--text-md);
	}

	@media (max-width: 720px) {
		/* A code is typed with a thumb and the submit finishes the whole
		   sign-in: both get the 48dp target on a phone. The password fields and
		   the two door buttons are the same kind of control. */
		.code-field,
		.login-submit,
		.login-body form .input,
		.login-alt .btn,
		.login-alternate {
			min-height: 48px;
		}
	}

	/* A recovery code is read character by character against something saved on
	   paper: wide tracking makes that harder, not easier. */
	.code-field.is-recovery {
		letter-spacing: 0.06em;
		font-size: var(--text-base);
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
