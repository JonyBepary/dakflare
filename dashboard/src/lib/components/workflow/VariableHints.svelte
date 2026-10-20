<script lang="ts">
	let {
		variables,
		label = 'Available variables'
	}: { variables: string[]; label?: string } = $props();

	function token(name: string): string {
		return `{{${name}}}`;
	}
</script>

<div class="vars">
	<span class="vars-label">{label}</span>
	<ul class="vars-list">
		{#each variables as name (name)}
			<li><code>{token(name)}</code></li>
		{/each}
	</ul>
</div>

<style>
	.vars {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.vars-label {
		font-size: 10.5px;
		color: var(--ink-3);
		line-height: 1.4;
	}

	.vars-list {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	code {
		display: inline-block;
		padding: 1px 4px;
		border: 1px solid var(--line);
		border-radius: 3px;
		background: var(--surface-2);
		color: var(--ink-2);
		font-family: var(--font-mono);
		font-size: 9.5px;
		line-height: 1.5;
		white-space: nowrap;
	}
</style>
