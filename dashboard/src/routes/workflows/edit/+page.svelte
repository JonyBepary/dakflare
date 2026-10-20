<script lang="ts">
	import { page } from '$app/state';
	import WorkflowEditor from '$lib/components/workflow/WorkflowEditor.svelte';

	// A static route with the workflow key in the query string. Saved ids live in D1,
	// so they cannot be build-time entry points; `/workflows/edit` prerenders once and
	// reads `?id=` at runtime. No `?id=` means a fresh draft.
	const id = $derived(page.url.searchParams.get('id') ?? '');
</script>

<WorkflowEditor {id} />
