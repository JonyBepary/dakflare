<script lang="ts">
	/**
	 * The composer: one field, one Ask, and the two ways to point a question at
	 * something without typing a path.
	 *
	 * `@` names what is already here — this page, the flow the editor has open, a
	 * file the operator attached. Choosing one inserts its name into the question;
	 * it never uploads, navigates or sends.
	 *
	 * `/` inserts a question about a surface of this console. It is not a command
	 * language and nothing runs: the menu's own note says so, and the inserted text
	 * is ordinary words the operator can edit before pressing Ask.
	 *
	 * The field keeps its own identity (`input.ask-input`, inside `form.ask`) because
	 * the panel's workbench and the panel's own focus hand it those names. What is
	 * new is only the menu and its keyboard path: Arrow keys move, Enter picks while
	 * the menu is open, Escape closes the menu and not the panel, and Tab leaves the
	 * field with the menu closed behind it.
	 */
	import { tick } from 'svelte';
	import {
		attachmentKindLabel,
		type AgentAttachment
	} from '$lib/agent-socket';
	import Icon from '../Icon.svelte';

	interface Item {
		id: string;
		/** What the row says. */
		label: string;
		/** The quiet second half: where it comes from. */
		hint: string;
		/** Exactly what replaces the token. */
		insert: string;
	}

	let {
		value = $bindable(''),
		attachments = [],
		disabled = false,
		canAsk = true,
		asking = false,
		contextLabel = '',
		flowId = null,
		onsubmit
	}: {
		value?: string;
		attachments?: AgentAttachment[];
		disabled?: boolean;
		canAsk?: boolean;
		asking?: boolean;
		contextLabel?: string;
		flowId?: string | null;
		onsubmit: (text: string) => void;
	} = $props();

	const uid = $props.id();
	const fieldId = `assistant-field-${uid}`;
	const menuId = `assistant-menu-${uid}`;
	const hintId = `assistant-hint-${uid}`;

	let field = $state<HTMLInputElement | null>(null);
	/** The caret the token is read from. Kept in state so the menu follows typing. */
	let caret = $state(0);
	/** The operator dismissed the menu with Escape or a pick; typing reopens it. */
	let dismissed = $state(false);
	let active = $state(0);

	/**
	 * The surfaces this console has, as questions rather than commands.
	 *
	 * Each is a starter the operator can edit. The hint is the page it belongs to,
	 * which is the only claim made: choosing one does not go there and does not read
	 * anything.
	 */
	const commands: ReadonlyArray<Item> = [
		{
			id: 'rules',
			label: 'rules',
			hint: 'Automation · rules',
			insert: 'Which rules are paused, and which message would they have answered?'
		},
		{
			id: 'messages',
			label: 'messages',
			hint: 'Messages',
			insert: 'Which messages are stuck, and why?'
		},
		{
			id: 'devices',
			label: 'devices',
			hint: 'Devices',
			insert: 'Which handsets have not synced recently?'
		},
		{
			id: 'flows',
			label: 'flows',
			hint: 'Automation · flows',
			insert: 'Which flows stopped before sending a reply?'
		},
		{
			id: 'approvals',
			label: 'approvals',
			hint: 'Approvals',
			insert: 'What is waiting for an approval, and what would it allow?'
		},
		{
			id: 'audit',
			label: 'audit',
			hint: 'Audit',
			insert: 'What changed on this gateway today?'
		}
	];

	/** What `@` can name. Only things the panel actually holds. */
	const sources = $derived.by((): Item[] => {
		const items: Item[] = [
			{
				id: 'page',
				label: 'this page',
				hint: contextLabel === '' ? 'where you are' : contextLabel,
				insert: '@this page'
			}
		];
		if (flowId !== null && flowId !== '') {
			items.push({
				id: 'flow',
				label: `flow ${flowId}`,
				hint: 'the flow on screen',
				insert: `@flow ${flowId}`
			});
		}
		for (const file of attachments) {
			items.push({
				id: `file:${file.id}`,
				label: file.name,
				hint: `file · ${attachmentKindLabel(file.kind)}`,
				insert: `@${file.name}`
			});
		}
		return items;
	});

	/**
	 * The token under the caret, when it is the first thing in a word.
	 *
	 * Reading the caret rather than the end of the string is what makes an edit in
	 * the middle of a question behave; the input's own `select` and arrow-key events
	 * keep `caret` true.
	 */
	const token = $derived.by(() => {
		if (disabled || dismissed) return null;
		const at = Math.min(caret, value.length);
		const match = /(^|\s)([@/])([^\s@/]*)$/.exec(value.slice(0, at));
		if (match === null) return null;
		return { char: match[2], query: match[3], start: at - match[3].length - 1 };
	});

	const menu = $derived.by(() => {
		if (token === null) return null;
		const all = token.char === '@' ? sources : commands;
		const query = token.query.toLowerCase();
		const items =
			query === ''
				? all
				: all.filter(
						(item) =>
							item.label.toLowerCase().includes(query) || item.id.toLowerCase().includes(query)
					);
		if (items.length === 0) return null;
		return { kind: token.char, items, start: token.start };
	});

	const index = $derived.by(() => {
		if (menu === null) return 0;
		return Math.min(active, menu.items.length - 1);
	});

	const optionId = $derived(menu === null ? undefined : `${menuId}-${index}`);

	function readCaret(): void {
		const el = field;
		if (el !== null && el.selectionStart !== null) caret = el.selectionStart;
	}

	function oninput(): void {
		readCaret();
		dismissed = false;
		active = 0;
	}

	function onkeydown(event: KeyboardEvent): void {
		if (menu !== null) {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				active = (index + 1) % menu.items.length;
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				active = (index - 1 + menu.items.length) % menu.items.length;
				return;
			}
			if (event.key === 'Enter') {
				// Enter picks while the menu is open; with it closed it submits.
				event.preventDefault();
				void choose(menu.items[index]);
				return;
			}
			if (event.key === 'Escape') {
				// The panel closes on Escape from the window. Dismissing the menu is
				// the smaller step, so it stops here.
				event.preventDefault();
				event.stopPropagation();
				dismissed = true;
				return;
			}
			if (event.key === 'Tab') {
				dismissed = true;
			}
		}
	}

	/** Replace the token with the item's own words and put the caret after them. */
	async function choose(item: Item): Promise<void> {
		if (menu === null) return;
		const start = menu.start;
		const at = Math.min(caret, value.length);
		const next = `${value.slice(0, start)}${item.insert} ${value.slice(at)}`;
		const place = start + item.insert.length + 1;
		value = next;
		dismissed = true;
		caret = place;
		await tick();
		field?.focus();
		field?.setSelectionRange(place, place);
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		dismissed = true;
		if (disabled || !canAsk) return;
		onsubmit(value);
	}
