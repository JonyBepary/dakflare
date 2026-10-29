<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { describeError } from '$lib/api';
	import { formatDate } from '$lib/format';
	import { listPasskeys } from '$lib/passkey';
	import { ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import {
		beginEnrolment,
		cleanCode,
		confirmEnrolment,
		disableTotp,
		isWellFormedCode,
		probeTotp,
		regenerateRecoveryCodes,
		type TotpEnrolment,
		type TotpProbe
	} from '$lib/totp';
	import type { PasskeySummary } from '$lib/types';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import QrCode from '$lib/components/QrCode.svelte';
	import RecoveryCodes from '$lib/components/RecoveryCodes.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';

	/*
	 * The account's factors, in the order AUTH_PLAN §1 asks for them. The passkey
	 * is the first factor and is read-only here; the authenticator is factor 3,
	 * optional, and the recovery codes are what makes it useful when the device
	 * holding the passkey is gone.
	 *
	 * Nothing on this page is assumed. `probeTotp()` asks the mount whether the
	 * two-factor routes exist at all, so an older Worker gets a sentence instead
	 * of a button that answers 404.
	 */

	let allowed = $derived(session.canManageFactors);

	/** `null` until the probe answers; the page never guesses a state. */
	let probe = $state<TotpProbe | null>(null);
	let checking = $state(true);
	let failure = $state<string | null>(null);
	let ended = $state<string | null>(null);

	/** Enrolment, from the moment the secret exists to the code being accepted. */
	let enrolment = $state<TotpEnrolment | null>(null);
	let enrolCode = $state('');
	let enrolling = $state(false);
	let enrolError = $state<string | null>(null);

	/** The one-time reveal, right after enabling or after a regenerate. */
	let freshCodes = $state<string[] | null>(null);
	let codesHeading = $state('Save these recovery codes');

	/** Turning the factor off. A current code is required, always. */
	let showDisable = $state(false);
	let disableCode = $state('');
	let disableError = $state<string | null>(null);
	let disabling = $state(false);

	let regenerating = $state(false);
	let confirmRegenerate = $state(false);
	let regenerateError = $state<string | null>(null);

	let passkeys = $state<PasskeySummary[] | null>(null);
	let codeField = $state<HTMLInputElement | null>(null);
	let disableField = $state<HTMLInputElement | null>(null);

	const unsupported: Record<
		'missing' | 'no-secret' | 'disabled' | 'password',
		{ title: string; body: string; fix: string | null }
	> = {
		missing: {
			title: 'This deployment has no authenticator support',
			body: 'The gateway answered that the two-factor routes are not mounted, so there is nowhere to store a secret. Nothing on this account is affected; codes simply cannot be set up here.',
			fix: 'The gateway needs the two-factor plugin in its auth configuration. Until then, the passkey is the only factor.'
		},
		'no-secret': {
			title: 'Two-factor is switched off on this deployment',
			body: 'The auth mount answers 503 because the Worker has no signing secret yet. A TOTP secret is encrypted with that secret, so nothing can be stored until it is set.',
			fix: 'wrangler secret put BETTER_AUTH_SECRET'
		},
		disabled: {
			title: 'Authenticator codes are disabled here',
			body: 'The two-factor plugin is mounted but TOTP is switched off in its options, so the endpoint refused the request.',
			fix: null
		},
		password: {
			title: 'The gateway asked for a password this account does not have',
			body: 'Enrolling an authenticator needs the Worker to allow passwordless two-factor. It refused because the deployment expects a password step, and accounts here are passkey-only.',
			fix: null
		}
	};

	const enabled = $derived(probe?.kind === 'on');
	const unavailableCopy = $derived(
		probe?.kind === 'unavailable' ? unsupported[probe.reason] : null
	);
	const probeError = $derived(probe?.kind === 'error' ? probe.message : null);

	onMount(() => {
		void load();
	});

	async function load(): Promise<void> {
		if (!allowed) {
			checking = false;
			return;
		}
		checking = true;
		failure = null;
		probe = await probeTotp();
		if (probe.kind === 'error') failure = probe.message;
		checking = false;
		try {
			passkeys = await listPasskeys();
		} catch {
			// The list is context, not the point of the page: a failure here
			// leaves the counts unknown rather than blocking the factor controls.
			passkeys = null;
		}
	}

	async function startEnrolment(): Promise<void> {
		if (enrolling) return;
		enrolling = true;
		enrolError = null;
		ended = null;
		freshCodes = null;
		try {
			enrolment = await beginEnrolment();
			enrolCode = '';
			await tick();
			codeField?.focus();
		} catch (error) {
			enrolError = describeError(error);
		} finally {
			enrolling = false;
		}
	}

	function cancelEnrolment(): void {
		enrolment = null;
		enrolCode = '';
		enrolError = null;
	}

	async function enableTotp(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (enrolment === null || enrolling) return;
		const code = cleanCode(enrolCode);
		if (!isWellFormedCode(code, false)) {
			enrolError = 'Enter the six digits the authenticator is showing right now.';
			codeField?.focus();
			return;
		}
		enrolling = true;
		enrolError = null;
		try {
			await confirmEnrolment(code);
			probe = { kind: 'on' };
			freshCodes = enrolment.backupCodes;
			codesHeading = 'Save these recovery codes';
			enrolment = null;
			enrolCode = '';
			await tick();
			const reveal = document.getElementById('recovery-codes-title');
			reveal?.setAttribute('tabindex', '-1');
			reveal?.focus({ preventScroll: true });
			reveal?.scrollIntoView({
				block: 'center',
				behavior: prefersReducedMotion() ? 'auto' : 'smooth'
			});
		} catch (error) {
			// A wrong code does not enable anything: the row stays unverified and
			// the secret in `enrolment` stays valid for the next attempt.
			enrolError = describeError(error);
			enrolCode = '';
			await revealError('enrol-error', codeField);
		} finally {
			enrolling = false;
		}
	}

	async function turnOff(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (disabling) return;
		const code = cleanCode(disableCode);
		if (!isWellFormedCode(code, false)) {
			disableError = 'Enter the six digits the authenticator is showing right now.';
			disableField?.focus();
			return;
		}
		disabling = true;
		disableError = null;
		try {
			await disableTotp(code);
			probe = { kind: 'off' };
			showDisable = false;
			disableCode = '';
			freshCodes = null;
			ended = 'The authenticator was turned off. The passkey is now the only factor on this account.';
		} catch (error) {
			disableError = describeError(error);
			disableCode = '';
			await revealError('disable-error', disableField);
		} finally {
			disabling = false;
		}
	}

	async function replaceCodes(): Promise<void> {
		regenerating = true;
		regenerateError = null;
		try {
			freshCodes = await regenerateRecoveryCodes();
			codesHeading = 'Your new recovery codes';
			confirmRegenerate = false;
			ended = null;
			await tick();
			const reveal = document.getElementById('recovery-codes-title');
			reveal?.setAttribute('tabindex', '-1');
			reveal?.focus({ preventScroll: true });
			reveal?.scrollIntoView({
				block: 'center',
				behavior: prefersReducedMotion() ? 'auto' : 'smooth'
			});
		} catch (error) {
			regenerateError = describeError(error);
		} finally {
			regenerating = false;
		}
	}

	function closeCodes(): void {
		freshCodes = null;
	}

	/**
	 * A refused code has to be seen. The form sits at the bottom of a long card,
	 * so the notice is brought into view rather than left under the fold; the
	 * field keeps the caret with `preventScroll` so the two do not fight.
	 */
	async function revealError(id: string, field: HTMLInputElement | null): Promise<void> {
		await tick();
		field?.focus({ preventScroll: true });
		document.getElementById(id)?.scrollIntoView({
			block: 'center',
			behavior: prefersReducedMotion() ? 'auto' : 'smooth'
		});
	}

	function prefersReducedMotion(): boolean {
		return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}
</script>

<svelte:head>
	<title>Sign-in and recovery · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Security"
		title="Sign-in and recovery"
		description="How this account proves who it is. A passkey is the first factor; an authenticator code is asked after it, and recovery codes are the way back in when the device holding the passkey is gone."
	>
		{#if allowed && !checking}
			<button
				type="button"
				class="btn"
				onclick={() => void load()}
				disabled={enrolling || disabling || regenerating || enrolment !== null}
			>
				<Icon name="refresh" size={14} /> Check again
			</button>
		{/if}
	</PageHeader>

	{#if !allowed}
		<section class="card">
			<EmptyState
				icon="shield"
				title="Sign-in settings are for owners and admins"
				description="Your account is a member. Ask an owner if a factor needs to change."
			>
				<a class="btn btn-primary" href={ROUTES.overview}>Back to overview</a>
			</EmptyState>
		</section>
	{:else if session.authMode !== 'new'}
		<section class="card">
			<EmptyState
				icon="key"
				title="This session is the admin token"
				description="A token has no account behind it, so there is no passkey to pair a second factor with. Sign in with an account to manage sign-in there."
			>
				<a class="btn" href={ROUTES.login}>Sign-in screen</a>
			</EmptyState>
		</section>
	{:else}
		{#if ended}
			<div class="page-note"><Notice tone="ok">{ended}</Notice></div>
		{/if}

		<section class="card factor-card" id="passkey-card">
			<header class="factor-head">
				<div class="factor-title">
					<span class="step-mark mono" aria-hidden="true">01</span>
					<div>
						<h2>Passkey</h2>
						<p class="factor-lede">
							The first factor, and the one this console opens with. It stays on the device.
						</p>
					</div>
				</div>
				<span class="chip" data-tone={passkeys && passkeys.length > 0 ? 'ok' : 'warn'}>
					{#if passkeys === null}
						unknown
					{:else if passkeys.length === 0}
						none
					{:else}
						{passkeys.length} {passkeys.length === 1 ? 'passkey' : 'passkeys'}
					{/if}
				</span>
			</header>

			{#if passkeys === null}
				<p class="hint">The passkey list could not be read. The factor itself is unaffected.</p>
			{:else if passkeys.length === 0}
				<p class="hint">
					This account has no passkey listed. If sign-in still works, the key was made on this
					deployment before the list was readable; if it does not, ask an owner for a new invite.
				</p>
			{:else}
				<ul class="passkeys">
					{#each passkeys as passkey (passkey.id)}
						<li>
							<span class="passkey-name">{passkey.name ?? 'Unnamed passkey'}</span>
							<span class="passkey-date mono">{formatDate(Date.parse(passkey.createdAt))}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="card factor-card" id="totp-card" aria-labelledby="totp-title">
			<header class="factor-head">
				<div class="factor-title">
					<span class="step-mark mono" aria-hidden="true">02</span>
					<div>
						<h2 id="totp-title">Authenticator app</h2>
						<p class="factor-lede">
							A 6-digit code from an app on your phone, asked for after the passkey.
						</p>
					</div>
				</div>
				{#if checking}
					<span class="chip" data-tone="muted"><Spinner /> checking</span>
				{:else if enabled}
					<span class="chip" data-tone="ok">On</span>
				{:else if probe?.kind === 'unavailable'}
					<span class="chip" data-tone="muted">unavailable</span>
				{:else if probe?.kind === 'signed-out'}
					<span class="chip" data-tone="muted">signed out</span>
				{:else}
					<span class="chip" data-tone="muted">Off</span>
				{/if}
			</header>

			{#if checking}
				<div class="factor-body" aria-busy="true" aria-live="polite">
					<span class="sr-only">Checking whether this deployment supports authenticator codes</span>
					<div class="skeleton" style="height: 14px; width: 62%"></div>
					<div class="skeleton" style="height: 14px; width: 44%; margin-top: 10px"></div>
				</div>
			{:else if unavailableCopy}
				<div class="factor-body">
					<Notice tone="warn" title={unavailableCopy.title}>{unavailableCopy.body}</Notice>
					{#if unavailableCopy.fix}
						{#if unavailableCopy.fix.startsWith('wrangler')}
							<div class="command">
								<code>{unavailableCopy.fix}</code>
								<CopyButton value={unavailableCopy.fix} iconOnly label="Copy command" />
							</div>
						{:else}
							<p class="hint">{unavailableCopy.fix}</p>
						{/if}
					{/if}
				</div>
			{:else if probe?.kind === 'signed-out'}
				<div class="factor-body">
					<Notice tone="warn" title="The account session has expired">
						The authenticator state is read from the signed-in account. Sign in again to see it;
						the factor itself has not changed.
					</Notice>
					<a class="btn btn-sm" href={ROUTES.login} style="margin-top: 12px">Sign in again</a>
				</div>
			{:else if probeError}
				<div class="factor-body">
					<Notice tone="danger" title="The gateway did not answer">
						{failure ?? probeError}
					</Notice>
					<button type="button" class="btn btn-sm" onclick={() => void load()} style="margin-top: 12px">
						<Icon name="refresh" size={13} /> Try again
					</button>
				</div>
			{:else if enrolment !== null}
				<div class="factor-body enrol">
					<p class="hint enrol-intro">
						Scan the code with an authenticator app, or type the key in by hand. The app then shows
						a 6-digit code every 30 seconds.
					</p>
					<div class="enrol-grid">
						<div class="enrol-qr">
							<QrCode
								value={enrolment.uri}
								size={176}
								label="Authenticator setup code for this account"
								caption="Scan with the authenticator app"
							/>
						</div>
						<div class="enrol-manual">
							<p class="label">Key for manual entry</p>
							<div class="secret">
								<code class="secret-value mono">{enrolment.secret}</code>
								<CopyButton value={enrolment.secret} iconOnly label="Copy the setup key" />
							</div>
							<p class="hint">
								Time based, 6 digits, 30-second window. Issuer <span class="mono">DakFlare</span>.
							</p>
							<a class="enrol-link" href={enrolment.uri}>
								<Icon name="arrow-up-right" size={13} /> Open in an authenticator app
							</a>
						</div>
					</div>

					<form class="enrol-confirm" onsubmit={enableTotp} novalidate>
						<div class="field">
							<label class="label" for="enrol-code">Code from the app</label>
							<div class="input-row">
								<input
									bind:this={codeField}
									bind:value={enrolCode}
									id="enrol-code"
									class="input input-mono code-input"
									inputmode="numeric"
									autocomplete="one-time-code"
									pattern="[0-9]*"
									maxlength="6"
									placeholder="000000"
									spellcheck="false"
									disabled={enrolling}
									aria-invalid={enrolError ? 'true' : undefined}
									aria-describedby="enrol-code-hint"
									oninput={(event) => {
										enrolCode = event.currentTarget.value.replace(/[^0-9]/g, '').slice(0, 6);
									}}
								/>
								<button
									type="submit"
									class="btn btn-primary"
									disabled={enrolling || enrolCode.length !== 6}
									aria-busy={enrolling}
								>
									{#if enrolling}<Spinner />{:else}<Icon name="check" size={14} />{/if}
									{enrolling ? 'Checking' : 'Turn on'}
								</button>
							</div>
							<p id="enrol-code-hint" class="hint">
								Nothing is enabled until this code is accepted. The secret is not stored by this
								browser.
							</p>
						</div>

						{#if enrolError}
							<div class="field-error-note" id="enrol-error">
								<Notice tone="danger">{enrolError}</Notice>
							</div>
						{/if}

						<button type="button" class="link-btn enrol-cancel" onclick={cancelEnrolment}>
							Cancel setup
						</button>
					</form>
				</div>
			{:else if enabled}
				<div class="factor-body">
					<div class="state-line">
						<p>
							On. After the passkey is accepted, the console asks for a code from this account's
							authenticator before the console opens.
						</p>
					</div>
					<div class="factor-actions">
						<button
							type="button"
							class="btn btn-sm btn-danger"
							onclick={async () => {
								showDisable = !showDisable;
								disableError = null;
								disableCode = '';
								await tick();
								disableField?.focus();
							}}
							aria-expanded={showDisable}
							aria-controls="disable-form"
						>
							<Icon name="trash" size={13} /> Turn off
						</button>
					</div>

					{#if showDisable}
						<form id="disable-form" class="disable-form" onsubmit={turnOff} novalidate>
							<div class="field">
								<label class="label" for="disable-code">Confirm with a current code</label>
								<input
									bind:this={disableField}
									bind:value={disableCode}
									id="disable-code"
									class="input input-mono code-input"
									inputmode="numeric"
									autocomplete="one-time-code"
									pattern="[0-9]*"
									maxlength="6"
									placeholder="000000"
									spellcheck="false"
									disabled={disabling}
									aria-invalid={disableError ? 'true' : undefined}
									aria-describedby="disable-hint"
									oninput={(event) => {
										disableCode = event.currentTarget.value.replace(/[^0-9]/g, '').slice(0, 6);
									}}
								/>
								<p id="disable-hint" class="hint">
									Turning the authenticator off removes the code step and deletes the stored secret
									and the recovery codes with it. The passkey then becomes the only way in: if its
									device is lost, an owner has to help.
								</p>
							</div>
							{#if disableError}
								<div class="field-error-note" id="disable-error">
									<Notice tone="danger">{disableError}</Notice>
								</div>
							{/if}
							<div class="disable-actions">
								<button
									type="submit"
									class="btn btn-danger-solid btn-sm"
									disabled={disabling || disableCode.length !== 6}
									aria-busy={disabling}
								>
									{#if disabling}<Spinner />{:else}<Icon name="trash" size={13} />{/if}
									{disabling ? 'Turning off' : 'Turn off two-factor'}
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-sm"
									onclick={() => {
										showDisable = false;
										disableError = null;
										disableCode = '';
									}}
								>
									Keep it on
								</button>
							</div>
						</form>
					{/if}
				</div>
			{:else}
				<div class="factor-body">
					<p class="state-line">
						Off. Anyone holding a passkey for this account signs in with it alone; there is no
						second step. Turning it on takes two minutes and one code from an app.
					</p>
					{#if enrolError}
						<div class="field-error-note"><Notice tone="danger">{enrolError}</Notice></div>
					{/if}
					<div class="factor-actions">
						<button
							type="button"
							class="btn btn-primary btn-sm"
							onclick={() => void startEnrolment()}
							disabled={enrolling}
							aria-busy={enrolling}
						>
							{#if enrolling}<Spinner />{:else}<Icon name="shield" size={14} />{/if}
							{enrolling ? 'Making a secret' : 'Set up an authenticator'}
						</button>
					</div>
					<p class="hint">
						The secret is made by the gateway, shown once, and kept encrypted with the Worker's auth
						secret.
					</p>
				</div>
			{/if}
		</section>

		{#if enabled}
			<section class="card factor-card" id="codes-card" aria-labelledby="recovery-title">
				<header class="factor-head">
					<div class="factor-title">
						<span class="step-mark mono" aria-hidden="true">03</span>
						<div>
							<h2 id="recovery-title">Recovery codes</h2>
							{#if freshCodes === null}
								<p class="factor-lede">
									Ten single-use codes that stand in for the authenticator, and the only way back
									in if the passkey device is lost.
								</p>
							{/if}
						</div>
					</div>
					<span class="chip" data-tone="info">1 use each</span>
				</header>

				<div class="factor-body">
					{#if freshCodes !== null}
						<RecoveryCodes
							codes={freshCodes}
							account={session.email}
							heading={codesHeading}
							ondone={closeCodes}
						/>
					{:else}
						<p class="state-line">
							The set made when the authenticator was turned on is the only one that works right
							now. It cannot be read back: replacing it here makes ten new codes and stops every old
							one immediately.
						</p>
						{#if regenerateError}
							<div class="field-error-note"><Notice tone="danger">{regenerateError}</Notice></div>
						{/if}
						<div class="factor-actions">
							<button
								type="button"
								class="btn btn-sm"
								onclick={() => {
									regenerateError = null;
									confirmRegenerate = true;
								}}
								disabled={regenerating || disabling}
							>
								<Icon name="refresh" size={13} /> Replace the codes
							</button>
						</div>
					{/if}
				</div>
			</section>
		{/if}
	{/if}
</div>

<ConfirmDialog
	open={confirmRegenerate}
	title="Replace the recovery codes?"
	confirmLabel="Replace them"
	tone="danger"
	pending={regenerating}
	error={regenerateError}
	onconfirm={() => void replaceCodes()}
	oncancel={() => {
		confirmRegenerate = false;
		regenerateError = null;
	}}
>
	<p>
		The ten codes you have now stop working the moment the new set is made. The new set is shown
		once, here, and cannot be read later.
	</p>
	<p style="margin-top: 8px">
		Do this only if the old codes were lost or may have been seen by someone else.
	</p>
</ConfirmDialog>

<style>
	.page-note {
		margin-bottom: var(--s-4);
	}

	.factor-card + .factor-card {
		margin-top: var(--s-4);
	}

	/* Scrolling a card to the top of the viewport must not tuck it under the
	   sticky header, or under the tabs the phone adds below it. */
	.factor-card {
		scroll-margin-top: calc(var(--df-c-shell-header) + 12px);
	}

	@media (max-width: 900px) {
		.factor-card {
			scroll-margin-top: calc(var(--df-c-shell-header) + var(--df-c-shell-tabs) + 12px);
		}
	}

	.factor-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--s-3);
		min-width: 0;
	}

	.factor-title {
		display: flex;
		gap: var(--s-3);
		min-width: 0;
	}

	/* A number, not a badge: it orders the factors the way the plan lists them
	   and gives the three cards one shared left edge. */
	.step-mark {
		flex: none;
		padding-top: 3px;
		font-size: 10px;
		letter-spacing: 0.1em;
		color: var(--ink-3);
	}

	.factor-head h2 {
		font-family: var(--df-font-display);
		font-size: var(--text-md);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.factor-lede {
		margin-top: 3px;
		max-width: 58ch;
		color: var(--ink-3);
		font-size: var(--text-sm);
		line-height: 1.5;
	}

	.factor-body {
		margin-top: var(--s-4);
		padding-top: var(--s-4);
		border-top: 1px solid var(--line);
	}

	/* A notice's sentence should not run the whole width of a 1000px card. */
	.factor-body :global(.callout > div) {
		max-width: 76ch;
	}

	.factor-card .hint {
		max-width: 78ch;
	}

	.state-line {
		max-width: 66ch;
		color: var(--ink-2);
		font-size: var(--text-base);
		line-height: 1.55;
	}

	.factor-actions {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: var(--s-3);
	}

	.passkeys {
		margin-top: var(--s-3);
		list-style: none;
		border-top: 1px solid var(--line);
	}

	.passkeys li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--s-3);
		padding: 8px 0;
		border-bottom: 1px solid var(--line);
		font-size: var(--text-sm);
	}

	.passkey-name {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.passkey-date {
		flex: none;
		font-size: 10.5px;
		color: var(--ink-3);
	}

	/* ------------------------------------------------------------- enrolment */

	.enrol-intro {
		max-width: 62ch;
		margin-bottom: var(--s-3);
	}

	.enrol-grid {
		display: flex;
		gap: var(--s-4);
		align-items: flex-start;
		flex-wrap: wrap;
	}

	.enrol-qr {
		flex: none;
	}

	.enrol-manual {
		flex: 1 1 240px;
		min-width: 0;
	}

	.secret {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin: 6px 0 8px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--df-surface-well);
	}

	.secret-value {
		flex: 1;
		min-width: 0;
		font-size: var(--text-sm);
		letter-spacing: 0.08em;
		overflow-wrap: anywhere;
		user-select: all;
	}

	.enrol-link {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 32px;
		margin-top: 4px;
		font-size: var(--text-sm);
		color: var(--accent);
	}

	.enrol-confirm {
		margin-top: var(--s-3);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
	}

	.code-input {
		max-width: 168px;
		letter-spacing: 0.24em;
		text-align: center;
		font-size: var(--text-md);
	}

	.enrol-cancel {
		display: block;
		margin-top: var(--s-3);
		font-size: 12px;
	}

	.field-error-note {
		margin-top: var(--s-3);
	}

	.command {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		margin-top: var(--s-3);
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
	}

	.disable-form {
		margin-top: var(--s-3);
		padding: var(--s-3);
		border: 1px solid color-mix(in srgb, var(--danger) 28%, var(--line));
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--danger) 4%, var(--surface));
	}

	.disable-actions {
		display: flex;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: var(--s-3);
	}

	@media (max-width: 720px) {
		.factor-card {
			padding: var(--s-4);
		}

		.factor-head {
			flex-direction: column;
			gap: var(--s-2);
		}

		.enrol-grid {
			flex-direction: column;
			align-items: stretch;
			gap: var(--s-3);
		}

		/* `flex: 1 1 240px` is a height basis once the grid turns into a column:
		   the manual-entry block would be 240px tall whatever it holds. */
		.enrol-manual {
			flex: none;
		}

		.enrol-qr {
			align-self: center;
		}

		/* 48dp on a phone: a code field is typed into with a thumb, and these
		   buttons change a factor. The shared shell buttons keep the system's
		   44px mobile target; the taller ones here are only the thumb-critical
		   controls of this page. */
		.code-input {
			max-width: none;
			min-height: 48px;
			font-size: var(--text-md);
		}

		.enrol-link {
			min-height: 48px;
		}

		.factor-actions .btn,
		.disable-actions .btn {
			min-height: 48px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.factor-card {
			transition: none;
		}
	}
</style>
