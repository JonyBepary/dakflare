import { invoke } from '@tauri-apps/api/core';
import { goto } from '$app/navigation';

/** This app's applicationId; the default-SMS fact reports a package name. */
export const DEFAULT_SMS_PACKAGE = 'dev.dakflare.simulator';

export type Device = {
	device_id: string;
	public_key_spki: string;
	platform: string;
	platform_id: string | null;
	label: string;
	carrier: string | null;
	sim_slot: number;
	created_at: number;
	updated_at: number;
};

export type TargetView = { base_url: string | null; has_admin_token: boolean };

export type Message = {
	id: string;
	device_id: string;
	direction: 'in' | 'out';
	peer: string;
	body: string;
	state: string;
	local_id: string | null;
	created_at: number;
};

/** One keyset page from `list_messages_page`; newest first. */
export type MessagePage = { messages: Message[]; has_more: boolean };

/** One bounded answer from `search_messages`. `truncated` means more matched. */
export type SearchHits = { messages: Message[]; truncated: boolean };

/** The retention rule in force, and the last time it actually ran. */
export type RetentionStatus = {
	policy: string;
	last_purge_at: number | null;
	last_deleted: number | null;
};

/** "days:90" → "90 days", "messages:1000" → "1,000 messages". */
export function retentionWords(policy: string): string {
	const [kind, raw] = policy.split(':');
	const value = Number(raw);
	if (kind === 'days' && Number.isFinite(value)) return `${value} days`;
	if (kind === 'messages' && Number.isFinite(value)) {
		return `${value.toLocaleString('en-US')} messages`;
	}
	return 'forever';
}

/** What the rule keeps, in one sentence fragment. */
export function retentionKept(policy: string): string {
	const [kind, raw] = policy.split(':');
	if (kind === 'days' && Number.isFinite(Number(raw))) return `${Number(raw)} days of messages.`;
	if (kind === 'messages' && Number.isFinite(Number(raw))) {
		return `The newest ${retentionWords(policy)}.`;
	}
	return 'Everything on this phone.';
}

/** `poll_device` also reports the best-effort flow sync it ran. */
export type PollResult = {
	commands?: unknown[];
	flows?: { ok: boolean; count?: number; error?: string | null };
};

/** A flow graph cached on this phone. A corrupt graph keeps its row and `node_count: null`. */
export type CachedFlow = {
	id: string;
	version: number;
	fetched_at: number;
	node_count: number | null;
};

/** One recorded flow run. The flow id and version together identify the graph. */
export type FlowRun = {
	local_id: string;
	flow_id: string;
	flow_version: number;
	outcome: string;
	created_at: number;
};

export type DevicePermissions = {
	sms?: boolean;
	send?: boolean;
	phone_numbers?: boolean;
};

/** Handset facts Android writes; a missing fact is `null`, never a guessed value. */
export type DeviceFacts = {
	self_number: string | null;
	sim_slot: number | null;
	sim_carrier: string | null;
	permissions: DevicePermissions | null;
	battery_optimized: boolean | null;
	default_sms_app: string | null;
};

export type InjectResult = {
	uploaded: boolean;
	accepted: number;
	duplicates: number;
	message_id: string;
	state: string;
	device_sent: boolean;
	fallback: boolean | null;
};

export type NoticeTone = 'ok' | 'error' | 'info';
export type Notice = { text: string; tone: NoticeTone };