</script>

<form class="ask" onsubmit={submit}>
	<label class="sr-only" for={fieldId}>Your question</label>

	{#if menu !== null}
		<div class="ask-menu">
			<p class="ask-menu-head mono">
				{menu.kind === '@' ? 'Mention' : 'Ask about'}
			</p>
			<ul
				class="ask-menu-list"
				id={menuId}
				role="listbox"
				aria-label={menu.kind === '@'
					? 'Something already on this page'
					: 'A page of this console'}
			>
				{#each menu.items as item, i (item.id)}
					<li>
						<button
							type="button"
							id={`${menuId}-${i}`}
							class="ask-option"
							role="option"
							tabindex="-1"
							aria-selected={i === index}
							data-active={i === index}
							onmousedown={(event) => event.preventDefault()}
							onclick={() => void choose(item)}
						>
							<span class="ask-option-label">
								{#if menu.kind === '/'}<span class="ask-option-slash" aria-hidden="true">/</span>{/if}
								{item.label}
							</span>
							<span class="ask-option-hint">{item.hint}</span>
						</button>
					</li>
				{/each}
			</ul>
			<p class="ask-menu-note">
				{menu.kind === '@'
					? 'Names something already here. Nothing is sent.'
					: 'Adds a question. Nothing runs until you press Ask.'}
			</p>
		</div>
	{/if}

	<div class="ask-field">
		<input
			id={fieldId}
			class="input ask-input"
			type="text"
			bind:this={field}
			bind:value
			oninput={oninput}
			onkeydown={onkeydown}
			onkeyup={readCaret}
			onselect={readCaret}
			placeholder="What does this page tell me?"
			autocomplete="off"
			spellcheck="false"
			maxlength="500"
			enterkeyhint="send"
			disabled={disabled}
			role="combobox"
			aria-haspopup="listbox"
			aria-autocomplete="list"
			aria-expanded={menu !== null}
			aria-controls={menu !== null ? menuId : undefined}
			aria-activedescendant={optionId}
			aria-describedby={hintId}
		/>
	</div>

	<button type="submit" class="btn btn-primary ask-send" disabled={!canAsk}>
		{asking ? 'Asking' : 'Ask'}
	</button>

	<p class="sr-only" id={hintId}>
		Type at-sign to name this page, the open flow or an attached file. Type slash to start from
		a question about a page of this console.
	</p>
</form>

<style>
	.ask {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 6px;
		align-items: stretch;
		padding: 10px 12px 12px;
	}

	/* The menu is a row of the composer, not a popover over it: in a 420px sheet a
	   floating list is taller than the body it would cover, and the panel's own
	   `overflow: hidden` would clip its first option. In flow it pushes the
	   transcript up instead of hiding it, and nothing is ever cut. */
	.ask-menu {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 6px;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
	}

	.ask-field {
		min-width: 0;
		display: flex;
	}

	.ask-input {
		flex: 1;
		min-width: 0;
		min-height: 36px;
		font-size: var(--df-p-text-sm);
		/* The global 16 px guard lives on `.input` and this scoped rule outranks it,
		   so the guard is restated here. */
		@media (max-width: 720px), (pointer: coarse) {
			font-size: 16px;
		}
		/* The assistant's own geometry: 4px, the smaller step of the console's
		   radius scale, so the panel reads as a tool rather than a card. */
		border-radius: var(--df-p-radius-xs);
	}

	.ask-send {
		flex: none;
		height: 36px;
		border-radius: var(--df-p-radius-xs);
	}

	/* ---- the menu ----
	   One plate, no shadow: the console's overlays are hairlines on the card. */
	.ask-menu-head {
		margin: 0;
		padding: 0 6px;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.ask-menu-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		max-height: 196px;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
	}

	.ask-option {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		width: 100%;
		min-height: 30px;
		padding: 5px 6px;
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		text-align: left;
		transition:
			background-color 120ms ease,
			transform var(--df-p-dur-press) ease-out;
	}

	.ask-option:active {
		transform: scale(0.97);
	}

	@media (hover: hover) and (pointer: fine) {
		.ask-option:hover {
			background: var(--df-surface-well);
		}
	}

	.ask-option[data-active='true'] {
		background: var(--df-surface-well);
		border-color: var(--df-border-hairline);
	}

	.ask-option-label {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.ask-option-slash {
		margin-right: 1px;
		color: var(--df-text-meta);
		font-family: var(--df-font-mono);
	}

	.ask-option-hint {
		flex: none;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		white-space: nowrap;
	}

	.ask-menu-note {
		margin: 0;
		padding: 4px 6px 0;
		border-top: 1px solid var(--df-border-hairline);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
	}

	@media (prefers-reduced-motion: reduce) {
		.ask-option {
			transition: none;
		}

		.ask-option:active {
			transform: none;
		}
	}

	/* Touch: the panel's controls take the 44 px floor, and the menu's rows follow
	   so a tap lands on one row rather than between two. */
	@media (max-width: 720px), (pointer: coarse) {
		.ask-send {
			min-height: 44px;
			height: auto;
		}

		.ask-input {
			min-height: 44px;
		}

		.ask-option {
			min-height: 44px;
		}
	}
</style>
