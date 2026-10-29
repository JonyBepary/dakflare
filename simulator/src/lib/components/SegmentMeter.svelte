<script lang="ts">
	import { measureSms } from '$lib/sms-text';

	/**
	 * The carrier's arithmetic, shown the same way in both places that write an
	 * SMS: the reply bar and the new-message screen. GSM-7 costs one septet per
	 * character (two for the escaped ones); anything outside that alphabet
	 * forces UCS-2 at 70/67.
	 */
	let { body }: { body: string } = $props();

	const measure = $derived(measureSms(body));
	const segments = $derived(
		`${measure.segments} ${measure.segments === 1 ? 'segment' : 'segments'}`
	);
</script>

<p class="composer-count">
	<span
		class="composer-encoding"
		data-encoding={measure.encoding}
		title={measure.encoding === 'ucs2'
			? 'UCS-2: a character outside the GSM alphabet, at 70 per segment'
			: 'GSM-7: 160 characters fit in one segment'}
	>
		{measure.encoding === 'ucs2' ? 'UCS-2' : 'GSM-7'}
	</span>
	<span class="mono">{measure.units}/{measure.capacity}</span>
	<span class="composer-parts mono" data-multi={measure.segments > 1 ? 'true' : 'false'}>
		{segments}
	</span>
</p>