/** Counts in copy are numerals and take a clean plural, never `(s)`. */
function count(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** The webview without Tauri is a plain browser preview, not a broken app. */
function hasTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * One store for the whole shell. Svelte 5 runes in a `.svelte.ts` module keep
 * every route looking at the same device, target, thread and notices; the dock
 * is navigation, not a set of separate apps.
 */
class AppStore {
	backendAvailable = $state(true);
	booted = false;
	loading = $state<Record<string, boolean>>({ boot: true });
	busy = $state<Record<string, boolean>>({});
	schemaVersion = $state<number | null>(null);

	target = $state<TargetView>({ base_url: null, has_admin_token: false });
	devices = $state<Device[]>([]);
	selectedId = $state('');
	messages = $state<Message[]>([]);
	messagesHasMore = $state(false);
	messagesLoaded = $state(false);
	offline = $state(false);

	facts = $state<DeviceFacts | null>(null);
	factsLoaded = $state(false);
	factsError = $state<string | null>(null);

	cachedFlows = $state<CachedFlow[]>([]);
	flowRuns = $state<FlowRun[]>([]);
	flowsLoaded = $state(false);
	flowsError = $state<string | null>(null);

	/** A local record of this session's successful signed contacts. */
	contactAt = $state<Record<string, number>>({});
	/** The last signed contact the shell recorded on disk, per device. */
	lastContactAt = $state<Record<string, number>>({});
	/** Pairing recorded by this session. */
	pairedAt = $state<Record<string, number>>({});
	/** Pairing recorded on disk by an earlier session, per device. */
	pairingAt = $state<Record<string, number>>({});

	notices = $state<Record<string, Notice>>({});

	/** The retention rule, as the store last reported it. */
	retention = $state<RetentionStatus | null>(null);

	selected = $derived(this.devices.find((d) => d.device_id === this.selectedId) ?? null);
	configured = $derived(Boolean(this.target.base_url));

	private async call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
		if (!this.backendAvailable) throw new Error('The local database is not reachable in this window.');
		try {
			return await invoke<T>(command, args);
		} catch (error) {
			if (String(error).includes('__TAURI_INTERNALS__')) this.backendAvailable = false;
			throw error;
		}
	}

	notify(scope: string, text: string, tone: NoticeTone = 'info') {
		this.notices[scope] = { text, tone };
	}

	clearNotice(scope: string) {
		delete this.notices[scope];
	}

	private fail(scope: string, error: unknown) {
		this.notify(scope, String(error), 'error');
	}

	async boot() {
		if (this.booted) return;
		this.booted = true;

		// A plain browser has no Tauri IPC. Say so once, quietly, instead of
		// filling every panel with the same red error.
		if (!hasTauri()) {
			this.backendAvailable = false;
			this.loading.boot = false;
			return;
		}

		this.loading.boot = true;
		await Promise.all([this.loadTarget(), this.loadSchema()]);
		await this.loadDevices();
		this.loading.boot = false;
		await Promise.all([this.refreshSelected(), this.loadFacts()]);
	}

	async loadSchema() {
		try {
			this.schemaVersion = await this.call<number>('schema_version');
		} catch {
			this.schemaVersion = null;
		}
	}

	async loadTarget() {
		this.loading.target = true;
		try {
			this.target = await this.call<TargetView>('get_target');
		} catch (error) {
			this.fail('target', error);
		} finally {
			this.loading.target = false;
		}
	}

	async saveTarget(baseUrl: string, adminToken: string) {
		this.busy.target = true;
		this.clearNotice('target');
		try {
			await this.call('save_target', {
				baseUrl: baseUrl.trim(),
				adminToken: adminToken.trim() || null
			});
			await this.loadTarget();
			this.notify('target', 'Target saved.', 'ok');
			return true;
		} catch (error) {
			this.fail('target', error);
			return false;
		} finally {
			this.busy.target = false;
		}
	}

	async loadDevices() {
		try {
			const devices = await this.call<Device[]>('list_devices');
			this.devices = devices;
			await this.loadContacts(devices);
			if (!devices.some((d) => d.device_id === this.selectedId)) {
				this.selectedId = devices[0]?.device_id ?? '';
				this.messages = [];
				this.messagesHasMore = false;
				this.messagesLoaded = false;
				this.offline = false;
			}
		} catch (error) {
			this.fail('boot', error);
		}
	}

	async reloadDevices(scope = 'devices') {
		this.busy.devices = true;
		try {
			const devices = await this.call<Device[]>('list_devices');
			this.devices = devices;
			await this.loadContacts(devices);
			if (!devices.some((d) => d.device_id === this.selectedId)) {
				this.selectedId = devices[0]?.device_id ?? '';
			}
			await this.refreshSelected();
			this.notify(scope, `Refreshed · ${count(devices.length, 'device', 'devices')}.`, 'ok');
		} catch (error) {
			this.fail(scope, error);
		} finally {
			this.busy.devices = false;
		}
	}

	/**
	 * Read the stored `last_contact:<device_id>` for every listed identity.
	 *
	 * The Device frame must not derive `live` from `devices.updated_at`: that
	 * column is stamped at creation, so a phone that has never reached the
	 * deployment would read live for two minutes. Only a completed signed request
	 * writes this setting, so a missing value is honestly `unknown`.
	 */
	private async loadContacts(devices: Device[]) {
		const entries = await Promise.all(
			devices.map(async (device) => {
				try {
					const at = await this.call<number | null>('get_last_contact', {
						deviceId: device.device_id
					});
					return [device.device_id, at] as const;
				} catch {
					return [device.device_id, null] as const;
				}
			})
		);
		const next: Record<string, number> = {};
		for (const [id, at] of entries) if (at) next[id] = at;
		this.lastContactAt = next;
	}

	selectDevice(deviceId: string) {
		if (deviceId === this.selectedId) return;
		this.selectedId = deviceId;
		this.messages = [];
		this.messagesHasMore = false;
		this.messagesLoaded = false;
		this.flowRuns = [];
		this.flowsLoaded = false;
		this.offline = false;
		void this.refreshSelected();
	}

	/** One keyset page of this device's thread, newest first. */
	async pageMessages(before: Message | null, limit = 50): Promise<MessagePage> {
		if (!this.selectedId) throw new Error('No device identity is selected.');
		return await this.call<MessagePage>('list_messages_page', {
			deviceId: this.selectedId,
			beforeCreatedAt: before ? before.created_at : null,
			beforeId: before ? before.id : null,
			limit
		});
	}

	/**
	 * Bounded search over this phone's log: the number or the text of a message.
	 * The store escapes LIKE wildcards and caps the answer at 100 rows.
	 */
	async searchMessages(query: string, limit = 100): Promise<SearchHits> {
		if (!this.selectedId) return { messages: [], truncated: false };
		return await this.call<SearchHits>('search_messages', {
			deviceId: this.selectedId,
			query,
			limit
		});
	}

	async loadRetention() {
		if (!this.backendAvailable) {
			this.retention = null;
			return;
		}
		try {
			this.retention = await this.call<RetentionStatus>('get_retention');
		} catch {
			this.retention = null;
		}
	}

	/**
	 * Store the chosen rule and apply it now. The store decides what may go:
	 * mirrored rows only, never a queued send, an unuploaded failure or a
	 * pending inbound row. The reply is the real count, which the frame says
	 * out loud instead of implying a clean sweep.
	 */
	async saveRetention(policy: string) {
		this.busy.retention = true;
		this.clearNotice('retention');
		try {
			const status = await this.call<RetentionStatus>('set_retention', { policy });
			this.retention = status;
			const removed = status.last_deleted ?? 0;
			this.notify(
				'retention',
				removed === 0
					? `Kept: ${retentionWords(policy)}. Nothing was removed.`
					: `Kept: ${retentionWords(policy)}. Removed ${count(removed, 'message', 'messages')}.`,
				'ok'
			);
			// The log changed: re-read Threads so no deleted row stays on screen.
			await this.refreshSelected();
			return true;
		} catch (error) {
			this.fail('retention', error);
			return false;
		} finally {
			this.busy.retention = false;
		}
	}

	/**
	 * Hand a reply to this phone's own radio. The command queues the row and
	 * returns its `local_id`; a failure is the backend's plain sentence, which
	 * the composer shows verbatim rather than swallowing.
	 */
	async sendSms(to: string, body: string): Promise<{ local_id: string }> {
		if (!this.selectedId) throw new Error('No device is selected on this phone');
		return await this.call<{ local_id: string }>('send_sms', {
			deviceId: this.selectedId,
			to,
			body
		});
	}

	/**
	 * Ask Android for the default-SMS role. The command only opens the system
	 * dialog; the row keeps saying "not default" until `get_device_facts` reads
	 * the new holder back on resume.
	 */
	async requestDefaultSmsRole() {
		this.busy.defaultSms = true;
		this.clearNotice('default-sms');
		try {
			await this.call('request_default_sms_role');
			this.notify(
				'default-sms',
				'Android is asking. The role is shown here only after Android reports it.',
				'info'
			);
		} catch (error) {
			this.fail('default-sms', error);
		} finally {
			this.busy.defaultSms = false;
		}
	}

	/**
	 * Follow the one sms:/smsto: link the Android shell handed over, if any.
	 * Called after boot and when the app regains focus, so a link that arrives
	 * while the app is already running still opens its thread.
	 */
	async followSmsIntent() {
		if (!this.backendAvailable) return;
		try {
			const route = await this.call<string | null>('take_sms_route');
			if (route) await goto(route);
		} catch {
			// The desktop shell and older builds have no intent mailbox.
		}
	}

	async refreshSelected() {
		if (!this.selectedId) {
			this.messages = [];
			this.messagesHasMore = false;
			this.messagesLoaded = true;
			this.offline = false;
			return;
		}
		this.loading.messages = true;
		try {
			this.offline = await this.call<boolean>('get_offline', { deviceId: this.selectedId });
			const paired = await this.call<number | null>('get_device_pairing', {
				deviceId: this.selectedId
			});
			if (paired) this.pairingAt[this.selectedId] = paired;
			else delete this.pairingAt[this.selectedId];
			// A background flush can answer while this frame is open; read the
			// stored contact rather than trusting only this session's memory. An
			// older shell without the command keeps the session-only reading.
			try {
				const lastContact = await this.call<number | null>('get_last_contact', {
					deviceId: this.selectedId
				});
				if (lastContact) this.lastContactAt[this.selectedId] = lastContact;
				else delete this.lastContactAt[this.selectedId];
			} catch {
				// Keep whatever this session already recorded.
			}
			const page = await this.pageMessages(null);
			this.messages = page.messages;
			this.messagesHasMore = page.has_more;
			this.messagesLoaded = true;
		} catch (error) {
			this.fail('data', error);
		} finally {
			this.loading.messages = false;
		}
	}

	/** Continue the newest-first thread list, one 50-row page at a time. */
	async loadOlderMessages() {
		if (this.loading.messages || !this.messagesHasMore || !this.selectedId) return;
		this.loading.messages = true;
		try {
			const last = this.messages[this.messages.length - 1] ?? null;
			const page = await this.pageMessages(last);
			this.messages = [...this.messages, ...page.messages];
			this.messagesHasMore = page.has_more;
		} catch (error) {
			this.fail('data', error);
		} finally {
			this.loading.messages = false;
		}
	}

	async loadFacts() {
		if (!this.backendAvailable) {
			this.facts = null;
			this.factsLoaded = true;
			return;
		}
		this.loading.facts = true;
		try {
			this.facts = await this.call<DeviceFacts>('get_device_facts');
			this.factsError = null;
		} catch (error) {
			this.facts = null;
			this.factsError = String(error);
		} finally {
			this.factsLoaded = true;
			this.loading.facts = false;
		}
	}

	async loadFlows(deviceId: string = this.selectedId) {
		if (!this.backendAvailable) {
			this.cachedFlows = [];
			this.flowRuns = [];
			this.flowsLoaded = true;
			return;
		}
		this.loading.flows = true;
		try {
			const [flows, runs] = await Promise.all([
				this.call<CachedFlow[]>('list_cached_flows'),
				deviceId
					? this.call<FlowRun[]>('list_flow_runs', {
							deviceId,
							limit: 100
						})
					: Promise.resolve([] as FlowRun[])
			]);
			this.cachedFlows = flows;
			this.flowRuns = runs;
			this.flowsError = null;
		} catch (error) {
			this.flowsError = String(error);
		} finally {
			this.flowsLoaded = true;
			this.loading.flows = false;
		}
	}

	async createDevice(input: {
		label: string;
		platformId: string;
		carrier: string;
		simSlot: number;
	}) {
		const label = input.label.trim();
		if (!label) {
			this.notify('identity', 'Give the device a label so you can tell them apart.', 'error');
			return false;
		}
		this.busy.create = true;
		this.clearNotice('identity');
		try {
			const device = await this.call<Device>('create_device', {
				label,
				platformId: input.platformId.trim() || null,
				carrier: input.carrier.trim() || null,
				simSlot: Number(input.simSlot) || 0
			});
			this.devices = [device, ...this.devices];
			this.selectedId = device.device_id;
			this.messages = [];
			this.messagesHasMore = false;
			this.messagesLoaded = false;
			await this.refreshSelected();
			this.notify('identity', `Created ${device.label}. Pair it with a code next.`, 'ok');
			return true;
		} catch (error) {
			this.fail('identity', error);
			return false;
		} finally {
			this.busy.create = false;
		}
	}

	async deleteDevice(deviceId: string) {
		this.busy.delete = true;
		try {
			await this.call<boolean>('delete_device', { deviceId });
			this.devices = this.devices.filter((d) => d.device_id !== deviceId);
			delete this.contactAt[deviceId];
			delete this.lastContactAt[deviceId];
			delete this.pairedAt[deviceId];
			if (this.selectedId === deviceId) {
				this.selectedId = this.devices[0]?.device_id ?? '';
				await this.refreshSelected();
			}
			this.notify('devices', 'Local identity deleted.', 'ok');
		} catch (error) {
			this.fail('identity', error);
		} finally {
			this.busy.delete = false;
		}
	}

	async pairWithCode(deviceId: string, code: string) {
		const input = code.trim();
		if (!deviceId || !input) return false;
		this.busy.pair = true;
		this.clearNotice('pair');
		try {
			const message = await this.call<string>('pair_with_code', { deviceId, code: input });
			const now = Date.now();
			this.pairedAt[deviceId] = now;
			this.contactAt[deviceId] = now;
			// A pairing link may have set the target; keep Settings in sync.
			await this.loadTarget();
			this.notify('pair', message, 'ok');
			return true;
		} catch (error) {
			this.fail('pair', error);
			return false;
		} finally {
			this.busy.pair = false;
		}
	}

	async selfPair(deviceId: string) {
		this.busy.selfPair = true;
		this.clearNotice(`settings:${deviceId}`);
		try {
			const message = await this.call<string>('pair_device', { deviceId });
			const now = Date.now();
			this.pairedAt[deviceId] = now;
			this.contactAt[deviceId] = now;
			this.notify(`settings:${deviceId}`, message, 'ok');
		} catch (error) {
			this.fail(`settings:${deviceId}`, error);
		} finally {
			this.busy.selfPair = false;
		}
	}

	async poll(deviceId: string) {
		this.busy.poll = true;
		this.clearNotice(`device:${deviceId}`);
		try {
			const result = await this.call<PollResult>('poll_device', { deviceId });
			// Older shells answered with the bare command array; accept both.
			const commands = Array.isArray(result) ? result : (result.commands ?? []);
			const flows = Array.isArray(result) ? null : (result.flows ?? null);
			this.contactAt[deviceId] = Date.now();
			// The poll also synced the flow cache. Re-read it first, then keep the
			// failure visible so the Flows frame does not pass off stale graphs.
			if (this.flowsLoaded) await this.loadFlows(deviceId);
			if (flows && !flows.ok) {
				this.flowsError = `Flow sync failed: ${flows.error ?? 'unknown error'}. Showing the last cache.`;
			} else if (flows?.ok) {
				this.flowsError = null;
			}
			// A poll also backfills the pairing time for identities created before
			// it was recorded, so re-read it rather than showing a stale "unknown".
			const paired = await this.call<number | null>('get_device_pairing', { deviceId });
			if (paired) this.pairingAt[deviceId] = paired;
			this.notify(
				`device:${deviceId}`,
				`Signed poll OK · ${count(
					commands.length,
					'command',
					'commands'
				)}${flows?.ok ? ` · ${count(flows.count ?? 0, 'flow', 'flows')} cached` : ''}.`,
				'ok'
			);
		} catch (error) {
			this.fail(`device:${deviceId}`, error);
		} finally {
			this.busy.poll = false;
		}
	}

	async revoke(deviceId: string) {
		this.busy.revoke = true;
		this.clearNotice(`device:${deviceId}`);
		try {
			await this.call('revoke_device', { deviceId });
			this.notify(`device:${deviceId}`, 'Revoked on the deployment.', 'ok');
		} catch (error) {
			this.fail(`device:${deviceId}`, error);
		} finally {
			this.busy.revoke = false;
		}
	}

	async purge(deviceId: string) {
		this.busy.purge = true;
		this.clearNotice(`settings:${deviceId}`);
		try {
			const deleted = await this.call<number>('purge_messages', { deviceId });
			this.notify(`settings:${deviceId}`, `Purged ${count(deleted, 'message', 'messages')} on the deployment.`, 'ok');
		} catch (error) {
			this.fail(`settings:${deviceId}`, error);
		} finally {
			this.busy.purge = false;
		}
	}

	async setOffline(value: boolean) {
		if (!this.selectedId) return;
		this.busy.offline = true;
		try {
			await this.call('set_offline', { deviceId: this.selectedId, offline: value });
			this.offline = value;
			this.notify(
				'flows',
				value
					? 'Carrier off: messages stay local and nothing is uploaded.'
					: 'Carrier on: injects upload over the signed endpoint.',
				'ok'
			);
		} catch (error) {
			this.fail('flows', error);
		} finally {
			this.busy.offline = false;
		}
	}

	async inject(sender: string, body: string) {
		if (!this.selectedId) return;
		this.busy.inject = true;
		this.clearNotice('flows');
		try {
			const result = await this.call<InjectResult>('carrier_inject', {
				deviceId: this.selectedId,
				sender: sender.trim(),
				body
			});
			this.notify(
				'flows',
				result.uploaded
					? `Injected · uploaded · accepted ${result.accepted}, duplicates ${result.duplicates}.`
					: 'Injected · recorded locally (carrier off).',
				'ok'
			);
			await this.refreshSelected();
			if (this.flowsLoaded) await this.loadFlows();
		} catch (error) {
			this.fail('flows', error);
		} finally {
			this.busy.inject = false;
		}
	}

	async drain(scope = 'flows') {
		if (!this.selectedId) return;
		this.busy.drain = true;
		this.clearNotice(scope);
		try {
			const captured = await this.call<Message[]>('carrier_drain', {
				deviceId: this.selectedId
			});
			this.contactAt[this.selectedId] = Date.now();
			this.notify(
				scope,
				captured.length === 0
					? 'Poll OK · no queued commands.'
					: `Poll OK · captured ${count(captured.length, 'outbound message', 'outbound messages')}.`,
				'ok'
			);
			await this.refreshSelected();
		} catch (error) {
			this.fail(scope, error);
		} finally {
			this.busy.drain = false;
		}
	}

	/**
	 * "Sync now" on Flows: refresh the cached flow set from the deployment, then
	 * check for queued replies.
	 *
	 * A failed fetch leaves the cached rows runnable and records `flowsError`,
	 * which the Flows frame shows next to the graphs it still holds. A silent
	 * failure here is what once left a paired phone deaf to automation.
	 */
	async syncFlows() {
		if (!this.selectedId) {
			this.notify('flows', 'Create a device identity first.', 'error');
			return;
		}
		if (this.offline) {
			this.notify('flows', 'Carrier is offline. Turn it back on to sync the Worker.', 'error');
			return;
		}
		this.busy.sync = true;
		this.clearNotice('flows');

		let flows: number;
		try {
			flows = await this.call<number>('sync_flows', { deviceId: this.selectedId });
			this.flowsError = null;
			await this.loadFlows(this.selectedId);
		} catch (error) {
			// Keep the last good cache: say the refresh failed rather than
			// presenting stale rows as current.
			await this.loadFlows(this.selectedId);
			this.flowsError = `Flow sync failed: ${String(error)}. Showing the last cache.`;
			this.fail('flows', error);
			this.busy.sync = false;
			return;
		}

		try {
			const captured = await this.call<Message[]>('carrier_drain', {
				deviceId: this.selectedId
			});
			this.contactAt[this.selectedId] = Date.now();
			this.notify(
				'flows',
				`Flows synced · ${count(flows, 'flow', 'flows')} cached · ${
					captured.length === 0
						? 'no queued commands'
						: `captured ${count(captured.length, 'outbound message', 'outbound messages')}`
				}.`,
				'ok'
			);
			await this.refreshSelected();
		} catch (error) {
			this.fail('flows', error);
		} finally {
			this.busy.sync = false;
		}
	}

	async clearThread() {
		if (!this.selectedId) return;
		this.busy.clear = true;
		this.clearNotice('flows');
		try {
			const deleted = await this.call<number>('clear_messages', {
				deviceId: this.selectedId
			});
			this.notify('flows', `Cleared ${count(deleted, 'local message', 'local messages')}.`, 'ok');
			await this.refreshSelected();
		} catch (error) {
			this.fail('flows', error);
		} finally {
			this.busy.clear = false;
		}
	}
}

export const app = new AppStore();
