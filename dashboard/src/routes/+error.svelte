<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import { ROUTES } from '$lib/paths';

	const status = $derived(page.status);
	const message = $derived(
		page.error?.message ?? (status === 404 ? 'That page does not exist.' : 'Unexpected error.')
	);
</script>

<svelte:head>
	<title>{status} · DakFlare</title>
</svelte:head>

<div class="page">
	<section class="panel">
		<div class="panel-body error-body">
			<span class="error-code mono">{status}</span>
			<h1>{status === 404 ? 'Not here' : 'Something broke'}</h1>
			<p>{message}</p>
			<div class="row" style="margin-top: 16px">
				<a class="btn btn-primary" href={ROUTES.overview}><Icon name="activity" size={14} /> Back to overview</a>
				{#if status === 401}
					<a class="btn" href={ROUTES.login}>Sign in</a>
				{/if}
			</div>
		</div>
	</section>
</div>

<style>
	.error-body {
		padding: var(--s-6);
		max-width: 62ch;
	}

	.error-code {
		font-size: 10px;
		letter-spacing: 0.14em;
		color: var(--ink-3);
	}

	h1 {
		margin-top: 6px;
		font-size: var(--text-xl);
	}

	p {
		margin-top: 8px;
		color: var(--ink-3);
		font-size: var(--text-base);
	}
</style>
