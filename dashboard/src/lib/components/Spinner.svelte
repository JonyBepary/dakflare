<script lang="ts">
	let { size = 'sm', label }: { size?: 'sm' | 'lg'; label?: string } = $props();
</script>

{#if label}
	<span class="row" role="status" style="gap: 7px">
		<span class="spinner {size === 'lg' ? 'spinner-lg' : ''}"></span>
		<span>{label}</span>
	</span>
{:else}
	<span class="spinner {size === 'lg' ? 'spinner-lg' : ''}" aria-hidden="true"></span>
{/if}
