<script lang="ts">
	import { app } from '$lib/stores/app.svelte';

	let {
		id = 'device-select',
		label = 'Device',
		compact = false
	}: { id?: string; label?: string; compact?: boolean } = $props();
</script>

<label class="picker" class:compact for={id}>
	<span class="picker-label">{label}</span>
	<select
		{id}
		value={app.selectedId}
		onchange={(event) => app.selectDevice(event.currentTarget.value)}
		disabled={app.devices.length === 0}
	>
		{#if app.devices.length === 0}
			<option value="">No device identity</option>
		{/if}
		{#each app.devices as device (device.device_id)}
			<option value={device.device_id}>
				{device.label} · {device.device_id.slice(0, 8)}…
			</option>
		{/each}
	</select>
</label>
