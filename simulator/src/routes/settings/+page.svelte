<script lang="ts">
	/**
	 * Settings is a hub, not a scroll.
	 *
	 * Six rows, each one live status word and one way in. A row drills into
	 * `/settings?section=<key>`, which is a real history entry, so Android's back
	 * gesture pops to the hub instead of leaving the app. The back control does the
	 * same thing by hand: pop when this section was pushed from the hub, replace
	 * when it was opened cold from a link.
	 */
	import { onMount } from 'svelte';
	import { AlertDialog } from 'bits-ui';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { getVersion } from '@tauri-apps/api/app';
	import { invoke } from '@tauri-apps/api/core';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import Toggle from '$lib/components/Toggle.svelte';
	import { app, DEFAULT_SMS_PACKAGE, retentionKept, retentionWords } from '$lib/stores/app.svelte';
	import { lastContact, relativeTime } from '$lib/device-state';
	import { readPairLink } from '$lib/pair-link';

	const SECTION_IDS = ['connection', 'channels', 'sms', 'log', 'devices', 'build'] as const;
	type SectionId = (typeof SECTION_IDS)[number];
	type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

	const SECTION_TITLES: Record<SectionId, string> = {
		connection: 'Connection & pairing',
		channels: 'Personal channels',
		sms: 'Default SMS app',
		log: 'Local message log',
		devices: 'Devices & identity',
		build: 'This build'
	};

	const SECTION_SUBS: Record<SectionId, string> = {
		connection: 'Where this phone sends, and the code that pairs it.',
		channels:
			"Android's grant to read personal chats, the permissions behind it, and the apps it watches.",
		sms: 'Android delivers a text only to the app that holds this role.',
		log: 'How long messages stay on this phone, and how to clear them now.',
		devices: 'The key this phone pairs with, and every identity stored here.',
		build: 'What this build reports, and whether the carrier is on.'
	};

	/** The five apps the notification bridge can watch. Names match the console. */
	const WATCHED = [
		{ key: 'whatsapp', name: 'WhatsApp' },
		{ key: 'whatsapp_business', name: 'WhatsApp Business' },
		{ key: 'telegram', name: 'Telegram' },
		{ key: 'messenger', name: 'Messenger' },
		{ key: 'instagram', name: 'Instagram' }
	] as const;

	type WatchKey = (typeof WATCHED)[number]['key'];

	const KEEP_OPTIONS = [
		{ policy: 'days:90', name: '90 days', detail: 'Older messages go.' },
		{ policy: 'days:30', name: '30 days', detail: 'Older messages go.' },
		{ policy: 'messages:1000', name: '1,000 messages', detail: 'Only the newest 1,000 stay.' },
		{ policy: 'forever', name: 'Forever', detail: 'Nothing is removed.' }
	];

	/** The snapshot both permissions screens read. Android is the only judge. */
	type PermSnapshot = {
		battery_exempt: boolean;
		sms_role: boolean;
		send_sms: boolean;
		receive_sms: boolean;
		notifications: boolean;
		notification_listener: boolean;
	};

	type Row = { summary: string; word: string; tone: Tone };
	type RowSpec = Row & { id: SectionId; title: string };

	function hasBridge(): boolean {
		return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
	}

	/** A plugin refusal already reads as a sentence; only the stop may be missing. */
	function sentence(error: unknown): string {
		const text = String(error).trim();
		if (!text) return 'Android did not open that screen.';
		return /[.!?]$/.test(text) ? text : `${text}.`;
	}

	function plural(n: number, one: string, many: string): string {
		return `${n} ${n === 1 ? one : many}`;
	}

	/** A tone is the same word on the hub and on a section's pill. */
	function pillState(tone: Tone): 'live' | 'warn' | 'offline' | 'unknown' {
		return tone === 'ok' ? 'live' : tone === 'warn' ? 'warn' : tone === 'danger' ? 'offline' : 'unknown';
	}

	function isSection(value: string | null): value is SectionId {
		return value !== null && (SECTION_IDS as readonly string[]).includes(value);
	}

	// ---------------------------------------------------------------- routing

	const pairLinkRaw = $derived(page.url.searchParams.get('pair'));
	const requestedSection = $derived(page.url.searchParams.get('section'));

	// A pairing link is about one thing, so it opens the section that holds the
	// fields it fills. Back from there drops the link and lands on the hub.
	const activeSection = $derived<'root' | SectionId>(
		pairLinkRaw ? 'connection' : isSection(requestedSection) ? requestedSection : 'root'
	);
	const activeTitle = $derived(activeSection === 'root' ? 'Settings' : SECTION_TITLES[activeSection]);
	const activeSub = $derived(activeSection === 'root' ? '' : SECTION_SUBS[activeSection]);

	let popToHub = $state(false);

	/** The channels section shows one panel at a time, not three stacked cards. */
	let channelTab = $state<'access' | 'apps'>('access');

	function selectChannelTab(next: 'access' | 'apps') {
		channelTab = next;
	}

	/** Arrow keys move between the two tabs, the way a tablist is expected to. */
	function onTabKey(event: KeyboardEvent) {
		const target =
			event.key === 'Home'
				? 'access'
				: event.key === 'End'
					? 'apps'
					: event.key === 'ArrowLeft' || event.key === 'ArrowRight'
						? channelTab === 'access'
							? 'apps'
							: 'access'
						: null;
		if (!target) return;
		event.preventDefault();
		channelTab = target;
		document.getElementById(target === 'access' ? 'tab-access' : 'tab-apps')?.focus();
	}

	function scrollToTop() {
		document.querySelector('.app-main')?.scrollTo({ top: 0 });
		window.scrollTo({ top: 0 });
	}

	function openSection(id: SectionId) {
		// Remember whether the hub is one pop away, so the back control can leave
		// the history stack as clean as the Android gesture would.
		popToHub = activeSection === 'root';
		void goto(`/settings?section=${id}`, { noScroll: true });
		scrollToTop();
	}

	function backToHub() {
		if (popToHub) {
			popToHub = false;
			history.back();
			return;
		}
		void goto('/settings', { replaceState: true, noScroll: true });
		scrollToTop();
	}

	// ------------------------------------------------------------- permissions

	let perms = $state<PermSnapshot>({
		battery_exempt: false,
		sms_role: false,
		send_sms: false,
		receive_sms: false,
		notifications: false,
		notification_listener: false
	});
	/** True once Android has answered at least once; a `false` is then a fact. */
	let permKnown = $state(false);
	let permError = $state<string | null>(null);
	let permBusy = $state<string | null>(null);

	/** The build's own version, when the shell can name it. */
	let version = $state<string | null>(null);

	/** The read in flight, so focus and visibility cannot ask twice at once. */
	let inFlight: Promise<void> | null = null;

	const listenerOn = $derived(permKnown && perms.notification_listener);
	const listenerWord = $derived(permKnown ? (perms.notification_listener ? 'Enabled' : 'Off') : 'Unknown');
	const listenerTone = $derived<Tone>(listenerOn ? 'ok' : permKnown ? 'warn' : 'neutral');

	async function loadVersion() {
		if (!hasBridge()) return;
		try {
			version = await getVersion();
		} catch {
			// An older shell may not answer; the row says so rather than guessing.
			version = null;
		}
	}

	async function refreshPerms() {
		if (!hasBridge()) return;
		if (inFlight) return inFlight;
		inFlight = (async () => {
			try {
				const state = await invoke<Partial<PermSnapshot>>('permission_state');
				perms = {
					battery_exempt: state.battery_exempt === true,
					sms_role: state.sms_role === true,
					send_sms: state.send_sms === true,
					receive_sms: state.receive_sms === true,
					notifications: state.notifications === true,
					notification_listener: state.notification_listener === true
				};
				permKnown = true;
				permError = null;
			} catch (error) {
				// A failed read is not a missing grant: keep the last answer and say
				// that the reading failed rather than repainting every row as off.
				permError = sentence(error);
			} finally {
				inFlight = null;
			}
		})();
		return inFlight;
	}

	/**
	 * Open Android's Notification Access screen. The command resolves as soon as
	 * the system Activity starts, so this read can still see the old answer; the
	 * resume read below is the one that knows. Reading anyway covers a build that
	 * resolves after the operator has already come back.
	 */
	async function openNotificationAccess() {
		permBusy = 'listener';
		permError = null;
		try {
			await invoke('request_notification_listener');
			await refreshPerms();
		} catch (error) {
			permError = sentence(error);
		} finally {
			permBusy = null;
		}
	}

	/** The manual re-read, with its own busy word so the button answers the tap. */
	async function recheckPerms() {
		permBusy = 'refresh';
		try {
			await refreshPerms();
		} finally {
			permBusy = null;
		}
	}

	async function askSystem(command: string, key: string) {
		permBusy = key;
		permError = null;
		try {
			await invoke(command);
			await refreshPerms();
		} catch (error) {
			permError = sentence(error);
		} finally {
			permBusy = null;
		}
	}

	// ------------------------------------------------------------ watched apps

	let watched = $state<Record<WatchKey, boolean>>({
		whatsapp: true,
		whatsapp_business: true,
		telegram: true,
		messenger: true,
		instagram: true
	});
	let watchedKnown = $state(false);
	let watchedBusy = $state<WatchKey | null>(null);
	let watchedError = $state<string | null>(null);

	const watchedOn = $derived(WATCHED.filter((entry) => watched[entry.key]).length);

	async function refreshWatched() {
		if (!hasBridge() || watchedBusy) return;
		try {
			const stored = await invoke<Record<string, unknown> | null>('get_watched_apps');
			if (!stored || typeof stored !== 'object') return;
			const next = { ...watched };
			for (const entry of WATCHED) {
				if (typeof stored[entry.key] === 'boolean') next[entry.key] = stored[entry.key] === true;
			}
			watched = next;
			watchedKnown = true;
		} catch {
			// The stored fact is missing or unreadable; the bridge's own default is
			// on for all five, so the switches keep showing that until one is tapped.
		}
	}

	/**
	 * One tap writes one key. The switch moves first so the row answers the
	 * finger, and snaps back with a sentence if the write is refused. The other
	 * four keys are never rewritten from here: the command merges them.
	 */
	async function toggleWatched(key: WatchKey, next: boolean) {
		if (watchedBusy) return;
		const before = watched[key];
		watched = { ...watched, [key]: next };
		watchedBusy = key;
		watchedError = null;
		try {
			await invoke('set_watched_app', { app: key, enabled: next });
			watchedKnown = true;
		} catch (error) {
			watched = { ...watched, [key]: before };
			watchedError = sentence(error);
		} finally {
			watchedBusy = null;
		}
	}

	// ------------------------------------------------------------- connection

	let baseUrl = $state('');
	let adminToken = $state('');
	let label = $state('');
	let platformId = $state('');
	let carrier = $state('');
	let simSlot = $state(0);
	let codeDeviceId = $state('');
	let codeInput = $state('');

	// A stored target may arrive after boot; keep the field in step without
	// overwriting what the operator is typing.
	let appliedTarget: string | null = null;
	/** A link filled the fields and the operator has not pressed Pair or Save yet. */
	let linkPending = $state(false);

	$effect(() => {
		const stored = app.target.base_url ?? '';
		if (stored === appliedTarget) return;
		appliedTarget = stored;
		if (linkPending) return;
		baseUrl = stored;
	});

	// A `dakflare://pair` link arrives as `/settings?pair=<the link>`: the Android
	// shell validates it and hands it over, and the layout routes here. Fill both
	// fields and stop. Pairing is the operator's confirm, never a side effect of
	// opening a link. Guarded so a re-render (or a later edit) applies it once.
	let appliedLink = $state<string | null>(null);
	$effect(() => {
		const raw = pairLinkRaw;
		if (!raw || raw === appliedLink) return;
		appliedLink = raw;
		const link = readPairLink(raw);
		if (!link) {
			app.notify(
				'pair',
				'That pairing link is malformed. Expected dakflare://pair?u=…&c=… with an http(s) worker URL and a 12-character code.',
				'error'
			);
			return;
		}
		baseUrl = link.baseUrl;
		codeInput = link.code;
		linkPending = true;
		app.notify(
			'pair',
			'Pairing link opened: the target and the code are filled in below. Check them, then press Pair with code. Nothing has been sent yet.',
			'info'
		);
	});

	$effect(() => {
		if (!app.devices.some((device) => device.device_id === codeDeviceId)) {
			codeDeviceId = app.selectedId || app.devices[0]?.device_id || '';
		}
	});

	const canPair = $derived(
		Boolean(codeDeviceId) && codeInput.trim().length > 0 && !app.busy.pair
	);

	async function saveTarget(event: SubmitEvent) {
		event.preventDefault();
		const saved = await app.saveTarget(baseUrl, adminToken);
		if (saved) {
			adminToken = '';
			linkPending = false;
		}
	}

	async function pairWithCode(event: SubmitEvent) {
		event.preventDefault();
		// A link fills the target field but does not save it. Saving here, on the
		// operator's explicit Pair press, is what makes a bare code usable without
		// a second trip to the target card. An unchanged field is left alone.
		const typedTarget = baseUrl.trim().replace(/\/+$/, '');
		const storedTarget = (app.target.base_url ?? '').trim().replace(/\/+$/, '');
		if (typedTarget && typedTarget !== storedTarget) {
			const saved = await app.saveTarget(typedTarget, adminToken);
			if (!saved) {
				app.notify('pair', 'The target could not be saved. Fix the Worker URL above, then retry.', 'error');
				return;
			}
			adminToken = '';
		}
		const paired = await app.pairWithCode(codeDeviceId, codeInput);
		// The code is spent; leaving it in the field invites a confusing retry.
		if (paired) {
			codeInput = '';
			linkPending = false;
			appliedLink = null;
		}
	}

	async function createIdentity(event: SubmitEvent) {
		event.preventDefault();
		const created = await app.createDevice({ label, platformId, carrier, simSlot });
		if (created) {
			label = '';
			platformId = '';
		}
	}

	// -------------------------------------------------------------- retention

	// The rule the frame shows selected. Kept beside the store so a refused
	// change snaps back instead of leaving the radio on the wrong rule.
	let policy = $state('forever');
	$effect(() => {
		if (app.retention) policy = app.retention.policy;
	});

	const keptBy = $derived(retentionKept(policy));
	const removalNote = $derived.by(() => {
		if (!app.retention) return 'reading the local database…';
		if (app.retention.last_purge_at === null) return 'never run';
		const removed = app.retention.last_deleted ?? 0;
		const when = relativeTime(app.retention.last_purge_at);
		return removed === 0 ? `${when} · nothing removed` : `${when} · ${removed} removed`;
	});

	async function chooseRetention(next: string) {
		if (next === policy) return;
		policy = next;
		const saved = await app.saveRetention(next);
		if (!saved) policy = app.retention?.policy ?? 'forever';
	}

	// --------------------------------------------------------------- facts row

	const defaultSmsRaw = $derived(app.facts?.default_sms_app?.trim() || null);
	// Android writes the literal "none" when no app holds the role; that is a
	// confirmed fact, not a missing one.
	const noDefaultSms = $derived(defaultSmsRaw === 'none');
	const otherDefaultSms = $derived(noDefaultSms ? null : defaultSmsRaw);
	const isDefaultSms = $derived(defaultSmsRaw === DEFAULT_SMS_PACKAGE);

	const smsStatus = $derived.by((): { word: string; tone: Tone } => {
		if (!app.backendAvailable) return { word: 'No Android', tone: 'neutral' };
		if (!app.factsLoaded) return { word: 'Checking', tone: 'neutral' };
		if (isDefaultSms) return { word: 'Default', tone: 'ok' };
		if (otherDefaultSms) return { word: 'Other app', tone: 'danger' };
		if (noDefaultSms) return { word: 'Not held', tone: 'warn' };
		return { word: 'Unreported', tone: 'neutral' };
	});

	const smsGranted = $derived(Number(perms.send_sms) + Number(perms.receive_sms));

	let smsBusy = $state(false);
	let smsError = $state<string | null>(null);

	async function allowSmsPermissions() {
		smsBusy = true;
		smsError = null;
		try {
			await invoke('request_sms_permissions');
			await refreshPerms();
		} catch (error) {
			smsError = sentence(error);
		} finally {
			smsBusy = false;
		}
	}

	// ------------------------------------------------------------------- rows

	const rows = $derived.by((): RowSpec[] => {
		const host = app.target.base_url?.replace(/^https?:\/\//, '').replace(/\/+$/, '') ?? null;
		const pairedNow = Boolean(app.pairedAt[app.selectedId] ?? app.pairingAt[app.selectedId]);
		const connection: Row = !app.configured
			? { summary: 'No Worker URL yet', word: 'Not set', tone: 'neutral' }
			: app.devices.length === 0
				? { summary: host ?? 'Target set', word: 'No identity', tone: 'warn' }
				: pairedNow
					? { summary: host ?? 'Target set', word: 'Paired', tone: 'ok' }
					: { summary: host ?? 'Target set', word: 'Unpaired', tone: 'warn' };

		const channels: Row = !permKnown
			? { summary: 'Android permission state not read', word: 'Unknown', tone: 'neutral' }
			: listenerOn
				? {
						summary: watchedKnown ? `${watchedOn} of 5 apps watched` : 'Notification Access on',
						word: 'Enabled',
						tone: watchedOn === 0 ? 'warn' : 'ok'
					}
				: { summary: 'Notification Access off', word: 'Off', tone: 'warn' };

		const devices: Row = app.selected
			? {
					summary: app.selected.label,
					word: plural(app.devices.length, 'device', 'devices'),
					tone: 'ok'
				}
			: { summary: 'No identity on this phone', word: 'None', tone: 'neutral' };

		const build: Row = {
			summary: !app.backendAvailable
				? 'Browser preview, no local database'
				: app.offline
					? 'Carrier off. Messages stay on the phone.'
					: app.selectedId
						? 'Carrier on. Injects upload to the Worker.'
						: 'No identity, so nothing uploads yet',
			word: app.schemaVersion === null ? 'No schema' : `v${app.schemaVersion}`,
			tone: app.offline ? 'danger' : 'neutral'
		};

		return [
			{ id: 'connection', title: SECTION_TITLES.connection, ...connection },
			{ id: 'channels', title: SECTION_TITLES.channels, ...channels },
			{
				id: 'sms',
				title: SECTION_TITLES.sms,
				summary: isDefaultSms
					? 'DakFlare holds the role'
					: otherDefaultSms
						? 'Another app holds the role'
						: noDefaultSms
							? 'No app holds the role'
							: 'Android has not reported the holder',
				...smsStatus
			},
			{
				id: 'log',
				title: SECTION_TITLES.log,
				summary: app.retention
					? removalNote
					: app.backendAvailable
						? 'Reading the local database'
						: 'This window has no local database',
				word: app.retention
					? retentionWords(app.retention.policy)
					: app.backendAvailable
						? 'Reading'
						: 'No log',
				tone: 'neutral'
			},
			{ id: 'devices', title: SECTION_TITLES.devices, ...devices },
			{ id: 'build', title: SECTION_TITLES.build, ...build }
		];
	});

	const identityLine = $derived(
		app.selected
			? `${app.selected.label} · ${app.selected.carrier ?? 'carrier unknown'}`
			: 'No identity on this phone'
	);

	const footLine = $derived(
		`${plural(app.devices.length, 'identity', 'identities')} · ${
			app.schemaVersion === null ? 'schema unread' : `schema v${app.schemaVersion}`
		}`
	);

	// ------------------------------------------------------------------- mount

	// A role dialog, a permission prompt and Notification Access all hand the
	// screen to Android. Every return re-reads the facts rather than trusting the
	// tap that left: the grant is only real once Android says so.
	onMount(() => {
		void app.loadRetention();
		if (!hasBridge()) return;

		void loadVersion();
		void refreshPerms();
		void refreshWatched();

		const resume = () => {
			if (document.visibilityState !== 'visible') return;
			void refreshPerms();
			void refreshWatched();
			void app.loadFacts();
			void app.loadRetention();
		};

		window.addEventListener('focus', resume);
		document.addEventListener('visibilitychange', resume);
		return () => {
			window.removeEventListener('focus', resume);
			document.removeEventListener('visibilitychange', resume);
		};
	});
</script>

<svelte:head>
	<title>{activeTitle} · DakFlare</title>
</svelte:head>

<section class="screen" data-view={activeSection}>
	{#if activeSection === 'root'}
		<header class="hub-head">
			<span class="hub-rule" aria-hidden="true"></span>
			<p class="eyebrow">Handset</p>
			<h1>Settings</h1>
			<p class="hub-ident" title={identityLine}>{identityLine}</p>
		</header>

		<nav class="hub" aria-label="Settings sections">
			{#each rows as row, index (row.id)}
				<button
					type="button"
					class="hub-row"
					data-tone={row.tone}
					style={`--i: ${index}`}
					title={`${row.title}: ${row.summary}`}
					onclick={() => openSection(row.id)}
				>
					<span class="hub-dot" aria-hidden="true"></span>
					<span class="hub-copy">
						<span class="hub-title">{row.title}</span>
						<span class="hub-summary">{row.summary}</span>
					</span>
					<span class="hub-tail">
						<span class="hub-word">{row.word}</span>
						<svg
							class="chev"
							viewBox="0 0 16 16"
							width="12"
							height="12"
							fill="none"
							stroke="currentColor"
							stroke-width="1.7"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"
							focusable="false"
						>
							<path d="m6 3 5 5-5 5" />
						</svg>
					</span>
				</button>
			{/each}
		</nav>

		<p class="hub-foot">{footLine}</p>
	{:else}
		<header class="section-head">
			<button type="button" class="back" onclick={backToHub}>
				<Icon name="chevron-left" size={16} />
				Settings
			</button>
			<h1>{activeTitle}</h1>
			<p class="section-sub">{activeSub}</p>
		</header>

		{#key activeSection}
			<div class="view">
				{#if activeSection === 'connection'}
					<section class="sheet" aria-labelledby="target-title">
						<div class="sheet-head">
							<h2 class="sheet-title" id="target-title">Target deployment</h2>
							<span class="pill" data-state={app.configured ? 'live' : 'unknown'}>
								{app.configured ? 'Set' : 'Not set'}
							</span>
						</div>

						<form onsubmit={saveTarget}>
							<div class="field">
								<label for="base-url">Worker URL</label>
								<input
									id="base-url"
									bind:value={baseUrl}
									placeholder="https://dakflare-worker.<account>.workers.dev"
									autocomplete="off"
									spellcheck="false"
									disabled={!app.backendAvailable}
								/>
							</div>
							<p class="note">
								A pairing link sets this for you. Enter it by hand only when you are typing a
								bare code.
							</p>

							{#if import.meta.env.DEV}
								<details class="advanced">
									<summary>Admin overrides (lab)</summary>
									<p>
										Not needed to pair. These credentials are only for self-pair, purge and
										revoke on a lab deployment.
									</p>
									<div class="field">
										<label for="admin-token">
											Admin token {app.target.has_admin_token ? '(stored)' : '(not stored)'}
										</label>
										<input
											id="admin-token"
											type="password"
											bind:value={adminToken}
											placeholder={app.target.has_admin_token ? 'leave blank to keep' : 'ADMIN_TOKEN'}
											autocomplete="off"
											disabled={!app.backendAvailable}
										/>
										<small>
											Stored in this app's local database. It is never sent when pairing with a
											code.
										</small>
									</div>
								</details>
							{/if}

							<div class="form-actions">
								<button class="btn" type="submit" disabled={!app.backendAvailable || app.busy.target}>
									{app.busy.target ? 'Saving…' : 'Save target'}
								</button>
							</div>
							<Notice scope="target" />
						</form>
					</section>

					<section class="sheet" aria-labelledby="pair-title">
						<h2 class="sheet-title" id="pair-title">Pair with code</h2>

						{#if app.devices.length === 0}
							<!-- Pairing registers this phone's keypair with the deployment,
							     so there is nothing to pair until one exists. -->
							<p class="note">
								Pairing registers this phone's keypair with the deployment. Create an identity
								first, then come back for the code.
							</p>
							<div class="form-actions">
								<button class="btn" type="button" onclick={() => openSection('devices')}>
									Create an identity
								</button>
							</div>
						{:else}
							<p class="note">
								The operator mints a one-time code in the dashboard. Paste the code, or the
								whole <code>dakflare://pair?u=…&amp;c=…</code> link, whose worker URL is saved as
								the target first. No admin token is needed.
							</p>

							<form onsubmit={pairWithCode}>
								<div class="field">
									<label for="pair-device">Device</label>
									<select id="pair-device" bind:value={codeDeviceId}>
										{#each app.devices as device (device.device_id)}
											<option value={device.device_id}>
												{device.label} · {device.device_id.slice(0, 8)}…
											</option>
										{/each}
									</select>
								</div>
								<div class="field">
									<label for="pair-code">Code or link</label>
									<input
										id="pair-code"
										bind:value={codeInput}
										placeholder="AB12CD34EF56 or dakflare://pair?u=…&c=…"
										autocomplete="off"
										spellcheck="false"
										disabled={!app.backendAvailable}
									/>
								</div>
								<p class="note">
									Single-use and short-lived. If it fails, mint a fresh code and retry.
								</p>
								<div class="form-actions">
									<button class="btn primary" type="submit" disabled={!app.backendAvailable || !canPair}>
										{app.busy.pair ? 'Pairing…' : 'Pair with code'}
									</button>
								</div>
								<Notice scope="pair" />
							</form>
						{/if}
					</section>
				{:else if activeSection === 'channels'}
					<div class="seg" role="tablist" aria-label="Personal channels view">
						<button
							id="tab-access"
							type="button"
							role="tab"
							class="seg-btn"
							aria-selected={channelTab === 'access'}
							aria-controls="panel-access"
							tabindex={channelTab === 'access' ? 0 : -1}
							onclick={() => selectChannelTab('access')}
							onkeydown={onTabKey}
						>
							Access &amp; permissions
						</button>
						<button
							id="tab-apps"
							type="button"
							role="tab"
							class="seg-btn"
							aria-selected={channelTab === 'apps'}
							aria-controls="panel-apps"
							tabindex={channelTab === 'apps' ? 0 : -1}
							onclick={() => selectChannelTab('apps')}
							onkeydown={onTabKey}
						>
							Watched apps
						</button>
					</div>

					<div
						class="tab-body"
						id="panel-access"
						role="tabpanel"
						aria-labelledby="tab-access"
						hidden={channelTab !== 'access'}
					>
						<section class="sheet" aria-label="Access and permissions">
							<div class="sheet-head">
								<h2 class="sheet-title">Notification Access</h2>
								<span class="pill" data-state={pillState(listenerTone)}>{listenerWord}</span>
							</div>
							<p class="note">
								Android grants this to one app at a time. It is what lets the bridge read personal
								chats here, and the state re-reads when you come back from its screen.
							</p>

							{#if !hasBridge()}
								<p class="state-line">
									This window has no Android permission interface, so the grant can only be read on
									the phone.
								</p>
							{:else if !permKnown}
								<p class="state-line">Reading Android's permission state…</p>
							{:else if listenerOn}
								<p class="state-line">
									Granted in Android. Turn it off there if capture should stop.
								</p>
							{:else}
								<div class="form-actions">
									<button
										class="btn primary wide"
										type="button"
										disabled={permBusy !== null}
										onclick={openNotificationAccess}
									>
										{permBusy === 'listener' ? 'Opening…' : 'Open Notification Access'}
									</button>
								</div>
							{/if}

							{#if hasBridge()}
								<div class="sheet-actions">
									<button
										class="btn small"
										type="button"
										disabled={permBusy !== null}
										onclick={recheckPerms}
									>
										{permBusy === 'refresh' ? 'Checking…' : 'Check again'}
									</button>
								</div>
							{/if}
							{#if permError}
								<p class="row-error" role="alert">{permError}</p>
							{/if}

							<div class="hairline" aria-hidden="true"></div>
							<h3 class="sheet-title">System permissions</h3>

							<div class="perm-row">
								<span class="perm-label">Notifications</span>
								<span class="perm-word" data-tone={perms.notifications ? 'ok' : 'warn'}>
									{perms.notifications ? 'Allowed' : permKnown ? 'Off' : 'Unknown'}
								</span>
								{#if permKnown && !perms.notifications && hasBridge()}
									<button
										class="btn small"
										type="button"
										disabled={permBusy !== null}
										onclick={() => askSystem('request_notifications', 'notifications')}
									>
										{permBusy === 'notifications' ? 'Opening…' : 'Allow'}
									</button>
								{/if}
							</div>

							<div class="perm-row">
								<span class="perm-label">Battery exemption</span>
								<span class="perm-word" data-tone={perms.battery_exempt ? 'ok' : 'warn'}>
									{perms.battery_exempt ? 'Exempt' : permKnown ? 'Restricted' : 'Unknown'}
								</span>
								{#if permKnown && !perms.battery_exempt && hasBridge()}
									<button
										class="btn small"
										type="button"
										disabled={permBusy !== null}
										onclick={() => askSystem('request_battery_exemption', 'battery')}
									>
										{permBusy === 'battery' ? 'Opening…' : 'Allow'}
									</button>
								{/if}
							</div>

							<p class="note">The exemption keeps Android from pausing the app between messages.</p>
							{#if !hasBridge()}
								<p class="note">This window has no Android permission interface.</p>
							{/if}
						</section>
					</div>

					<div
						class="tab-body"
						id="panel-apps"
						role="tabpanel"
						aria-labelledby="tab-apps"
						hidden={channelTab !== 'apps'}
					>
						<section class="sheet" aria-label="Watched apps">
							<div class="sheet-head">
								<h2 class="sheet-title">Watched apps</h2>
								<span class="pill" data-state={watchedOn === 5 ? 'live' : 'unknown'}>
									{watchedOn} of 5
								</span>
							</div>
							<p class="note">
								Only these five are read. A reply from a thread lands in the app it came from.
							</p>

							<div class="watch-list">
								{#each WATCHED as entry (entry.key)}
									<div class="watch-item">
										<Toggle
											label={entry.name}
											checked={watched[entry.key]}
											busy={watchedBusy === entry.key}
											disabled={watchedBusy !== null}
											onchange={(next) => toggleWatched(entry.key, next)}
										/>
									</div>
								{/each}
							</div>

							{#if !listenerOn}
								<p class="note">Stored now; capture starts once Notification Access is granted.</p>
							{/if}
							{#if watchedError}
								<p class="row-error" role="alert">{watchedError}</p>
							{/if}
						</section>
					</div>

				{:else if activeSection === 'sms'}
					<section class="sheet" aria-labelledby="sms-role-title">
						<div class="sheet-head">
							<h2 class="sheet-title" id="sms-role-title">The role</h2>
							<span class="pill" data-state={pillState(smsStatus.tone)}>
								{smsStatus.word}
							</span>
						</div>
						<p class="note">
							Since Android 4.4 only the default SMS app reliably receives inbound SMS.
							Without the role this gateway works only while no other app holds it.
						</p>

						{#if otherDefaultSms}
							<p class="value-line">{otherDefaultSms}</p>
							<p class="note">Another app handles SMS on this phone.</p>
						{:else if noDefaultSms}
							<p class="note">Android did not name a holder to this app.</p>
						{:else if !app.backendAvailable}
							<p class="note">This window has no Android report to read.</p>
						{:else if !app.factsLoaded}
							<p class="note">Reading Android's report…</p>
						{/if}

						{#if !isDefaultSms && app.factsLoaded}
							<div class="form-actions">
								<button
									class="btn primary wide"
									type="button"
									disabled={!app.backendAvailable || app.busy.defaultSms}
									onclick={() => app.requestDefaultSmsRole()}
								>
									{app.busy.defaultSms ? 'Opening…' : 'Make DakFlare the default SMS app'}
								</button>
							</div>
							<p class="note">
								Android confirms the change in its own dialog. This row keeps its old word
								until Android reports the new holder.
							</p>
						{/if}
						<Notice scope="default-sms" />
					</section>

					<section class="sheet" aria-labelledby="sms-perm-title">
						<div class="sheet-head">
							<h2 class="sheet-title" id="sms-perm-title">Text permissions</h2>
							<span class="pill" data-state={smsGranted === 2 && permKnown ? 'live' : 'unknown'}>
								{permKnown ? `${smsGranted} of 2` : 'Reading'}
							</span>
						</div>

						<div class="perm-row">
							<span class="perm-label">Send text messages</span>
							<span class="perm-word" data-tone={perms.send_sms ? 'ok' : 'warn'}>
								{perms.send_sms ? 'Allowed' : permKnown ? 'Not allowed' : 'Unknown'}
							</span>
						</div>
						<div class="perm-row">
							<span class="perm-label">Receive text messages</span>
							<span class="perm-word" data-tone={perms.receive_sms ? 'ok' : 'warn'}>
								{perms.receive_sms ? 'Allowed' : permKnown ? 'Not allowed' : 'Unknown'}
							</span>
						</div>

						{#if permKnown && smsGranted < 2 && hasBridge()}
							<div class="form-actions">
								<button class="btn wide" type="button" disabled={smsBusy} onclick={allowSmsPermissions}>
									{smsBusy ? 'Opening…' : 'Allow text messages'}
								</button>
							</div>
							<p class="note">Android asks for both at once, in one dialog.</p>
						{:else if !hasBridge() && smsGranted < 2}
							<p class="note">Permissions can only be granted from the phone.</p>
						{/if}
						{#if smsError}
							<p class="row-error" role="alert">{smsError}</p>
						{/if}
					</section>
				{:else if activeSection === 'log'}
					<section class="sheet" aria-labelledby="retention-title">
						<div class="sheet-head">
							<h2 class="sheet-title" id="retention-title">Keep messages</h2>
							<span class="pill" data-state={policy === 'forever' ? 'unknown' : 'live'}>
								{retentionWords(policy)}
							</span>
						</div>
						<p class="note">
							Messages stay on this phone until this rule removes them. It runs when you open
							the app and on the phone's own schedule. The deployment's copy is not touched,
							and a message the gateway has not received yet is never removed.
						</p>

						<fieldset class="keep" disabled={!app.backendAvailable || app.busy.retention}>
							<legend class="keep-title">Keep messages</legend>
							{#each KEEP_OPTIONS as option (option.policy)}
								<label class="keep-option" data-selected={policy === option.policy}>
									<input
										type="radio"
										name="retention"
										value={option.policy}
										checked={policy === option.policy}
										onchange={() => chooseRetention(option.policy)}
									/>
									<span class="keep-name">{option.name}</span>
									<span class="keep-detail">{option.detail}</span>
									{#if policy === option.policy}
										<!-- A tick as well as the tint: the chosen rule must not be
										     something only the colour says. -->
										<span class="keep-tick" aria-hidden="true"><Icon name="check" size={12} /></span>
									{/if}
								</label>
							{/each}
						</fieldset>

						<div class="rows">
							<div class="rowline">
								<span class="label">Kept</span>
								<span class="value">{keptBy}</span>
							</div>
							<div class="rowline">
								<span class="label">Last run</span>
								<span class="value mono">{removalNote}</span>
							</div>
						</div>
						<Notice scope="retention" />
					</section>

					<section class="sheet" aria-labelledby="clear-title">
						<h2 class="sheet-title" id="clear-title">Clear this phone's copy</h2>
						<p class="note">
							Removes the messages stored on this phone for the selected identity. The
							deployment keeps its copy; purge that from Devices &amp; identity.
						</p>

						<div class="form-actions">
							<AlertDialog.Root>
								<AlertDialog.Trigger
									class="btn danger-ghost wide"
									disabled={!app.selectedId || app.busy.clear}
								>
									Clear local log
								</AlertDialog.Trigger>
								<AlertDialog.Portal>
									<AlertDialog.Overlay class="overlay" />
									<AlertDialog.Content class="dialog" aria-labelledby="clear-dialog-title">
										<h3 id="clear-dialog-title">Clear this phone's message log?</h3>
										<p>
											Every message stored here for this identity is removed. The deployment's
											copy stays, and a message that has not been uploaded yet is lost with it.
										</p>
										<div class="row">
											<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
											<AlertDialog.Action class="danger" onclick={() => app.clearThread('log')}>
												Clear log
											</AlertDialog.Action>
										</div>
									</AlertDialog.Content>
								</AlertDialog.Portal>
							</AlertDialog.Root>
						</div>
						<Notice scope="log" />
					</section>
				{:else if activeSection === 'devices'}
					<section class="sheet" aria-labelledby="identity-title">
						<h2 class="sheet-title" id="identity-title">New identity</h2>
						<p class="note">
							This creates a real P-256 keypair. The public half registers with the deployment
							at pairing; the private half never leaves this device.
						</p>

						<form onsubmit={createIdentity}>
							<div class="field">
								<label for="label">Label</label>
								<input id="label" bind:value={label} placeholder="Pixel 8 · reception" autocomplete="off" />
							</div>

							<details class="advanced">
								<summary>Carrier, SIM slot and ANDROID_ID</summary>
								<p>
									These belong to the identity. Android's own report of the handset is on the
									Device tab.
								</p>
								<div class="field">
									<label for="platform-id">
										ANDROID_ID <span class="muted">(hint, optional)</span>
									</label>
									<input id="platform-id" bind:value={platformId} placeholder="a1b2c3d4e5f6" autocomplete="off" />
									<small>Never used to authenticate, only for duplicate detection and support.</small>
								</div>
								<div class="field">
									<label for="carrier">Carrier <span class="muted">(optional)</span></label>
									<input id="carrier" bind:value={carrier} placeholder="Grameenphone" autocomplete="off" />
								</div>
								<div class="field">
									<label for="sim-slot">SIM slot</label>
									<select id="sim-slot" bind:value={simSlot}>
										<option value={0}>0 (default)</option>
										<option value={1}>1 (SIM 1)</option>
										<option value={2}>2 (SIM 2)</option>
									</select>
								</div>
							</details>

							<div class="form-actions">
								<button class="btn" type="submit" disabled={!app.backendAvailable || app.busy.create}>
									{app.busy.create ? 'Generating…' : 'Create identity'}
								</button>
							</div>
							<Notice scope="identity" />
						</form>
					</section>

					<section class="sheet" aria-labelledby="devices-title">
						<div class="sheet-head">
							<h2 class="sheet-title" id="devices-title">Devices · {app.devices.length}</h2>
							<button
								class="btn small"
								type="button"
								onclick={() => app.reloadDevices()}
								disabled={!app.backendAvailable || app.busy.devices}
							>
								{app.busy.devices ? 'Refreshing…' : 'Refresh'}
							</button>
						</div>

						{#if app.loading.boot}
							<p class="quiet-state">Opening the local database…</p>
						{:else if !app.backendAvailable}
							<p class="quiet-state">The local database is not reachable in this window.</p>
						{:else if app.devices.length === 0}
							<p class="quiet-state">No device identity yet. Create one above, then pair it with a code.</p>
						{:else}
							{#each app.devices as device (device.device_id)}
								<article class="device">
									<div class="device-head">
										<div>
											<strong>{device.label}</strong>
											<div class="device-id" title={device.device_id}>{device.device_id.slice(0, 18)}…</div>
										</div>
										<span class="pill">{device.platform}</span>
									</div>

									<div class="facts">
										<div class="fact"><b>Carrier</b><span>{device.carrier ?? 'unknown'}</span></div>
										<div class="fact"><b>SIM slot</b><span>{device.sim_slot}</span></div>
										<div class="fact"><b>ANDROID_ID</b><span>{device.platform_id ?? 'unknown'}</span></div>
										<div class="fact">
											<b>Pairing</b>
											<span>
												{(app.pairedAt[device.device_id] ?? app.pairingAt[device.device_id])
													? `paired ${relativeTime(app.pairedAt[device.device_id] ?? app.pairingAt[device.device_id])}`
													: lastContact(app.contactAt[device.device_id], app.lastContactAt[device.device_id])
														? 'signed contact answered'
														: 'not recorded'}
											</span>
										</div>
										<div class="fact"><b>Created</b><span>{new Date(device.created_at).toLocaleDateString()}</span></div>
									</div>

									<div class="device-actions">
										{#if import.meta.env.DEV}
											<button
												class="btn small"
												type="button"
												disabled={!app.configured || app.busy.selfPair}
												title="Mints a code with the stored admin token. Pair with code is the normal path."
												onclick={() => app.selfPair(device.device_id)}
											>
												Self-pair (lab)
											</button>
										{/if}
										<button
											class="btn small"
											type="button"
											disabled={!app.configured || app.busy.purge}
											title="Removes this device's message log on the deployment, not the local thread."
											onclick={() => app.purge(device.device_id)}
										>
											Purge log
										</button>

										<AlertDialog.Root>
											<AlertDialog.Trigger class="btn small danger-ghost">Delete</AlertDialog.Trigger>
											<AlertDialog.Portal>
												<AlertDialog.Overlay class="overlay" />
												<AlertDialog.Content class="dialog" aria-labelledby={`delete-${device.device_id}`}>
													<h3 id={`delete-${device.device_id}`}>Delete {device.label}?</h3>
													<p>
														This removes the local keypair. If the device is paired, revoke it
														first or the deployment will keep trusting the old key.
													</p>
													<div class="row">
														<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
														<AlertDialog.Action
															class="danger"
															onclick={() => app.deleteDevice(device.device_id)}
														>
															Delete device
														</AlertDialog.Action>
													</div>
												</AlertDialog.Content>
											</AlertDialog.Portal>
										</AlertDialog.Root>
									</div>

									<Notice scope={`settings:${device.device_id}`} />
								</article>
							{/each}
							<p class="note">
								Purge log clears the deployment copy only. The local thread is cleared from
								Local message log.
							</p>
						{/if}
						<Notice scope="devices" />
					</section>
				{:else if activeSection === 'build'}
					<section class="sheet" aria-labelledby="build-title">
						<h2 class="sheet-title" id="build-title">What this build reports</h2>
						<div class="rows">
							<div class="rowline">
								<span class="label">App version</span>
								<span class="value mono">{version ?? 'not reported'}</span>
							</div>
							<div class="rowline">
								<span class="label">Local schema</span>
								<span class="value mono">
									{app.schemaVersion === null ? 'unavailable' : `v${app.schemaVersion}`}
								</span>
							</div>
							<div class="rowline">
								<span class="label">Storage</span>
								<span class="value mono">
									{app.backendAvailable ? 'local database' : 'browser preview'}
								</span>
							</div>
							<div class="rowline">
								<span class="label">Identity</span>
								<span class="value">{app.selected?.label ?? 'none on this phone'}</span>
							</div>
							<div class="rowline">
								<span class="label">Target</span>
								<span class="value mono url">{app.target.base_url ?? 'not set'}</span>
							</div>
						</div>
					</section>

					<section class="sheet" aria-labelledby="carrier-title">
						<h2 class="sheet-title" id="carrier-title">Carrier</h2>
						<Toggle
							label="Carrier off"
							hint={app.selected
								? 'Messages stay on this phone and nothing uploads until it is turned back on.'
								: 'Create an identity first: the switch is stored per identity.'}
							checked={app.offline}
							disabled={!app.selectedId || app.busy.offline}
							onchange={(next) => app.setOffline(next, 'offline')}
						/>
						<Notice scope="offline" />
					</section>
				{/if}
			</div>
		{/key}
	{/if}
</section>

<style>
	/* MainActivity already pads the content view by the system bars, so these read
	   0 on Android. They exist for an edge-to-edge shell and for the desktop
	   workbench, where the app has to keep its own distance from the status bar and
	   the gesture bar. */
	.screen {
		padding-top: calc(var(--df-p-space-2) + env(safe-area-inset-top, 0px));
		padding-bottom: calc(var(--df-p-space-6) + env(safe-area-inset-bottom, 0px));
	}

	/* The hub is one screen, not a scroll: it takes the height it is given and
	   puts its meta line at the bottom, so a six-row list reads as a complete
	   screen on a 360 x 800 phone instead of stopping two thirds down. */
	.screen[data-view='root'] {
		display: flex;
		flex-direction: column;
		min-height: 100%;
	}

	/* ------------------------------------------------------------- hub head */

	.hub-head {
		padding: 0 0 12px;
	}

	.hub-rule {
		display: block;
		width: 32px;
		height: 3px;
		margin-bottom: 9px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-accent-decor);
	}

	.hub-head h1 {
		font-family: var(--display);
		font-size: var(--df-p-text-2xl);
		line-height: 1.1;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--ink);
	}

	.hub-ident {
		margin-top: 2px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--mono);
		font-size: 10.5px;
		color: var(--ink-3);
	}

	/* ------------------------------------------------------------------ hub */

	.hub {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--df-p-radius-lg);
		box-shadow: var(--df-shadow-card);
	}

	/* One line of title, one of summary, one state word: 56px on a 360 wide
	   phone, which is what keeps all six rows above the dock at 800 tall. */
	.hub-row {
		display: grid;
		grid-template-columns: 7px minmax(0, 1fr) auto;
		align-items: center;
		gap: 10px;
		width: 100%;
		min-height: 56px;
		padding: 9px 14px;
		border: 0;
		border-top: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition: background-color 120ms ease-out;
		/* One orchestrated arrival, in reading order. */
		animation: hub-in var(--df-p-dur-settle) var(--df-p-ease-standard) both;
		animation-delay: calc(var(--i, 0) * 32ms);
	}

	.hub-row:first-child {
		border-top: 0;
	}

	@media (hover: hover) and (pointer: fine) {
		.hub-row:hover {
			background: var(--df-surface-well);
		}
	}

	.hub-row:active {
		background: var(--df-surface-press);
	}

	.hub-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 16%, transparent);
	}

	.hub-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.hub-title {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--display);
		font-size: var(--df-p-text-md);
		line-height: 1.25;
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--ink);
	}

	.hub-summary {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 11px;
		line-height: 1.35;
		color: var(--ink-3);
	}

	.hub-tail {
		display: flex;
		flex: none;
		align-items: center;
		gap: 4px;
	}

	.hub-word {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.01em;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
		color: var(--ink-3);
	}

	.chev {
		flex: none;
		color: var(--ink-3);
	}

	.hub-row[data-tone='ok'] .hub-dot,
	.hub-row[data-tone='ok'] .hub-word {
		color: var(--df-state-ok-ink);
	}

	.hub-row[data-tone='warn'] .hub-dot,
	.hub-row[data-tone='warn'] .hub-word {
		color: var(--df-state-warn-ink);
	}

	.hub-row[data-tone='danger'] .hub-dot,
	.hub-row[data-tone='danger'] .hub-word {
		color: var(--df-state-danger-ink);
	}

	.hub-row[data-tone='neutral'] .hub-dot,
	.hub-row[data-tone='neutral'] .hub-word {
		color: var(--ink-3);
	}

	.hub-foot {
		margin-top: auto;
		padding: 14px 2px 2px;
		font-family: var(--mono);
		font-size: 10.5px;
		letter-spacing: 0.01em;
		color: var(--ink-3);
	}

	@keyframes hub-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}

	/* --------------------------------------------------------- section head */

	.section-head {
		padding: 0;
	}

	/* 44px is the floor even though this is a quiet control: it is the way back
	   from every section, and it sits at the top edge of a phone screen. */
	.back {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 44px;
		margin-left: -8px;
		padding: 0 8px;
		border: 0;
		border-radius: var(--df-p-radius-sm);
		background: transparent;
		color: var(--accent);
		font-size: 13px;
		font-weight: 700;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			background: var(--df-surface-well);
		}
	}

	.section-head h1 {
		margin-top: 2px;
		font-family: var(--display);
		font-size: 22px;
		line-height: 1.15;
		font-weight: 800;
		letter-spacing: -0.02em;
		color: var(--ink);
		text-wrap: pretty;
	}

	.section-sub {
		max-width: 48ch;
		margin-top: 2px;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--ink-3);
		text-wrap: pretty;
	}

	.view {
		animation: view-in var(--df-p-dur-lift) var(--df-p-ease-standard) both;
	}

	@keyframes view-in {
		from {
			opacity: 0;
			transform: translateY(4px);
		}
	}

	/* -------------------------------------------------------- section bodies */

	/* A drill-down is read top to bottom on a 360 wide phone, so every card
	   loses a little padding and gap against the shared sheet. */
	.view .sheet {
		margin-top: 10px;
		padding: 14px;
	}

	.view .sheet-head {
		margin-bottom: 4px;
	}

	.view .sheet .note {
		margin-top: 6px;
	}

	.view .sheet .field {
		margin-top: 10px;
	}

	.view .form-actions {
		margin-top: 10px;
	}

	.view .rows {
		margin-top: 4px;
	}

	/* Two panels instead of three stacked cards. The control is 50px tall, so
	   each half keeps a 44px target inside its 3px gutter. */
	.seg {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 3px;
		margin-top: 10px;
		padding: 3px;
		border: 1px solid var(--line);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
	}

	.seg-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 44px;
		padding: 0 10px;
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-pill);
		background: transparent;
		color: var(--ink-2);
		font-size: 12px;
		font-weight: 600;
		line-height: 1.2;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--df-p-dur-lift) var(--df-p-ease-standard),
			color var(--df-p-dur-lift) var(--df-p-ease-standard);
	}

	/* Selected is a lifted fill, a border and a heavier weight: three signals,
	   so the panel in view is never carried by colour alone. */
	.seg-btn[aria-selected='true'] {
		border-color: var(--line);
		/* `selected` is lighter than the well in both themes, so the thumb reads
		   raised in light and in dark, where `card` would read as a hole. */
		background: var(--df-surface-selected);
		color: var(--ink);
		font-weight: 700;
		box-shadow: var(--df-shadow-card);
	}

	.seg-btn:focus-visible {
		outline-offset: -2px;
	}

	.tab-body {
		animation: view-in var(--df-p-dur-lift) var(--df-p-ease-standard) both;
	}

	/* The one divider inside a card that holds two topics. */
	.hairline {
		height: 1px;
		margin: 12px 0 10px;
		background: var(--line);
	}

	.sheet-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}

	.state-line {
		margin-top: 10px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--ink-2);
		text-wrap: pretty;
	}

	/* The shared chip ships live, offline and unknown. A grant that is off but
	   fixable from here is a warning, not a failure, so it gets the butter pair. */
	.pill[data-state='warn'] {
		background: var(--df-state-warn-bg);
		border-color: transparent;
		color: var(--df-state-warn-ink);
	}

	.value-line {
		margin-top: 8px;
		font-family: var(--mono);
		font-size: 12px;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	/* A URL is read left to right, and it breaks anywhere rather than at a
	   hyphen in the middle of a host name. */
	.rowline .value.url {
		text-align: left;
		word-break: break-all;
	}

	.row-error {
		margin-top: 10px;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--df-state-danger-ink);
		overflow-wrap: anywhere;
	}

	.perm-row {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 44px;
		padding: 2px 0;
		border-top: 1px solid var(--line);
	}

	.perm-row:first-of-type {
		border-top: 0;
	}

	.perm-label {
		flex: 1 1 auto;
		min-width: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
	}

	.perm-word {
		flex: none;
		font-size: 11.5px;
		font-weight: 700;
		white-space: nowrap;
		color: var(--ink-3);
	}

	.perm-word[data-tone='ok'] {
		color: var(--df-state-ok-ink);
	}

	.perm-word[data-tone='warn'] {
		color: var(--df-state-warn-ink);
	}

	.watch-list {
		margin-top: 4px;
		border-top: 1px solid var(--line);
	}

	.watch-item + .watch-item {
		border-top: 1px solid var(--line);
	}

	.advanced {
		margin-top: 12px;
		padding: 0;
		border-top: 1px solid var(--line);
	}

	/* A disclosure row, not a filled block: the marker has to stay visible, so
	   this stays a list item rather than a flex row. */
	.advanced summary {
		padding: 10px 0;
		min-height: 44px;
		font-size: 11.5px;
		font-weight: 700;
		color: var(--ink-2);
		cursor: pointer;
	}

	.advanced[open] summary {
		padding-bottom: 4px;
	}

	.advanced p {
		margin: 2px 0 4px;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink-3);
		text-wrap: pretty;
	}

	/* The one control on this screen where a wrong tap deletes history, so it is
	   four named cards rather than a dropdown that hides the consequences. */
	.keep {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
		margin: 12px 0 0;
		padding: 0;
		border: 0;
	}

	.keep-title {
		grid-column: 1 / -1;
		padding: 0;
		margin-bottom: 1px;
		font-size: 11px;
		font-weight: 600;
		color: var(--ink-2);
	}

	.keep-option {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-height: 56px;
		padding: 9px 11px;
		border: 1px solid var(--df-border-input);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
		cursor: pointer;
		transition:
			border-color 140ms ease-out,
			background-color 140ms ease-out;
	}

	/* 2px plus the tick: the selection is a shape and a mark before it is a tint,
	   which is what a reader who cannot see coral still gets. */
	.keep-option[data-selected='true'] {
		border: 2px solid var(--accent);
		padding: 8px 10px;
		background: var(--accent-soft);
	}

	.keep-tick {
		position: absolute;
		top: 7px;
		right: 7px;
		display: grid;
		place-items: center;
		color: var(--accent);
	}

	.keep-option:has(input:focus-visible) {
		outline: var(--df-p-focus-width) solid var(--df-border-focus);
		outline-offset: var(--df-p-focus-offset);
	}

	.keep-option input {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	.keep-name {
		font-size: 13px;
		font-weight: 700;
		color: var(--ink);
		font-variant-numeric: tabular-nums;
	}

	.keep-detail {
		font-size: 10.5px;
		line-height: 1.35;
		color: var(--ink-3);
	}

	.keep:disabled .keep-option {
		opacity: 0.55;
		cursor: default;
	}
</style>
