import { tick } from 'svelte';
import type { SecurityStateKey } from './fixtures';

async function waitFor<T>(
	fn: () => T | null,
	signal: AbortSignal,
	timeoutMs = 5_000
): Promise<T | null> {
	const deadline = performance.now() + timeoutMs;
	while (!signal.aborted && performance.now() < deadline) {
		const hit = fn();
		if (hit) return hit;
		await new Promise<void>((r) => requestAnimationFrame(() => r()));
	}
	return null;
}

function findButton(root: ParentNode, text: string): HTMLButtonElement | null {
	return (
		Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
			(btn) => btn.textContent?.trim().includes(text) ?? false
		) ?? null
	);
}

function setInput(el: HTMLInputElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelect(el: HTMLSelectElement, value: string): void {
	el.value = value;
	el.dispatchEvent(new Event('change', { bubbles: true }));
}

export async function driveSecurityState(
	stageEl: HTMLElement,
	state: SecurityStateKey,
	signal: AbortSignal
): Promise<void> {
	if (
		state === 'loading' ||
		state === 'member-no-access' ||
		state === 'legacy-admin-token' ||
		state === 'totp-off-ready' ||
		state === 'passkeys-none-pw-only' ||
		state === 'passkeys-error' ||
		state === 'totp-unavailable-missing' ||
		state === 'totp-unavailable-no-secret' ||
		state === 'totp-unavailable-disabled' ||
		state === 'totp-signed-out' ||
		state === 'totp-probe-error' ||
		state === 'totp-on' ||
		state === 'pw-health-error' ||
		state === 'pw-no-pepper' ||
		state === 'pw-status-unknown' ||
		state === 'pw-client-not-set' ||
		state === 'pw-server-set' ||
		state === 'invites-empty' ||
		state === 'invites-error-403' ||
		state === 'invites-error-offline'
	) {
		return;
	}

	await tick();

	// Wait for initial sequential load() to finish (Refresh button in PageHeader renders when !checking)
	const loaded = await waitFor(
		() => stageEl.querySelector('#totp-card .factor-actions, #password-card .factor-body, #invites-card .invite-bar'),
		signal
	);
	if (!loaded || signal.aborted) return;

	// 1. TOTP enrolment states
	if (
		state === 'totp-enrol-starting' ||
		state === 'totp-enrol-qr' ||
		state === 'totp-enrol-verifying' ||
		state === 'totp-enrol-code-error' ||
		state === 'totp-enrol-codes-reveal'
	) {
		const startBtn = await waitFor(
			() => findButton(stageEl.querySelector('#totp-card') ?? stageEl, 'Set up an authenticator'),
			signal
		);
		if (!startBtn || signal.aborted) return;
		startBtn.click();
		if (state === 'totp-enrol-starting') return;

		const codeInput = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('#enrol-code'),
			signal
		);
		if (!codeInput || signal.aborted) return;
		if (state === 'totp-enrol-qr') return;

		setInput(codeInput, state === 'totp-enrol-code-error' ? '000000' : '482913');
		await tick();
		const form = stageEl.querySelector<HTMLFormElement>('form.enrol-confirm');
		form?.requestSubmit();
		return;
	}

	// 2. TOTP disable states
	if (
		state === 'totp-disable-open' ||
		state === 'totp-disable-pending' ||
		state === 'totp-disable-error' ||
		state === 'totp-disabled-notice'
	) {
		const turnOffBtn = await waitFor(
			() => findButton(stageEl.querySelector('#totp-card') ?? stageEl, 'Turn off'),
			signal
		);
		if (!turnOffBtn || signal.aborted) return;
		turnOffBtn.click();
		if (state === 'totp-disable-open') return;

		const disableInput = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('#disable-code'),
			signal
		);
		if (!disableInput || signal.aborted) return;
		setInput(disableInput, state === 'totp-disable-error' ? '000000' : '619204');
		await tick();
		stageEl.querySelector<HTMLFormElement>('#disable-form')?.requestSubmit();
		return;
	}

	// 3. Recovery codes regenerate states
	if (
		state === 'codes-regenerate-dialog' ||
		state === 'codes-regenerate-pending' ||
		state === 'codes-regenerate-error' ||
		state === 'codes-regenerated-reveal'
	) {
		const replaceBtn = await waitFor(
			() => findButton(stageEl.querySelector('#codes-card') ?? stageEl, 'Replace the codes'),
			signal
		);
		if (!replaceBtn || signal.aborted) return;
		replaceBtn.click();
		if (state === 'codes-regenerate-dialog') return;

		const codeInput = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('dialog.dialog[open] #regenerate-code'),
			signal
		);
		if (!codeInput || signal.aborted) return;
		setInput(codeInput, state === 'codes-regenerate-error' ? '000000' : '371905');
		await tick();
		const confirmBtn = findButton(
			stageEl.querySelector('dialog.dialog[open]') ?? stageEl,
			'Replace them'
		);
		confirmBtn?.click();
		return;
	}

	// 4. Password set/save states
	if (
		state === 'pw-form-strength' ||
		state === 'pw-form-saving' ||
		state === 'pw-form-error' ||
		state === 'pw-saved-notice'
	) {
		const pwCard = stageEl.querySelector('#password-card');
		const openBtn = await waitFor(
			() => (pwCard ? findButton(pwCard, 'Set a password') : null),
			signal
		);
		if (!openBtn || signal.aborted) return;
		openBtn.click();

		const pwInput = await waitFor(() => stageEl.querySelector<HTMLInputElement>('#pw-new'), signal);
		if (!pwInput || signal.aborted) return;

		if (state === 'pw-form-strength') {
			setInput(pwInput, 'maple-bridge-9');
			await tick();
			const showBtn = stageEl.querySelector<HTMLButtonElement>('#password-card button.pw-show');
			showBtn?.click();
			return;
		}

		setInput(pwInput, 'dakflare-vault-2026');
		await tick();
		stageEl.querySelector<HTMLFormElement>('#password-card form.pw-form')?.requestSubmit();
		return;
	}

	// 5. Password remove states
	if (
		state === 'pw-remove-with-password' ||
		state === 'pw-remove-with-totp' ||
		state === 'pw-remove-pending' ||
		state === 'pw-remove-error' ||
		state === 'pw-removed-notice'
	) {
		const pwCard = stageEl.querySelector('#password-card');
		const removeBtn = await waitFor(
			() => (pwCard ? findButton(pwCard, 'Remove') : null),
			signal
		);
		if (!removeBtn || signal.aborted) return;
		removeBtn.click();
		if (state === 'pw-remove-with-password' || state === 'pw-remove-with-totp') return;

		const proofInput = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('#pw-remove-value, #pw-remove-code'),
			signal
		);
		if (!proofInput || signal.aborted) return;
		setInput(proofInput, 'dakflare-vault-2026');
		await tick();
		stageEl.querySelector<HTMLFormElement>('#pw-remove-form')?.requestSubmit();
		return;
	}

	// 6. Invite mint states
	if (
		state === 'invites-mint-admin-warn' ||
		state === 'invites-mint-pending' ||
		state === 'invites-mint-conflict' ||
		state === 'invites-mint-revealed'
	) {
		const invitesCard = stageEl.querySelector('#invites-card');
		const mintBtn = await waitFor(
			() => (invitesCard ? findButton(invitesCard, 'Mint an invite') : null),
			signal
		);
		if (!mintBtn || signal.aborted) return;
		mintBtn.click();

		const emailInput = await waitFor(
			() => stageEl.querySelector<HTMLInputElement>('#invite-email'),
			signal
		);
		if (!emailInput || signal.aborted) return;

		if (state === 'invites-mint-admin-warn') {
			const roleSelect = stageEl.querySelector<HTMLSelectElement>('#invite-role');
			if (roleSelect) setSelect(roleSelect, 'owner');
			return;
		}

		setInput(
			emailInput,
			state === 'invites-mint-conflict' ? 'jony@example.com' : 'samira.ops@example.com'
		);
		await tick();
		stageEl.querySelector<HTMLFormElement>('#invites-card form.mint-form')?.requestSubmit();
		return;
	}

	// 7. Invite revoke/remove dialog states
	if (
		state === 'invites-revoke-confirm' ||
		state === 'invites-remove-expired-confirm' ||
		state === 'invites-revoke-pending' ||
		state === 'invites-revoke-error' ||
		state === 'invites-revoke-gone'
	) {
		const triggerBtn = await waitFor(() => {
			const table = stageEl.querySelector('#invites-card table.invite-table');
			if (!table) return null;
			return findButton(
				table,
				state === 'invites-remove-expired-confirm' ? 'Remove' : 'Revoke'
			);
		}, signal);
		if (!triggerBtn || signal.aborted) return;
		triggerBtn.click();

		if (state === 'invites-revoke-confirm' || state === 'invites-remove-expired-confirm') return;

		const confirmBtn = await waitFor(() => {
			const dialog = stageEl.querySelector<HTMLDialogElement>('dialog.dialog[open]');
			return dialog ? findButton(dialog, 'Revoke invite') : null;
		}, signal);
		confirmBtn?.click();
	}
}
