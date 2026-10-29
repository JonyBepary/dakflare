<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { deleteSession, setUnauthorizedHandler, signOutAccount } from '$lib/api';
	import { ALERTS_CHANGED_EVENT } from '$lib/alert-events';
	import { formatAbsolute, formatCount } from '$lib/format';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import { consoleCounts } from '$lib/console-counts.svelte';
	import Brand from '$lib/components/Brand.svelte';
	import AlertBanner from '$lib/components/AlertBanner.svelte';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';

	let { children } = $props();

	type CountKey = 'devices' | 'messages' | 'rules';
	type NavItem = {
		href: string;
		label: string;
		icon: IconName;
		match?: string[];
		count?: CountKey;
		countWord?: string;
	};

	// Rules and workflows are two authored forms of one automation pipeline. The
	// segmented control on those pages switches between them, so the rail carries
	// a single entry instead of implying two unrelated features.
	//
	// Security is its own section because it answers a different question
	// ("who did what") than the fleet does, and it is the one part of the rail a
	// member must not see (AUTH_PLAN §5).
	const sections: Array<{ label: string; items: NavItem[]; ownersOnly?: boolean }> = [
		{
			label: 'Console',
			items: [
				{ href: ROUTES.overview, label: 'Overview', icon: 'activity' },
				{ href: ROUTES.devices, label: 'Devices', icon: 'smartphone', count: 'devices', countWord: 'paired' },
				{ href: ROUTES.messages, label: 'Messages', icon: 'message', count: 'messages', countWord: 'kept' },
				{
					href: ROUTES.rules,
					label: 'Automation',
					icon: 'workflow',
					match: [ROUTES.rules, ROUTES.workflows],
					count: 'rules',
					countWord: 'authored'
				}
			]
		},
		{
			label: 'Security',
			ownersOnly: true,
			items: [{ href: ROUTES.audit, label: 'Audit log', icon: 'history' }]
		}
	];

	const visibleSections = $derived(
		sections.filter((section) => section.ownersOnly !== true || session.canViewSecurity)
	);
	const nav = $derived(visibleSections.flatMap((section) => section.items));

	const COUNT_REFRESH_MS = 60_000;

	let boot = $state<'checking' | 'ready' | 'error'>('checking');
	let loggingOut = $state(false);
	let topbarNav = $state<HTMLElement | null>(null);

	const isLogin = $derived(
		page.url.pathname === ROUTES.login || page.url.pathname === `${ROUTES.login}/`
	);

	// The three account screens stand outside the shell: they are reached before
	// there is a session to prove (login, invite, first passkey).
	const isPreauth = $derived(
		isLogin ||
			page.url.pathname === ROUTES.invite ||
			page.url.pathname === `${ROUTES.invite}/` ||
			page.url.pathname === ROUTES.enrol ||
			page.url.pathname === `${ROUTES.enrol}/`
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

	const activeLabel = $derived(nav.find(isActive)?.label ?? 'Console');

	/** Who is signed in. The token gate has no user row, so it stays "Operator". */
	const operatorName = $derived(
		session.name ?? (session.authMode === 'legacy' ? 'Admin token' : 'Operator')
	);
	const operatorInitials = $derived.by(() => {
		const source = session.name ?? session.email ?? '';
		const parts = source.trim().split(/\s+/).filter(Boolean);
		if (parts.length === 0) return 'OP';
		if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
		return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
	});

	function pillCount(item: NavItem): number | null {
		if (!item.count) return null;
		const value = consoleCounts[item.count];
		// A zero pill is noise; the rail's job is to show what exists.
		return value !== null && value > 0 ? value : null;
	}

	function linkLabel(item: NavItem): string | undefined {
		const count = pillCount(item);
		if (count === null || item.countWord === undefined) return undefined;
		return `${item.label}, ${count} ${item.countWord}`;
	}

	function loginUrl(next?: string): string {
		const target =
			next && next.startsWith(`${BASE}/`) && next !== ROUTES.login ? next : undefined;
		return target ? `${ROUTES.login}?next=${encodeURIComponent(target)}` : ROUTES.login;
	}

	function handleUnauthorized() {
		session.clear();
		// A stale admin-token cookie survives a cutover: `/admin/session` still
		// verifies it, but the `new` gate ignores it, so leaving it in place would
		// bounce login → overview → login. Clearing it makes the next answer honest.
		void deleteSession().catch(() => undefined);
		if (isPreauth) return;
		boot = 'ready';
		void goto(ROUTES.login, { replaceState: true });
	}

	async function bootSession() {
		if (isPreauth) {
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
			// Whichever door was used, close it. The token cookie is cleared either
			// way; the account session only exists under `new`.
			if (session.authMode === 'new') await signOutAccount();
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

		const timer = setInterval(() => {
			if (document.visibilityState === 'visible' && !isPreauth) void consoleCounts.refresh();
		}, COUNT_REFRESH_MS);
		const onVisible = () => {
			if (document.visibilityState === 'visible' && !isPreauth) void consoleCounts.refresh();
		};
		const onAlertsChanged = () => {
			if (!isPreauth) void consoleCounts.refresh();
		};
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);

		return () => {
			setUnauthorizedHandler(null);
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
		};
	});

	// One health read per navigation feeds the rail's pill counts. Overview pushes
	// its own result into the same store, so the two never disagree.
	$effect(() => {
		void page.url.pathname;
		if (boot === 'ready' && !isPreauth) void consoleCounts.refresh();
	});

	// Keep the current section in view inside the horizontally scrolling mobile
	// nav. The rail shows everything; the phone shows the active item at the left
	// edge with the next one fading in, instead of a row that starts at Overview.
	$effect(() => {
		void page.url.pathname;
		const navEl = topbarNav;
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
{:else if isPreauth}
	{@render children()}
{:else}
	<div class="shell">
		<aside class="rail">
			<Brand />
			<nav class="nav" aria-label="Main">
				{#each visibleSections as section (section.label)}
					<p class="nav-label">{section.label}</p>
					{#each section.items as item (item.href)}
						{@const count = pillCount(item)}
						<a
							class="nav-link"
							href={item.href}
							aria-current={isActive(item) ? 'page' : undefined}
							aria-label={linkLabel(item)}
						>
							<Icon name={item.icon} size={20} />
							{item.label}
							{#if count !== null}
								<span class="nav-pill" aria-hidden="true">{formatCount(count)}</span>
							{/if}
						</a>
					{/each}
				{/each}
			</nav>

			<div class="rail-foot">
				<p class="nav-label">Operator</p>
				<div class="operator">
					<div class="operator-id">
						<span class="operator-avatar" aria-hidden="true">{operatorInitials}</span>
						<span class="operator-copy">
							<span class="operator-name">{operatorName}</span>
							<span
								class="operator-meta"
								title={session.email ?? (session.expiresAt ? formatAbsolute(session.expiresAt) : undefined)}
							>
								{#if session.role}
									<span class="operator-role">{session.role}</span>
									·
								{/if}
								{#if session.expiresAt}
									expires <RelativeTime value={session.expiresAt} />
								{:else}
									session active
								{/if}
							</span>
						</span>
					</div>
				</div>
			</div>
		</aside>

		<div class="main-wrap">
			<header class="topbar">
				<a class="topbar-brand" href={ROUTES.overview} aria-label="DakFlare overview">
					<svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
						<rect x="2.5" y="9.5" width="2.6" height="4" rx="0.6" fill="currentColor" />
						<rect x="6.7" y="6.5" width="2.6" height="7" rx="0.6" fill="currentColor" />
						<rect x="10.9" y="2.5" width="2.6" height="11" rx="0.6" fill="currentColor" />
					</svg>
				</a>
				<span class="topbar-brand-name">DakFlare</span>

				<div class="topbar-context">
					<span class="eyebrow">Console</span>
					<span class="topbar-section">{activeLabel}</span>
				</div>

				<div class="topbar-actions">
					<ThemeToggle />
					<button
						type="button"
						class="btn btn-icon btn-sm"
						onclick={() => void logout()}
						disabled={loggingOut}
						aria-label="Sign out"
						title="Sign out"
					>
						{#if loggingOut}<Spinner />{:else}<Icon name="logout" size={16} />{/if}
					</button>
				</div>
			</header>

			<nav class="shell-tabs" aria-label="Main" bind:this={topbarNav}>
				{#each nav as item (item.href)}
					<a
						class="nav-link"
						href={item.href}
						aria-current={isActive(item) ? 'page' : undefined}
					>
						<Icon name={item.icon} size={16} />
						{item.label}
					</a>
				{/each}
			</nav>

			<AlertBanner />

			<main class="main">
				{@render children()}
			</main>
		</div>
	</div>
{/if}

<style>
	/* The role word reads as a value, not as a sentence: mono, lower case,
	   separated from the expiry by the same dot the rest of the rail uses. */
	.operator-role {
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-secondary);
	}
</style>
