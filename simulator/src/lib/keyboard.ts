/**
 * The keyboard, as the webview can see it.
 *
 * `MainActivity` pads its content view by `systemBars() | displayCutout()` —
 * nothing else (see the comment at the top of MainActivity.kt). The IME is not
 * in that inset set, and with edge-to-edge on a modern targetSdk the window is
 * not resized for the keyboard either, so the bottom bar would sit behind it.
 *
 * `env(safe-area-inset-bottom)` is not the answer: the same file records that
 * Android WebView does not expose it reliably, and the activity already pads
 * the navigation bar, so using it would double-count.
 *
 * What the webview does report honestly is the visual viewport, which shrinks
 * when the IME opens. The difference between the layout viewport and the visual
 * viewport is the keyboard. Where the window *is* resized by the keyboard
 * (older APIs, desktop shells), that difference is zero and nothing is padded
 * twice.
 */

/** Below this the difference is browser chrome, not a keyboard. */
const THRESHOLD = 24;

function coveredHeight(): number {
	const viewport = window.visualViewport;
	if (!viewport) return 0;
	// `offsetTop` covers the other half of the behaviour: some engines scroll the
	// visual viewport up instead of only shrinking it.
	const covered = window.innerHeight - viewport.height - viewport.offsetTop;
	return covered > THRESHOLD ? Math.round(covered) : 0;
}

/** Publish the keyboard height as `--df-kb`; returns the teardown. */
export function watchKeyboard(): () => void {
	const viewport = window.visualViewport;

	const apply = () => {
		document.documentElement.style.setProperty('--df-kb', `${coveredHeight()}px`);
	};

	apply();
	viewport?.addEventListener('resize', apply);
	viewport?.addEventListener('scroll', apply);
	window.addEventListener('resize', apply);
	window.addEventListener('orientationchange', apply);

	return () => {
		viewport?.removeEventListener('resize', apply);
		viewport?.removeEventListener('scroll', apply);
		window.removeEventListener('resize', apply);
		window.removeEventListener('orientationchange', apply);
		document.documentElement.style.removeProperty('--df-kb');
	};
}
