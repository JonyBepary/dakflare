<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { ApiError, createSession, describeError, getSession } from '$lib/api';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import Brand from '$lib/components/Brand.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	// Deliberately no token state: the field is uncontrolled and its value is read
	// once, immediately before the request, then cleared. Only emptiness is tracked.
	let hasToken = $state(false);
	let showToken = $state(false);
	let pending = $state(false);
	let error = $state<string | null>(null);
	let input = $state<HTMLInputElement | null>(null);

	const nextTarget = $derived.by(() => {
		const requested = page.url.searchParams.get('next');
		if (requested && requested.startsWith(`${BASE}/`) && requested !== ROUTES.login) {
			return requested;
		}
		return ROUTES.overview;
	});

	onMount(() => {
		void (async () => {
			try {
				const info = await getSession();
				session.markAuthed(info.expires_at);
				await goto(nextTarget, { replaceState: true });
			} catch {
				// No usable session: stay here and offer the form.
				input?.focus();
			}
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
</style>
