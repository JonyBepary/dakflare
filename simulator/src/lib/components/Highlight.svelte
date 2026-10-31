<script lang="ts">
	/**
	 * The words in `text` that the search term matched, with the rest of the
	 * string kept as it was. Case-insensitive and literal: the term is a search
	 * string, never a pattern.
	 */
	let { text, term }: { text: string; term: string } = $props();

	type Part = { text: string; match: boolean };

	const parts = $derived.by<Part[]>(() => {
		const needle = term.trim().toLowerCase();
		if (!needle) return [{ text, match: false }];
		const hay = text.toLowerCase();
		const out: Part[] = [];
		let cursor = 0;
		while (cursor < text.length) {
			const at = hay.indexOf(needle, cursor);
			if (at < 0) break;
			if (at > cursor) out.push({ text: text.slice(cursor, at), match: false });
			out.push({ text: text.slice(at, at + needle.length), match: true });
			cursor = at + needle.length;
		}
		if (cursor < text.length) out.push({ text: text.slice(cursor), match: false });
		return out.length > 0 ? out : [{ text, match: false }];
	});
</script>

{#each parts as part, index (index)}{#if part.match}<mark class="hit-mark">{part.text}</mark
		>{:else}{part.text}{/if}{/each}

<style>
	.hit-mark {
		padding: 0 1px;
		border-radius: 3px;
		background: var(--df-accent-soft);
		color: var(--accent);
		font-weight: 700;
	}
</style>
