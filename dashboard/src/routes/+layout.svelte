<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { deleteSession, setUnauthorizedHandler } from '$lib/api';
	import { formatAbsolute, formatRelative } from '$lib/format';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import Brand from '$lib/components/Brand.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let { children } = $props();

	type NavItem = { href: string; label: string; icon: IconName; match?: string[] };

	// Rules and workflows are two authored forms of one automation pipeline. The
	// segmented control on those pages switches between them, so the rail carries
	// a single entry instead of implying two unrelated features.
	const nav: NavItem[] = [
		{ href: ROUTES.overview, label: 'Overview', icon: 'activity' },
		{ href: ROUTES.devices, label: 'Devices', icon: 'smartphone' },
		{ href: ROUTES.messages, label: 'Messages', icon: 'message' },
		{
			href: ROUTES.rules,
			label: 'Automation',
			icon: 'workflow',
			match: [ROUTES.rules, ROUTES.workflows]
		}
	];

	let boot = $state<'checking' | 'ready' | 'error'>('checking');
	let loggingOut = $state(false);
	let mobileNav = $state<HTMLElement | null>(null);

	const isLogin = $derived(
		page.url.pathname === ROUTES.login || page.url.pathname === `${ROUTES.login}/`
	);

	function isActive(item: NavItem): boolean {
		if (item.href === ROUTES.overview) {
			return (
				page.url.pathname === item.href ||
				page.url.pathname === item.href.replace(/\/$/, '')
			);
		}
		const prefixes = item.match ?? [item.href];
		return prefixes.some(
			(prefix) =>
				page.url.pathname === prefix || page.url.pathname.startsWith(`${prefix}/`)
		);
	}

	function loginUrl(next?: string): string {
		const target =
			next && next.startsWith(`${BASE}/`) && next !== ROUTES.login ? next : undefined;
		return target ? `${ROUTES.login}?next=${encodeURIComponent(target)}` : ROUTES.login;
	}

	function handleUnauthorized() {
		session.clear();
		if (isLogin) return;
		boot = 'ready';
		void goto(ROUTES.login, { replaceState: true });
	}

	async function bootSession() {
		if (isLogin) {
			boot = 'ready';
			return;
		}
		boot = 'checking';
		const status = await session.check();
		if (status === 'authed') {
			boot = 'ready';
		} else if (status === 'anon') {
			await goto(loginUrl(page.url.pathname + page.url.search), { replaceState: true });
			boot = 'ready';
		} else {
			boot = 'error';
		}
	}

	async function logout() {
		loggingOut = true;
		try {
			await deleteSession();
		} catch {
			// Leave the UI either way: the operator asked to end the session.
		}
		session.clear();
		await goto(ROUTES.login, { replaceState: true });
		loggingOut = false;
	}

	onMount(() => {
		setUnauthorizedHandler(handleUnauthorized);
		void bootSession();
		return () => setUnauthorizedHandler(null);
	});

	// Keep the current section in view inside the horizontally scrolling mobile
	// nav. The rail shows everything; the phone shows the active item at the left
	// edge with the next one fading in, instead of a row that starts at Overview.
	$effect(() => {
		void page.url.pathname;
		const navEl = mobileNav;
		if (!navEl) return;
		const active = navEl.querySelector<HTMLElement>('[aria-current="page"]');
		if (!active) return;
		const navRect = navEl.getBoundingClientRect();
		const activeRect = active.getBoundingClientRect();
		const left = activeRect.left - navRect.left + navEl.scrollLeft - 4;
		navEl.scrollTo({ left: Math.max(0, left), behavior: 'auto' });
	});
</script>

<svelte:head>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

{#if boot === 'checking'}
	<div class="boot" aria-live="polite" aria-busy="true">
		<Brand href={ROUTES.login} />
		<span class="row" style="gap: 8px"><Spinner /> Establishing session</span>
	</div>
{:else if boot === 'error'}
	<div class="boot">
		<div class="boot-error">
			<Brand href={ROUTES.login} />
			<div style="margin-top: 24px" class="stack">
				<Notice tone="danger" title="Cannot reach the gateway">
					{session.error ?? 'The session check failed. The gateway may be unreachable.'}
				</Notice>
				<div class="row">
					<button type="button" class="btn btn-primary" onclick={() => void bootSession()}>
						<Icon name="refresh" size={14} /> Try again
					</button>
					<a class="btn" href={ROUTES.login}>Sign-in screen</a>
				</div>
			</div>
		</div>
	</div>
{:else if isLogin}
	{@render children()}
{:else}
	<div class="shell">
		<aside class="rail">
			<Brand />
			<nav class="nav" aria-label="Main">
				<p class="eyebrow nav-label">Console</p>
				{#each nav as item (item.href)}
					<a class="nav-link" href={item.href} aria-current={isActive(item) ? 'page' : undefined}>
						<Icon name={item.icon} size={15} />
						{item.label}
					</a>
				{/each}
			</nav>

			<div class="rail-foot">
				<p class="session-line" title={session.expiresAt ? formatAbsolute(session.expiresAt) : undefined}>
					<span class="session-dot"></span>
					{#if session.expiresAt}
						<span>session · {formatRelative(session.expiresAt)}</span>
					{:else}
						<span>session active</span>
					{/if}
				</p>
				<div class="rail-actions">
					<button
						type="button"
						class="btn btn-sm"
						onclick={() => void logout()}
						disabled={loggingOut}
						aria-busy={loggingOut}
					>
						{#if loggingOut}<Spinner />{:else}<Icon name="logout" size={13} />{/if}
						Sign out
					</button>
					<ThemeToggle />
				</div>
			</div>
		</aside>

		<div class="main-wrap">
			<header class="mobile-bar">
				<Brand />
				<nav class="mobile-nav" aria-label="Main" bind:this={mobileNav}>
					{#each nav as item (item.href)}
						<a
							class="nav-link"
							href={item.href}
							aria-current={isActive(item) ? 'page' : undefined}
						>
							<Icon name={item.icon} size={14} />
							{item.label}
						</a>
					{/each}
				</nav>
				<div class="row" style="gap: 4px">
					<ThemeToggle />
					<button
						type="button"
						class="btn btn-ghost btn-icon btn-sm"
						onclick={() => void logout()}
						disabled={loggingOut}
						aria-label="Sign out"
						title="Sign out"
					>
						{#if loggingOut}<Spinner />{:else}<Icon name="logout" size={14} />{/if}
					</button>
				</div>
			</header>

			<main class="main">
				<AlertBanner />
				{@render children()}
			</main>
		</div>
	</div>
{/if}
