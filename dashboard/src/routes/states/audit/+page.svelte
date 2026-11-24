<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import AuditPage from '../../audit/+page.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import { driveAuditState } from './drive';
	import { AUDIT_GROUPS, type AuditStateKey } from './fixtures';

	let { data }: { data: { state: AuditStateKey } } = $props();
	let stageEl = $state<HTMLElement | null>(null);

	function selectState(next: string): void {
		const target = `${resolve('/states/audit')}?__state=${encodeURIComponent(next)}`;
		void goto(target, { replace: true, reset: false });
	}

	$effect(() => {
		const currentState = data.state;
		const el = stageEl;
		if (!el) return;
		const controller = new AbortController();
		void driveAuditState(el, currentState, controller.signal);
		return () => controller.abort();
	});
</script>

<StateSwitcher groups={AUDIT_GROUPS} current={data.state} onchange={selectState}>
	<div bind:this={stageEl} data-audit-stage>
		{#key data.state}
			<AuditPage />
		{/key}
	</div>
</StateSwitcher>
