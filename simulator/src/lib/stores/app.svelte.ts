import { invoke } from '@tauri-apps/api/core';

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
	/** Pairing recorded by this session. */
	pairedAt = $state<Record<string, number>>({});
	/** Pairing recorded on disk by an earlier session, per device. */
	pairingAt = $state<Record<string, number>>({});

	notices = $state<Record<string, Notice>>({});

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
			const commands = await this.call<unknown[]>('poll_device', { deviceId });
			this.contactAt[deviceId] = Date.now();
			// A poll also backfills the pairing time for identities created before
			// it was recorded, so re-read it rather than showing a stale "unknown".
			const paired = await this.call<number | null>('get_device_pairing', { deviceId });
			if (paired) this.pairingAt[deviceId] = paired;
			this.notify(
				`device:${deviceId}`,
				`Signed poll OK · ${count(
					Array.isArray(commands) ? commands.length : 0,
					'command',
					'commands'
				)}.`,
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
	 * "Sync now" on Flows. The command surface has no `fetch_flows` and no
	 * `list_flows`, so the only reachable Worker call is the carrier panel's
	 * outbox poll. It is labelled as such; the flow cache itself is refreshed
	 * by the inbound inject path in `carrier_inject`.
	 */
	async syncFlows() {
		if (!this.selectedId) {
			this.notify('flows', 'Create a device identity first.', 'error');
			return;
		}
		if (this.offline) {
			this.notify('flows', 'Carrier is offline. Turn it back on to poll the Worker.', 'error');
			return;
		}
		this.busy.sync = true;
		await this.drain('flows');
		this.busy.sync = false;
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
