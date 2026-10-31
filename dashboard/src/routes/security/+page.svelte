<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ApiError, describeError, getHealth, getInvites, revokeInvite } from '$lib/api';
	import { formatDate, formatRelative } from '$lib/format';
	import { currentTime, subscribeClock } from '$lib/live-clock.svelte';
	import { listPasskeys } from '$lib/passkey';
	import {
		checkPasswordLength,
		MAX_PASSWORD_LENGTH,
		MIN_PASSWORD_LENGTH,
		modeLabel,
		passwordIsSet,
		passwordStrength,
		readMode,
		removePassword,
		setPassword,
		toPasswordFailure,
		type PasswordFailure,
		type PasswordMode
	} from '$lib/password';
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
	import type { Invite, PasskeySummary } from '$lib/types';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import InviteMint from '$lib/components/InviteMint.svelte';
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
	 * Factor 4 is the password, and it is a deployment capability first: under
	 * `off` the card does not exist at all, because a factor that is switched off
	 * is not a disabled control — it is nothing to do here.
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
	let regenerateCode = $state('');

	let passkeys = $state<PasskeySummary[] | null>(null);
	let codeField = $state<HTMLInputElement | null>(null);
	let disableField = $state<HTMLInputElement | null>(null);

	/*
	 * Factor 4 — the password.
	 *
	 * `passwordMode` is the deployment's capability, read from health; `null` is
	 * "not answered yet" and is never rendered as `off`. `passwordSet` is this
	 * account's row, read from the linked-accounts list; `null` is "could not be
	 * read", shown as unknown rather than guessed.
	 */
	let passwordMode = $state<PasswordMode | null>(null);
	let pepperReady = $state<boolean | null>(null);
	let passwordSet = $state<boolean | null>(null);
	let passwordLoading = $state(true);
	let passwordReadError = $state<string | null>(null);

	/** The set/replace form. */
	let pwOpen = $state(false);
	let pwValue = $state('');
	let pwShow = $state(false);
	let pwSaving = $state(false);
	let pwError = $state<string | null>(null);
	let pwField = $state<HTMLInputElement | null>(null);

	/** Removal, which has to prove the factor it is removing. */
	let pwRemoveOpen = $state(false);
	let pwRemoveValue = $state('');
	let pwRemoveCode = $state('');
	let pwRemoveBusy = $state(false);
	let pwRemoveError = $state<string | null>(null);
	let pwProofField = $state<HTMLInputElement | null>(null);

	let pwNotice = $state<string | null>(null);

	/*
	 * Factor 05 — invites.
	 *
	 * An invite is the only door into this deployment (AUTH_PLAN §4), so the
	 * panel keeps the rules visible instead of relying on the operator to know
	 * them: single use, one address, and owner only from an owner. The token
	 * itself never enters this file — `InviteMint` owns it and drops it when its
	 * result panel closes.
	 */
	let invites = $state<Invite[] | null>(null);
	let invitesLoading = $state(true);
	let invitesError = $state<string | null>(null);
	let invitesNotice = $state<string | null>(null);
	/** A successful change reads as done; "already gone" is only information. */
	let invitesNoticeTone = $state<'ok' | 'info'>('ok');
	let mintOpen = $state(false);

	/** The gateway's clock, carried forward locally between answers. */
	let serverNow = $state(0);
	let fetchedAt = $state(0);

	let revokeTarget = $state<Invite | null>(null);
	let revoking = $state(false);
	let revokeError = $state<string | null>(null);

	const clock = $derived(currentTime());
	const inviteNow = $derived(serverNow === 0 ? clock : clock + (serverNow - fetchedAt));
	const openInvites = $derived(
		invites === null ? 0 : invites.filter((invite) => inviteState(invite, inviteNow) === 'open').length
	);
	const revokeExpired = $derived(
		revokeTarget !== null && inviteState(revokeTarget, inviteNow) !== 'open'
	);

	const pwStrength = $derived(passwordStrength(pwValue));
	const pwLengthError = $derived(pwValue === '' ? null : checkPasswordLength(pwValue));
	/** Under `off` the section is absent, not disabled. An unknown mode shows. */
	const pwVisible = $derived(passwordLoading || passwordMode !== 'off');
	/** A TOTP account proves removal with a code, not with the password. */
	const pwNeedsCode = $derived(probe?.kind === 'on');
	/**
	 * A UI rule, not a gateway one (`handlePasswordRemove` cannot see passkeys):
	 * removing the last way in would be an account without a first factor.
	 */
	const pwOnlyFactor = $derived(passkeys !== null && passkeys.length === 0);

	const unsupported: Record<
		'missing' | 'no-secret' | 'disabled',
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
		}
	};

	const enabled = $derived(probe?.kind === 'on');
	const unavailableCopy = $derived(
		probe?.kind === 'unavailable' ? unsupported[probe.reason] : null
	);
	const probeError = $derived(probe?.kind === 'error' ? probe.message : null);

	onMount(() => {
		void load();
		// One shared 30-second tick: an invite can expire while the page is open,
		// and its row should say so without a reload.
		return subscribeClock();
	});

	async function load(): Promise<void> {
		if (!allowed) {
			checking = false;
			passwordLoading = false;
			invitesLoading = false;
			return;
		}
		checking = true;
		failure = null;
		ended = null;
		pwNotice = null;
		invitesNotice = null;
		resetPasswordForms();
		probe = await probeTotp();
		if (probe.kind === 'error') failure = probe.message;
		await loadPassword();
		await loadInvites();
		checking = false;
		try {
			passkeys = await listPasskeys();
		} catch {
			// The list is context, not the point of the page: a failure here
			// leaves the counts unknown rather than blocking the factor controls.
			passkeys = null;
		}
	}

	/**
	 * Read the deployment's password mode and this account's row.
	 *
	 * Two questions, two sources, because they are different things: health knows
	 * whether the deployment has passwords at all, and the linked-accounts list
	 * knows whether this account holds one. Neither is inferred from the other.
	 */
	async function loadPassword(): Promise<void> {
		passwordLoading = true;
		passwordReadError = null;
		passwordSet = null;
		try {
			const { health } = await getHealth(true);
			passwordMode = readMode(health.password_mode);
			pepperReady = health.password_configured === true;
		} catch (error) {
			// The module answered for itself even if health did not: one of the
			// two unanswered means the card says so rather than inventing a mode.
			passwordMode = null;
			pepperReady = null;
			passwordReadError = describeError(error);
		}
		if (passwordMode !== null && passwordMode !== 'off') {
			passwordSet = await passwordIsSet();
		}
		passwordLoading = false;
	}

	function resetPasswordForms(): void {
		pwOpen = false;
		pwValue = '';
		pwShow = false;
		pwError = null;
		pwRemoveOpen = false;
		pwRemoveValue = '';
		pwRemoveCode = '';
		pwRemoveError = null;
	}

	/* ------------------------------------------------------------- invites */

	/**
	 * Open, used or expired — in that order of precedence.
	 *
	 * `used_at` wins over the expiry because a redeemed invite is spent even if
	 * its window has not closed; the row is a record, not an offer.
	 */
	function inviteState(invite: Invite, now: number): 'open' | 'used' | 'expired' {
		if (invite.used_at !== null) return 'used';
		return invite.expires_at > now ? 'open' : 'expired';
	}

	/**
	 * A relative age is useful while it is short; past a week the absolute date
	 * beside it is the better answer, so the second line is dropped rather than
	 * repeating the same day in two formats.
	 */
	function recentAge(at: number, now: number): string {
		return Math.abs(now - at) < 7 * 86_400_000 ? formatRelative(at, now) : '';
	}

	async function loadInvites(): Promise<void> {
		invitesLoading = true;
		invitesError = null;
		try {
			const data = await getInvites();
			invites = data.invites;
			// The gateway's clock decides "expired"; the local tick only carries it
			// forward, so a skewed browser clock cannot mark a live invite spent.
			serverNow = data.now;
			fetchedAt = Date.now();
		} catch (error) {
			// A member (or a demoted account) gets a 403 from the route; say which
			// rule refused it rather than "request failed".
			invitesError =
				error instanceof ApiError && error.status === 403
					? 'The invite list is for owners and admins, and the gateway refused it for this account. Ask an owner if an invite is needed.'
					: describeError(error);
			invites = null;
		} finally {
			invitesLoading = false;
		}
	}

	async function confirmRevoke(): Promise<void> {
		const target = revokeTarget;
		if (target === null || revoking) return;
		const wasOpen = inviteState(target, inviteNow) === 'open';
		revoking = true;
		revokeError = null;
		invitesNotice = null;
		try {
			await revokeInvite(target.id);
			revokeTarget = null;
			invitesNoticeTone = 'ok';
			invitesNotice = wasOpen
				? `The invite for ${target.email} was revoked. The link stops working now.`
				: `The row for ${target.email} was removed. The link had already expired.`;
			await loadInvites();
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				// Already deleted, possibly by the CLI: the list is the truth, so
				// close the dialog and ask it again rather than reporting a failure.
				revokeTarget = null;
				invitesNoticeTone = 'info';
				invitesNotice = 'That invite was already gone. The list has been refreshed.';
				await loadInvites();
			} else if (error instanceof ApiError && error.status === 403) {
				revokeError =
					'The gateway refused the revoke: this account may no longer be an owner or admin.';
			} else {
				revokeError = describeError(error);
			}
		} finally {
			revoking = false;
		}
	}

	function openMint(): void {
		invitesNotice = null;
		mintOpen = true;
	}

	async function openPasswordForm(): Promise<void> {
		pwOpen = true;
		pwError = null;
		pwNotice = null;
		pwValue = '';
		pwShow = false;
		await tick();
		pwField?.focus();
	}

	/**
	 * A refusal the operator has to read: bring the notice into view, keeping the
	 * caret where they were, the same way the authenticator forms do.
	 */
	async function applyPasswordFailure(error: unknown, where: 'set' | 'remove'): Promise<void> {
		const failure: PasswordFailure = toPasswordFailure(error, where === 'set' ? 'set' : 'remove');
		const message = failure.message;
		if (failure.kind === 'mode-changed' && failure.mode !== null) {
			// The deployment moved; the page's copy of the mode was stale. Trust the
			// refusal over the load, so the next attempt uses the right shape.
			passwordMode = failure.mode;
			if (failure.mode === 'off') passwordSet = null;
		}
		if (where === 'set') {
			pwError = message;
			if (failure.kind !== 'mode-changed') {
				pwValue = '';
				pwShow = false;
			}
			await revealError('pw-error', pwField);
			return;
		}
		pwRemoveError = message;
		pwRemoveValue = '';
		pwRemoveCode = '';
		await revealError('pw-remove-error', pwProofField);
	}

	async function savePassword(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (pwSaving || passwordMode === null || passwordMode === 'off') return;
		const email = session.email;
		if (email === null) {
			pwError = 'The signed-in account has no email on this session. Sign in again.';
			return;
		}
		const lengthProblem = checkPasswordLength(pwValue);
		if (lengthProblem !== null) {
			pwError = lengthProblem;
			pwField?.focus();
			return;
		}
		pwSaving = true;
		pwError = null;
		pwNotice = null;
		try {
			await setPassword({ mode: passwordMode, email, password: pwValue });
			passwordSet = true;
			pwOpen = false;
			pwValue = '';
			pwShow = false;
			pwNotice =
				passwordMode === 'client-derived'
					? 'The password is set. The key was derived in this browser; the password itself was never sent.'
					: 'The password is set. The gateway derived the key from it.';
		} catch (error) {
			await applyPasswordFailure(error, 'set');
		} finally {
			pwSaving = false;
		}
	}

	async function openRemoval(): Promise<void> {
		if (pwOnlyFactor) return;
		pwRemoveOpen = true;
		pwRemoveError = null;
		pwNotice = null;
		pwRemoveValue = '';
		pwRemoveCode = '';
		await tick();
		pwProofField?.focus();
	}

	async function removeThePassword(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (pwRemoveBusy || passwordMode === null || passwordMode === 'off') return;
		const email = session.email;
		if (email === null) {
			pwRemoveError = 'The signed-in account has no email on this session. Sign in again.';
			return;
		}

		if (pwNeedsCode) {
			const code = cleanCode(pwRemoveCode);
			if (!isWellFormedCode(code, false)) {
				pwRemoveError = 'Enter the six digits the authenticator is showing right now.';
				pwProofField?.focus();
				return;
			}
			pwRemoveBusy = true;
			pwRemoveError = null;
			try {
				await removePassword({ mode: passwordMode, email, code });
				finishRemoval();
			} catch (error) {
				await applyPasswordFailure(error, 'remove');
			} finally {
				pwRemoveBusy = false;
			}
			return;
		}

		if (pwRemoveValue === '') {
			pwRemoveError = 'Enter the password this account uses now.';
			pwProofField?.focus();
			return;
		}
		pwRemoveBusy = true;
		pwRemoveError = null;
		try {
			await removePassword({ mode: passwordMode, email, password: pwRemoveValue });
			finishRemoval();
		} catch (error) {
			await applyPasswordFailure(error, 'remove');
		} finally {
			pwRemoveBusy = false;
		}
	}

	function finishRemoval(): void {
		passwordSet = false;
		pwRemoveOpen = false;
		pwRemoveValue = '';
		pwRemoveCode = '';
		pwNotice =
			'The password was removed. The passkey is the way in; the authenticator, if it is on, still asks for its code.';
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
		const code = cleanCode(regenerateCode);
		if (!isWellFormedCode(code, false)) {
			regenerateError = 'Enter the six digits the authenticator is showing right now.';
			return;
		}
		regenerating = true;
		regenerateError = null;
		try {
			freshCodes = await regenerateRecoveryCodes(code);
			codesHeading = 'Your new recovery codes';
			confirmRegenerate = false;
			regenerateCode = '';
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
			regenerateCode = '';
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
						secret. Setting it up asks for your passkey first — a factor change is confirmed by the
						factor that is already on this account, never by a password.
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
									regenerateCode = '';
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

		{#if pwVisible}
			<section class="card factor-card" id="password-card" aria-labelledby="password-title">				<header class="factor-head">
					<div class="factor-title">
						<span class="step-mark mono" aria-hidden="true">04</span>
						<div>
							<h2 id="password-title">Password</h2>
							<p class="factor-lede">
								A way in that needs no passkey: a fallback for a device where the key is gone,
								or a browser that cannot use one.
							</p>
						</div>
					</div>
					{#if passwordLoading}
						<span class="chip" data-tone="muted"><Spinner /> checking</span>
					{:else if passwordMode === null}
						<span class="chip" data-tone="muted">unknown</span>
					{:else if pepperReady === false}
						<span class="chip" data-tone="warn">no pepper</span>
					{:else if passwordSet === null}
						<span class="chip" data-tone="muted">unknown</span>
					{:else if passwordSet}
						<span class="chip" data-tone="ok">set</span>
					{:else}
						<span class="chip" data-tone="muted">not set</span>
					{/if}
				</header>

				{#if passwordLoading}
					<div class="factor-body" aria-busy="true" aria-live="polite">
						<span class="sr-only">Reading this deployment's password mode</span>
						<div class="skeleton" style="height: 14px; width: 56%"></div>
						<div class="skeleton" style="height: 14px; width: 38%; margin-top: 10px"></div>
					</div>
				{:else if passwordMode === null}
					<div class="factor-body">
						<Notice tone="warn" title="The password mode could not be read">
							{passwordReadError ?? 'The gateway did not say which side runs the password key derivation, so nothing here is offered.'}
						</Notice>
						<button
							type="button"
							class="btn btn-sm"
							style="margin-top: 12px"
							onclick={() => void loadPassword()}
						>
							<Icon name="refresh" size={13} /> Read it again
						</button>
					</div>
				{:else if pepperReady === false}
					<div class="factor-body">
						<Notice tone="warn" title="The password pepper is not set">
							A password row is sealed with <code>AUTH_PEPPER</code>, and this deployment has none,
							so a password can be neither stored nor checked. The mode is on; the secret is missing.
						</Notice>
						<div class="command">
							<code>wrangler secret put AUTH_PEPPER</code>
							<CopyButton value="wrangler secret put AUTH_PEPPER" iconOnly label="Copy command" />
						</div>
					</div>
				{:else}
					<div class="factor-body">
						<p class="pw-mode">
							<span class="mode-tag mono">{passwordMode}</span>
							<span class="hint">
								{#if passwordMode === 'client-derived'}
									Passwords are {modeLabel(passwordMode)}: this browser runs PBKDF2 with the count
									the gateway reports, and only the derived key is sent. The free plan has the CPU
									for this and not for the alternative.
								{:else}
									Passwords are {modeLabel(passwordMode)}: each attempt costs the gateway a KDF, which
									is why this mode exists on paid plans. The password crosses the connection; the
									key derivation happens at the other end.
								{/if}
							</span>
						</p>

						{#if pwNotice}
							<div class="field-error-note pw-notice"><Notice tone="ok">{pwNotice}</Notice></div>
						{/if}

						<p class="state-line pw-state">
							{#if passwordSet === true}
								Set. This account can sign in with it where there is no passkey; the passkey stays
								the first choice and is asked for first.
							{:else if passwordSet === false}
								Not set. Signing in uses the passkey, and an authenticator code after it when that
								factor is on.
							{:else}
								This console could not read whether a password is set. Saving one sets it if it is
								missing and replaces it if it is not.
							{/if}
						</p>

						{#if !pwOpen && !pwRemoveOpen}
							<div class="factor-actions">
								<button
									type="button"
									class="btn btn-primary btn-sm"
									onclick={() => void openPasswordForm()}
									disabled={pwSaving || pwRemoveBusy}
								>
									<Icon name="key" size={14} />
									{passwordSet === true ? 'Replace the password' : 'Set a password'}
								</button>
								{#if passwordSet === true}
									<button
										type="button"
										class="btn btn-danger btn-sm"
										onclick={() => void openRemoval()}
										disabled={pwOnlyFactor || pwSaving || pwRemoveBusy}
										aria-expanded={pwRemoveOpen}
										aria-controls="pw-remove-form"
									>
										<Icon name="trash" size={13} /> Remove
									</button>
								{/if}
							</div>
							{#if passwordSet === true && pwOnlyFactor}
								<p class="hint pw-note pw-blocked">
									This account has no passkey listed, so the password is the only way in. Removing
									it would leave an account nobody can reach; add a passkey first.
								</p>
							{:else if passwordSet === true}
								<p class="hint pw-note">
									Replacing the password keeps the passkey and the authenticator as they are.
								</p>
							{/if}
						{/if}

						{#if pwOpen}
							<form class="pw-form" onsubmit={savePassword} novalidate>
								<div class="field">
									<label class="label" for="pw-new">New password</label>
									<div class="input-row">
										<input
											bind:this={pwField}
											bind:value={pwValue}
											id="pw-new"
											name="new-password"
											class="input"
											type={pwShow ? 'text' : 'password'}
											autocomplete="new-password"
											autocapitalize="off"
											autocorrect="off"
											spellcheck="false"
											minlength={MIN_PASSWORD_LENGTH}
											maxlength={MAX_PASSWORD_LENGTH}
											placeholder={`${MIN_PASSWORD_LENGTH} characters or more`}
											disabled={pwSaving}
											aria-invalid={pwError ? 'true' : undefined}
											aria-describedby="pw-new-hint"
										/>
										<button
											type="button"
											class="btn btn-sm pw-show"
											onclick={() => (pwShow = !pwShow)}
											aria-pressed={pwShow}
											aria-label={pwShow ? 'Hide the password' : 'Show the password'}
										>
											{pwShow ? 'Hide' : 'Show'}
										</button>
									</div>

									<div class="pw-strength" data-tone={pwStrength.tone} aria-hidden="true">
										{#each [1, 2, 3, 4] as segment (segment)}
											<span class="pw-seg" class:is-lit={pwStrength.score >= segment}></span>
										{/each}
									</div>
									<p id="pw-new-hint" class="hint pw-hint" aria-live="polite">
										<strong>{pwStrength.label}.</strong>
										{pwStrength.hint}
									</p>
									<p class="hint">
										Length is judged here, nothing else: a symbol makes a short password look better
										without making it harder to guess. Paste from a password manager as usual.
									</p>
								</div>

								{#if pwError}
									<div class="field-error-note" id="pw-error">
										<Notice tone="danger">{pwError}</Notice>
									</div>
								{/if}

								<div class="pw-actions">
									<button
										type="submit"
										class="btn btn-primary btn-sm"
										disabled={pwSaving || pwLengthError !== null || pwValue.length < MIN_PASSWORD_LENGTH}
										aria-busy={pwSaving}
									>
										{#if pwSaving}<Spinner />{:else}<Icon name="check" size={13} />{/if}
										{pwSaving
											? 'Deriving'
											: passwordSet === true
												? 'Replace it'
												: 'Save the password'}
									</button>
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										onclick={() => {
											pwOpen = false;
											pwError = null;
											pwValue = '';
											pwShow = false;
										}}
										disabled={pwSaving}
									>
										Cancel
									</button>
								</div>
							</form>
						{/if}

						{#if pwRemoveOpen}
							<form id="pw-remove-form" class="disable-form" onsubmit={removeThePassword} novalidate>
								{#if pwNeedsCode}
									<div class="field">
										<label class="label" for="pw-remove-code">Confirm with a current code</label>
										<input
											bind:this={pwProofField}
											bind:value={pwRemoveCode}
											id="pw-remove-code"
											class="input input-mono code-input"
											inputmode="numeric"
											autocomplete="one-time-code"
											pattern="[0-9]*"
											maxlength="6"
											placeholder="000000"
											spellcheck="false"
											disabled={pwRemoveBusy}
											aria-invalid={pwRemoveError ? 'true' : undefined}
											aria-describedby="pw-remove-hint"
											oninput={(event) => {
												pwRemoveCode = event.currentTarget.value.replace(/[^0-9]/g, '').slice(0, 6);
											}}
										/>
									</div>
								{:else}
									<div class="field">
										<label class="label" for="pw-remove-value">Confirm with the password</label>
										<input
											bind:this={pwProofField}
											bind:value={pwRemoveValue}
											id="pw-remove-value"
											name="current-password"
											class="input"
											type="password"
											autocomplete="current-password"
											spellcheck="false"
											disabled={pwRemoveBusy}
											aria-invalid={pwRemoveError ? 'true' : undefined}
											aria-describedby="pw-remove-hint"
										/>
									</div>
								{/if}

								<p id="pw-remove-hint" class="hint">
									Removing the password stops password sign-in on every device at once. The passkey
									and the authenticator are left untouched.
									{#if pwNeedsCode}
										A current authenticator code proves this is you; the password is not asked for
										while the authenticator is on.
									{:else}
										The password itself proves this is you.
									{/if}
								</p>

								{#if pwRemoveError}
									<div class="field-error-note" id="pw-remove-error">
										<Notice tone="danger">{pwRemoveError}</Notice>
									</div>
								{/if}

								<div class="disable-actions">
									<button
										type="submit"
										class="btn btn-danger-solid btn-sm"
										disabled={pwRemoveBusy ||
											(pwNeedsCode ? pwRemoveCode.length !== 6 : pwRemoveValue === '')}
										aria-busy={pwRemoveBusy}
									>
										{#if pwRemoveBusy}<Spinner />{:else}<Icon name="trash" size={13} />{/if}
										{pwRemoveBusy ? 'Removing' : 'Remove the password'}
									</button>
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										onclick={() => {
											pwRemoveOpen = false;
											pwRemoveError = null;
											pwRemoveValue = '';
											pwRemoveCode = '';
										}}
										disabled={pwRemoveBusy}
									>
										Keep it
									</button>
								</div>
							</form>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		<section class="card factor-card" id="invites-card" aria-labelledby="invites-title">
			<header class="factor-head">
				<div class="factor-title">
					<span class="step-mark mono" aria-hidden="true">05</span>
					<div>
						<h2 id="invites-title">Invites</h2>
						<p class="factor-lede">
							The only way an account is made here: one address, one role, one use, and an
							expiry.
						</p>
					</div>
				</div>
				{#if invitesLoading && invites === null}
					<span class="chip" data-tone="muted"><Spinner /> reading</span>
				{:else if invites === null}
					<span class="chip" data-tone="muted">unknown</span>
				{:else if openInvites === 0}
					<span class="chip" data-tone="muted">none open</span>
				{:else}
					<span class="chip" data-tone="ok">{openInvites} open</span>
				{/if}
			</header>

			<div class="factor-body">
				<ul class="invite-facts">
					<li>
						<span class="fact-label mono">Single use</span>
						<span class="fact-body">
							The link stops working the moment it is redeemed. The row stays here, as used.
						</span>
					</li>
					<li>
						<span class="fact-label mono">One address</span>
						<span class="fact-body">
							An invite for an address that already has an account is refused, and nothing is
							minted.
						</span>
					</li>
					<li>
						<span class="fact-label mono">Owner, by an owner</span>
						<span class="fact-body">
							Only an owner may mint another owner. An admin can invite admins and members.
						</span>
					</li>
				</ul>

				<div class="invite-bar">
					{#if !mintOpen}
						<button
							type="button"
							class="btn btn-primary btn-sm"
							onclick={openMint}
							disabled={invitesLoading}
						>
							<Icon name="plus" size={13} /> Mint an invite
						</button>
					{/if}
					<button
						type="button"
						class="btn btn-sm"
						onclick={() => void loadInvites()}
						disabled={invitesLoading}
						aria-busy={invitesLoading}
					>
						{#if invitesLoading}<Spinner />{:else}<Icon name="refresh" size={13} />{/if}
						{invitesLoading ? 'Reading' : 'Refresh'}
					</button>
				</div>

				{#if mintOpen}
					<InviteMint
						bind:open={mintOpen}
						actorRole={session.role}
						oncreated={() => void loadInvites()}
					/>
				{/if}

				{#if invitesNotice}
					<div class="invite-note">
						<Notice tone={invitesNoticeTone}>{invitesNotice}</Notice>
					</div>
				{/if}

				{#if invitesLoading && invites === null}
					<div class="invite-loading" aria-busy="true" aria-live="polite">
						<span class="sr-only">Reading the invite list</span>
						{#each ['a', 'b', 'c'] as key (key)}
							<div class="skeleton" style="height: 38px"></div>
						{/each}
					</div>
				{:else if invitesError}
					<div class="invite-message">
						<Notice tone="danger" title="The invite list did not load">
							{invitesError}
						</Notice>
						<button
							type="button"
							class="btn btn-sm"
							style="margin-top: 12px"
							onclick={() => void loadInvites()}
						>
							<Icon name="refresh" size={13} /> Try again
						</button>
					</div>
				{:else if invites !== null && invites.length === 0}
					<EmptyState
						icon="key"
						title="No invites yet"
						description="An invite is what lets one address make an account: a role, an expiry and a single use. There is no public sign-up, so an account cannot exist without one."
					/>
				{:else if invites !== null}
					<div class="table-wrap">
						<table class="table invite-table">
							<thead>
								<tr>
									<th scope="col">Email</th>
									<th scope="col" class="col-role">Role</th>
									<th scope="col" class="col-state">State</th>
									<th scope="col" class="col-created">Created</th>
									<th scope="col" class="col-actions">
										<span class="sr-only">Actions</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{#each invites as invite (invite.id)}
									{@const state = inviteState(invite, inviteNow)}
									<tr>
										<td class="cell-email">
											<span class="invite-email">{invite.email}</span>
										</td>
										<td class="cell-role">
											<span class="mono role-value">{invite.role}</span>
										</td>
										<td class="cell-state">
											{#if state === 'open'}
												<span class="chip" data-tone="ok">open</span>
												<span class="cell-sub mono">
													expires {formatRelative(invite.expires_at, inviteNow)}
												</span>
											{:else if state === 'used'}
												<span class="chip" data-tone="muted">used</span>
												<span class="cell-sub mono">
													{formatDate(invite.used_at)}
												</span>
											{:else}
												<span class="chip" data-tone="warn">expired</span>
												<span class="cell-sub mono">
													{formatDate(invite.expires_at)}
												</span>
											{/if}
										</td>
										<td class="cell-created">
											<span class="mono">{formatDate(invite.created_at)}</span>
											{#if recentAge(invite.created_at, inviteNow)}
												<span class="cell-sub mono">
													{recentAge(invite.created_at, inviteNow)}
												</span>
											{/if}
										</td>
										<td class="cell-actions">
											{#if state === 'open'}
												<button
													type="button"
													class="btn btn-danger btn-sm"
													onclick={() => {
														revokeError = null;
														revokeTarget = invite;
													}}
													aria-label={`Revoke the invite for ${invite.email}`}
												>
													<Icon name="trash" size={13} /> Revoke
												</button>
											{:else if state === 'expired'}
												<button
													type="button"
													class="btn btn-ghost btn-sm"
													onclick={() => {
														revokeError = null;
														revokeTarget = invite;
													}}
													aria-label={`Remove the expired invite for ${invite.email}`}
												>
													Remove
												</button>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<p class="hint invite-foot">
						Rows are kept after use so the list says what happened. The gateway writes
						<span class="mono">invite.created</span> and <span class="mono">invite.revoked</span> to
						the audit log.
					</p>
				{/if}
			</div>
		</section>
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
		regenerateCode = '';
	}}
>
	<div class="field regenerate-proof">
		<label class="label" for="regenerate-code">Confirm with a current code</label>
		<input
			bind:value={regenerateCode}
			id="regenerate-code"
			class="input input-mono code-input"
			inputmode="numeric"
			autocomplete="one-time-code"
			pattern="[0-9]*"
			maxlength="6"
			placeholder="000000"
			spellcheck="false"
			disabled={regenerating}
			aria-invalid={regenerateError ? 'true' : undefined}
			oninput={(event) => {
				regenerateCode = event.currentTarget.value.replace(/[^0-9]/g, '').slice(0, 6);
			}}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					void replaceCodes();
				}
			}}
		/>
		<p class="hint">
			A current code proves the change, so the password is never asked for while the authenticator is
			on.
		</p>
	</div>
	<p style="margin-top: 12px">
		The ten codes you have now stop working the moment the new set is made. The new set is shown
		once, here, and cannot be read later.
	</p>
	<p style="margin-top: 8px">
		Do this only if the old codes were lost or may have been seen by someone else.
	</p>
</ConfirmDialog>

<ConfirmDialog
	open={revokeTarget !== null}
	title={revokeExpired ? 'Remove this expired invite?' : 'Revoke this invite?'}
	confirmLabel={revokeExpired ? 'Remove the row' : 'Revoke invite'}
	tone="danger"
	pending={revoking}
	error={revokeError}
	onconfirm={() => void confirmRevoke()}
	oncancel={() => {
		revokeTarget = null;
		revokeError = null;
	}}
>
	{#if revokeTarget !== null}
		{#if revokeExpired}
			<p>
				The link for <strong>{revokeTarget.email}</strong> expired on
				<span class="mono">{formatDate(revokeTarget.expires_at)}</span> and cannot be redeemed.
				Removing the row deletes the record; nothing else changes.
			</p>
		{:else}
			<p>
				The link minted for <strong>{revokeTarget.email}</strong> stops working now, and the row
				leaves this list. If it was already redeemed, the account it made stays.
			</p>
			<p class="hint" style="margin-top: 8px">
				This cannot be undone. Mint a new invite if the address still needs one.
			</p>
		{/if}
	{/if}
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

	/* The proof field inside the regenerate dialog: one short column, not the
	   dialog's full width. */
	.regenerate-proof {
		max-width: 260px;
	}

	.regenerate-proof .hint {
		margin-top: 6px;
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

	/* --------------------------------------------------------------- password */

	/* The mode on its own line, then one sentence about what it means. Side by
	   side, the tag starved the sentence into a narrow column. */
	.pw-mode {
		max-width: 84ch;
		margin-bottom: var(--s-3);
	}

	/* The raw `AUTH_PASSWORD_MODE` value, so what the page says and what the
	   deployment is set to are the same string. */
	.mode-tag {
		flex: none;
		padding: 2px 7px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--df-surface-well);
		color: var(--ink-2);
		font-size: 10.5px;
		letter-spacing: 0.04em;
	}

	.pw-mode .hint {
		display: block;
		margin-top: 6px;
	}

	.pw-state {
		max-width: 68ch;
	}

	.pw-notice {
		margin-bottom: var(--s-3);
	}

	.pw-blocked {
		max-width: 74ch;
	}

	/* A sentence under a button row, not glued to it. */
	.pw-note {
		margin-top: var(--s-2);
	}

	.pw-form {
		margin-top: var(--s-3);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
		max-width: 460px;
	}

	.pw-show {
		flex: none;
		min-width: 58px;
		height: auto;
		align-self: stretch;
	}

	.pw-actions {
		display: flex;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: var(--s-3);
	}

	/* Four segments, lit by length alone. The colour is the only judgement made
	   here, and it is about length, not about what is in the password. */
	.pw-strength {
		display: flex;
		gap: 4px;
		margin-top: 8px;
	}

	.pw-seg {
		flex: 1;
		height: 3px;
		border-radius: 2px;
		background: color-mix(in srgb, var(--ink-3) 26%, transparent);
		transition: background-color 160ms ease;
	}

	.pw-strength[data-tone='short'] .pw-seg.is-lit,
	.pw-strength[data-tone='weak'] .pw-seg.is-lit {
		background: var(--danger);
	}

	.pw-strength[data-tone='fair'] .pw-seg.is-lit {
		background: var(--warn);
	}

	.pw-strength[data-tone='good'] .pw-seg.is-lit,
	.pw-strength[data-tone='long'] .pw-seg.is-lit {
		background: var(--ok);
	}

	.pw-hint strong {
		color: var(--ink-2);
		font-weight: 600;
	}

	.pw-hint + .hint {
		margin-top: 6px;
		max-width: 62ch;
	}

	/* ---------------------------------------------------------------- invites */

	/* The three rules the panel will not let an operator learn by failing: each
	   is a fact about the mechanism, not a tip. */
	.invite-facts {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1px;
		padding: 1px;
		list-style: none;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--line);
		overflow: hidden;
	}

	.invite-facts li {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 10px 12px;
		background: color-mix(in srgb, var(--surface-2) 55%, var(--surface));
	}

	.fact-label {
		font-size: 9.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.fact-body {
		max-width: 34ch;
		color: var(--ink-2);
		font-size: 12px;
		line-height: 1.5;
	}

	.invite-bar {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
		margin-top: var(--s-3);
	}

	.invite-note,
	.invite-message {
		margin-top: var(--s-3);
	}

	.invite-loading {
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
		margin-top: var(--s-3);
	}

	.table-wrap {
		margin-top: var(--s-3);
		overflow-x: auto;
	}

	.invite-table {
		min-width: 620px;
	}

	/* Not sticky: the wrapper is a horizontal scroller, so `top` would stick the
	   header inside that box, not under the page header. */
	.invite-table th {
		position: static;
	}

	.invite-table td {
		vertical-align: top;
	}

	.invite-email {
		display: block;
		font-weight: 500;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.role-value {
		font-size: 12px;
		color: var(--ink-2);
	}

	.col-role {
		width: 88px;
	}

	.col-state {
		width: 132px;
	}

	.col-created {
		width: 126px;
	}

	.col-actions {
		width: 116px;
	}

	.cell-actions {
		text-align: right;
	}

	.cell-actions .btn {
		white-space: nowrap;
	}

	.invite-foot {
		max-width: 82ch;
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
		.disable-actions .btn,
		.pw-actions .btn {
			min-height: 48px;
		}

		/* The password field is typed into with a thumb, and the Show button sits
		   on the same row: both take the 48dp target. */
		.pw-form .input,
		.pw-show {
			min-height: 48px;
		}

		.pw-form {
			max-width: none;
		}

		/* The facts become a stack: three columns at 390px would be three words
		   per line. */
		.invite-facts {
			grid-template-columns: minmax(0, 1fr);
		}

		.fact-body {
			max-width: none;
		}

		.invite-bar .btn,
		.cell-actions .btn,
		.invite-message .btn {
			min-height: 48px;
		}

		/* The revoke dialog is shared, but its two buttons are tapped here. */
		:global(dialog.dialog .dialog-foot .btn) {
			min-height: 48px;
		}

		/* A five-column table at 390px is a horizontal scroll with a revoke
		   button off-screen. Each row becomes its own card instead, with the
		   header row still in the accessibility tree. */
		.table-wrap {
			overflow-x: visible;
		}

		.invite-table {
			min-width: 0;
		}

		.invite-table thead {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}

		.invite-table,
		.invite-table tbody,
		.invite-table tr,
		.invite-table td {
			display: block;
		}

		.invite-table tbody {
			display: grid;
			gap: var(--s-2);
		}

		.invite-table tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 4px 10px;
			padding: 12px;
			border: 1px solid var(--line);
			border-radius: var(--r-sm);
		}

		.invite-table tbody tr:hover {
			background: transparent;
		}

		.invite-table td {
			padding: 0;
			border: 0;
		}

		.invite-table th:first-child,
		.invite-table td:first-child,
		.invite-table th:last-child,
		.invite-table td:last-child {
			padding: 0;
		}

		.cell-email {
			grid-column: 1;
			grid-row: 1;
		}

		.cell-state {
			grid-column: 2;
			grid-row: 1;
			text-align: right;
		}

		.cell-role {
			grid-column: 1;
			grid-row: 2;
		}

		.cell-created {
			grid-column: 1;
			grid-row: 3;
		}

		.cell-actions {
			grid-column: 2;
			grid-row: 2 / span 2;
			align-self: center;
		}

		.cell-role::before,
		.cell-created::before {
			margin-right: 6px;
			font-family: var(--font-mono);
			font-size: 9.5px;
			letter-spacing: 0.1em;
			text-transform: uppercase;
			color: var(--ink-3);
		}

		.cell-role::before {
			content: 'role';
		}

		.cell-created::before {
			content: 'created';
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.factor-card {
			transition: none;
		}

		.pw-seg {
			transition: none;
		}

		.invite-table tbody tr {
			transition: none;
		}
	}
</style>
