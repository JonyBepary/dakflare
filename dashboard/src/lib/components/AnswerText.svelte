<script lang="ts">
	/**
	 * The model's words, in the small Markdown subset this console renders.
	 *
	 * The agent answers in Markdown, so a panel that prints the source shows
	 * `**Mi A3 Grameenphone**` and an id in literal backticks. This renders the
	 * subset that carries meaning here, and nothing else:
	 *
	 *  - `**bold**` and `__bold__` → `<strong>`, at the console's own 600 step;
	 *  - `` `code` `` → `<code class="mono">`, which is how an id should read;
	 *  - a single line break is a break, a blank line a paragraph gap;
	 *  - `- item` and `1. item` are lists;
	 *  - a fenced block is one mono block, wrapped the way the panel wraps a
	 *    long command already;
	 *  - everything else is literal text: a lone `*` stays a `*`, a heading stays
	 *    its own `#`s, a bare URL stays text.
	 *
	 * It is not a Markdown library and deliberately not one: no dependency, no
	 * `{@html}`, and every span is a text node this template writes, so model
	 * output cannot become markup or run. Italics are left out on purpose: the
	 * console has no italic step anywhere (no `<em>`, no `font-style: italic`), so
	 * emphasis would be a synthesised oblique the rest of the product never uses —
	 * and single-asterisk emphasis cannot be told apart from the ids and file
	 * names this console prints (`dev_abc`, `carrier_export.csv`) without false
	 * positives. A `*` in prose therefore stays a `*`, and `*italic*` is the one
	 * shape this renders literally until it earns a face of its own.
	 *
	 * The step is the panel's answer size (12px) and is set here rather than
	 * inherited: the caller's `.answer` / `.message-text` rule is scoped to the
	 * panel, and a component's own element carries this component's scope, so an
	 * inherited 15px body size would leak in. `<code>` lands at 0.94em of that,
	 * 11.3px, above the panel's 11px floor. `<strong>` and `<code>` carry their own
	 * meaning, so there is no ARIA here.
	 */
	import type { Snippet } from 'svelte';

	/** A paragraph keeps its lines apart, so one newline is one `<br>`. */
	type Span = { kind: 'text' | 'strong' | 'code'; text: string };
	type Block =
		| { kind: 'p'; lines: Span[][] }
		| { kind: 'ul' | 'ol'; items: Span[][]; start: number }
		| { kind: 'pre'; text: string };

	let {
		text,
		class: className = '',
		/** Rendered inline after the last paragraph: the streaming caret. */
		trailing
	}: { text: string; class?: string; trailing?: Snippet } = $props();

	/** A character an id or a word is made of: a delimiter may not butt against one. */
	const WORD = /[\p{L}\p{N}_]/u;

	const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
	const BULLET = /^\s{0,3}[-*+][ \t]+(.*)$/;
	const NUMBERED = /^\s{0,3}(\d{1,9})[.)][ \t]+(.*)$/;

	function isWord(char: string | undefined): boolean {
		return char !== undefined && WORD.test(char);
	}

	function isBlank(char: string | undefined): boolean {
		return char === undefined || /\s/.test(char);
	}

	/**
	 * Where an emphasis run closes, or -1 when it does not.
	 *
	 * The content must be non-empty and hug its delimiters, the delimiter must not
	 * touch a word on its outside, and content may not hold a backtick (that is
	 * code, and code is literal). An opener that never closes stays literal, which
	 * is what a half-arrived `**` looks like mid-stream: a delimiter, not a lie.
	 */
	function closeOf(line: string, from: number, delimiter: string): number {
		let at = line.indexOf(delimiter, from);
		while (at !== -1) {
			const content = line.slice(from, at);
			const fits =
				content !== '' &&
				!isBlank(content[0]) &&
				!isBlank(content[content.length - 1]) &&
				!isWord(line[at + delimiter.length]) &&
				!content.includes('`');
			if (fits) return at;
			at = line.indexOf(delimiter, at + delimiter.length);
		}
		return -1;
	}

	/** One line of prose: literal text, with code spans and bold recognised. */
	function parseLine(line: string): Span[] {
		const spans: Span[] = [];
		let plain = '';
		let at = 0;

		const flush = (): void => {
			if (plain !== '') spans.push({ kind: 'text', text: plain });
			plain = '';
		};

		while (at < line.length) {
			const char = line[at];

			if (char === '`') {
				const end = line.indexOf('`', at + 1);
				if (end > at + 1) {
					flush();
					spans.push({ kind: 'code', text: line.slice(at + 1, end) });
					at = end + 1;
					continue;
				}
				plain += char;
				at += 1;
				continue;
			}

			if (char === '*' || char === '_') {
				const delimiter = line[at + 1] === char ? char + char : '';
				if (delimiter !== '' && !isWord(line[at - 1]) && !isBlank(line[at + 2])) {
					const end = closeOf(line, at + 2, delimiter);
					if (end !== -1) {
						flush();
						spans.push({ kind: 'strong', text: line.slice(at + 2, end) });
						at = end + 2;
						continue;
					}
				}
			}

			plain += char;
			at += 1;
		}

		flush();
		return spans;
	}

	/** The closing fence is the same mark, at least as long, alone on its line. */
	function closesFence(line: string, mark: string): boolean {
		const trimmed = line.trim();
		if (trimmed.length < mark.length) return false;
		for (const char of trimmed) if (char !== mark[0]) return false;
		return true;
	}

	/** Paragraphs, lists and fenced blocks, in the order the model wrote them. */
	function parseBlocks(source: string): Block[] {
		const lines = source.replace(/\r\n?/g, '\n').split('\n');
		const blocks: Block[] = [];
		let at = 0;

		while (at < lines.length) {
			const line = lines[at];
			const fence = FENCE.exec(line);

			if (fence !== null) {
				const mark = fence[1];
				const body: string[] = [];
				at += 1;
				while (at < lines.length && !closesFence(lines[at], mark)) {
					body.push(lines[at]);
					at += 1;
				}
				// An unclosed fence runs to the end of the answer, never past it.
				if (at < lines.length) at += 1;
				blocks.push({ kind: 'pre', text: body.join('\n') });
				continue;
			}

			if (line.trim() === '') {
				at += 1;
				continue;
			}

			const numbered = NUMBERED.exec(line);
			const bullet = numbered === null ? BULLET.exec(line) : null;

			if (numbered !== null || bullet !== null) {
				const ordered = numbered !== null;
				const items: Span[][] = [];
				const start = ordered ? Number(numbered[1]) : 1;
				while (at < lines.length) {
					const item = ordered ? NUMBERED.exec(lines[at]) : BULLET.exec(lines[at]);
					if (item === null) break;
					// `NUMBERED` keeps its words in group 2, `BULLET` in group 1.
					items.push(parseLine((ordered ? item[2] : item[1]).trim()));
					at += 1;
				}
				blocks.push({ kind: ordered ? 'ol' : 'ul', items, start });
				continue;
			}

			const paragraph: Span[][] = [];
			while (at < lines.length) {
				const next = lines[at];
				if (next.trim() === '') break;
				if (FENCE.test(next) || BULLET.test(next) || NUMBERED.test(next)) break;
				paragraph.push(parseLine(next));
				at += 1;
			}
			blocks.push({ kind: 'p', lines: paragraph });
		}

		return blocks;
	}

	const blocks = $derived(parseBlocks(text));

	/**
	 * The streaming caret when the answer does not end in prose.
	 *
	 * `trailing` is drawn inside the last paragraph, right after its last word.
	 * When the last block is a list or a fenced command, it gets a line of its
	 * own instead: a caret that vanishes while text is still arriving would look
	 * like the answer had finished.
	 */
	const tailStandalone = $derived(
		trailing !== undefined && blocks.length > 0 && blocks[blocks.length - 1].kind !== 'p'
	);
