<script lang="ts">
	import type { Snippet } from 'svelte';
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	let {
		open = false,
		title,
		confirmLabel = 'Confirm',
		tone = 'danger',
		pending = false,
		error = null,
		onconfirm,
		oncancel,
		children
	}: {
		open?: boolean;
		title: string;
		confirmLabel?: string;
		tone?: 'danger' | 'primary';
		pending?: boolean;
		error?: string | null;
		onconfirm: () => void;
		oncancel: () => void;
		children?: Snippet;
	} = $props();

	const uid = $props.id();
	const titleId = `confirm-title-${uid}`;
	let dialog = $state<HTMLDialogElement | null>(null);
	let cancelButton = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		const el = dialog;
		if (!el) return;
		if (open && !el.open) {
			el.showModal();
			void tick().then(() => cancelButton?.focus());
		} else if (!open && el.open) {
			el.close();
		}
	});

	function requestClose(event: Event) {
		event.preventDefault();
		if (!pending) oncancel();
	}

	function onBackdropClick(event: MouseEvent) {
		if (event.target === dialog && !pending) oncancel();
	}
</script>

<dialog
	bind:this={dialog}
	class="dialog"
	aria-labelledby={titleId}
	oncancel={requestClose}
	onclick={onBackdropClick}
>
	<div class="dialog-head">
		<h2 id={titleId}>{title}</h2>
		<button
			type="button"
			class="btn btn-ghost btn-icon btn-sm"
			onclick={() => !pending && oncancel()}
			disabled={pending}
			aria-label="Close"
		>
			<Icon name="x" size={14} />
		</button>
	</div>
	<div class="dialog-body">
		{#if children}{@render children()}{/if}
		{#if error}
			<div class="notice notice-danger" role="alert" style="margin-top: 12px">
				<Icon name="alert" size={15} />
				<div>{error}</div>
			</div>
		{/if}
	</div>
	<div class="dialog-foot">
		<button
			type="button"
			class="btn"
			bind:this={cancelButton}
			onclick={oncancel}
			disabled={pending}
		>
			Cancel
		</button>
		<button
			type="button"
			class="btn {tone === 'danger' ? 'btn-danger-solid' : 'btn-primary'}"
			onclick={onconfirm}
			disabled={pending}
			aria-busy={pending}
		>
			{#if pending}<Spinner />{/if}
			{confirmLabel}
		</button>
	</div>
</dialog>
