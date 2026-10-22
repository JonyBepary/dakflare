<script lang="ts">
	import qrcode from 'qrcode-generator';
	import Icon from './Icon.svelte';

	let {
		value,
		size = 184,
		label = 'Pairing QR code',
		caption = 'Scan with the phone camera'
	}: {
		value: string;
		size?: number;
		label?: string;
		caption?: string;
	} = $props();

	/**
	 * Rendering the matrix ourselves (rather than `createSvgTag`) keeps the SVG
	 * free of inline styles and lets a single path use crisp, unscaled module
	 * edges. `qrcode-generator` is synchronous and dependency-free.
	 */
	type QrModel = { path: string; count: number; error: string | null };

	const qr = $derived.by((): QrModel => {
		if (!value) return { path: '', count: 0, error: 'Nothing to encode.' };
		try {
			const code = qrcode(0, 'M');
			code.addData(value);
			code.make();

			const count = code.getModuleCount();
			const runs: string[] = [];
			for (let row = 0; row < count; row++) {
				let col = 0;
				while (col < count) {
					if (!code.isDark(row, col)) {
						col++;
						continue;
					}
					const start = col;
					while (col < count && code.isDark(row, col)) col++;
					runs.push(`M${start} ${row}h${col - start}v1H${start}z`);
				}
			}
			return { path: runs.join(''), count, error: null };
		} catch (failure) {
			return {
				path: '',
				count: 0,
				error: failure instanceof Error ? failure.message : 'The QR code could not be drawn.'
			};
		}
	});

	// Four modules of quiet zone on every side, per the QR specification.
	const quiet = 4;
	const viewBox = $derived(`0 0 ${qr.count + quiet * 2} ${qr.count + quiet * 2}`);
</script>

{#if qr.error}
	<div class="qr-fallback" role="alert">
		<span class="qr-fallback-icon"><Icon name="alert" size={15} /></span>
		<div>
			<strong>QR code unavailable</strong>
			<p>{qr.error} Use the deep link instead — it pairs the same way.</p>
		</div>
	</div>
{:else}
	<figure class="qr-figure" style={`--qr-size: ${size}px`}>
		<div class="qr-card">
			<svg
				viewBox={viewBox}
				width={size}
				height={size}
				role="img"
				aria-label={label}
				shape-rendering="crispEdges"
			>
				<rect width={qr.count + quiet * 2} height={qr.count + quiet * 2} fill="#ffffff" />
				<g transform={`translate(${quiet} ${quiet})`}>
					<path d={qr.path} fill="#000000" />
				</g>
			</svg>
		</div>
		<figcaption class="qr-caption mono">{caption}</figcaption>
	</figure>
{/if}

<style>
	.qr-figure {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		margin: 0;
		flex: none;
	}

	/* Always a white card: a QR inverted for dark mode is not reliably scannable. */
	.qr-card {
		padding: 10px;
		border: 1px solid color-mix(in srgb, #000 14%, var(--line));
		border-radius: var(--r-sm);
		background: #ffffff;
		box-shadow: 0 6px 18px -12px rgba(0, 0, 0, 0.45);
		line-height: 0;
	}

	.qr-card svg {
		display: block;
		width: min(var(--qr-size), 100%);
		height: auto;
	}

	.qr-caption {
		font-size: 9.5px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--ink-3);
		text-align: center;
	}

	.qr-fallback {
		display: flex;
		align-items: flex-start;
		gap: 9px;
		max-width: 260px;
		padding: 10px 12px;
		border: 1px solid color-mix(in srgb, var(--warn) 34%, var(--line));
		border-left-width: 2px;
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--warn) 7%, var(--surface));
		color: var(--ink-2);
		font-size: 11.5px;
		line-height: 1.5;
	}

	.qr-fallback-icon {
		color: var(--warn);
		margin-top: 1px;
		display: inline-flex;
	}

	.qr-fallback strong {
		display: block;
		color: var(--ink);
		font-weight: 600;
	}

	.qr-fallback p {
		margin-top: 2px;
	}
</style>