</script>

{#snippet inline(spans: Span[])}{#each spans as span}{#if span.kind === 'strong'}<strong>{span.text}</strong>{:else if span.kind === 'code'}<code class="mono">{span.text}</code>{:else}{span.text}{/if}{/each}{/snippet}

<div class="md {className}">
	{#each blocks as block, index (index)}
		{#if block.kind === 'p'}
			<p>{#each block.lines as spans, line}{@render inline(spans)}{#if line < block.lines.length - 1}<br />{/if}{/each}{#if index === blocks.length - 1}{@render trailing?.()}{/if}</p>
		{:else if block.kind === 'pre'}
			<pre><code class="mono">{block.text}</code></pre>
		{:else if block.kind === 'ul'}
			<ul>{#each block.items as item, itemIndex (itemIndex)}<li>{@render inline(item)}</li>{/each}</ul>
		{:else}
			<ol start={block.start}>{#each block.items as item, itemIndex (itemIndex)}<li>{@render inline(item)}</li>{/each}</ol>
		{/if}
	{/each}
	{#if tailStandalone}<p>{@render trailing?.()}</p>{/if}
</div>

<style>
	/* The caller's landmark class (`.answer`, `.message-text`) stays on this
	   element for the panel's own selectors and the workbench, but the type is set
	   here: a component's element carries this component's scope, so the caller's
	   scoped rules could not reach it. 12px is the panel's answer step; a code
	   span lands at 0.94em of it, 11.3px, above the panel's 11px floor. */
	.md {
		margin: 0;
		color: var(--df-text-primary);
		/* The panel's answer step, unless the surface reading it has room for a
		   bigger one: the assistant's full-screen view raises `--df-md-font-size`
		   to the console's 15px reading step. Nothing else sets it, so every other
		   caller keeps 12px. */
		font-size: var(--df-md-font-size, var(--df-p-text-sm));
		line-height: 1.55;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.md p,
	.md ul,
	.md ol,
	.md pre {
		margin: 0;
	}

	/* A blank line in the source is a paragraph gap, not a blank line of type:
	   0.7em of the answer step is a break you can see without it reading as a
	   separate section of the panel. Written on `:not(:first-child)` so it
	   outweighs the `margin: 0` the blocks carry above. */
	.md > *:not(:first-child) {
		margin-top: 0.7em;
	}

	/* The console's semibold step. A UA `<strong>` lands on bolder-than-bold in
	   some families; 600 is the weight the panel's own headings use. */
	.md strong {
		font-weight: 600;
	}

	.md code {
		overflow-wrap: anywhere;
	}

	.md ul,
	.md ol {
		padding-left: 1.15em;
	}

	.md li + li {
		margin-top: 0.15em;
	}

	/* The words are the answer; the marker is punctuation. */
	.md li::marker {
		color: var(--df-text-meta);
	}

	/* A fenced block is one mono block that wraps, like the long command the
	   panel already prints under a failure: evidence to read, not a thing to
	   chase sideways. Same well and hairline as every other box in the panel. */
	.md pre {
		padding: 6px 8px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		tab-size: 2;
	}
</style>
