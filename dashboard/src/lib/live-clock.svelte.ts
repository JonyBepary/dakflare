/**
 * One clock for every relative timestamp in the console.
 *
 * A `RelativeTime` label is only as fresh as the value it was rendered with. A
 * page-wide timer per label would be wasteful, so components subscribe here and
 * one visible-only interval advances the shared value every 30 seconds. A tab
 * return refreshes immediately rather than waiting for the next tick.
 */

let now = $state(Date.now());
let subscribers = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function tick(): void {
	if (document.visibilityState === 'visible') now = Date.now();
}

function onVisible(): void {
	if (document.visibilityState === 'visible') now = Date.now();
}

function start(): void {
	if (timer !== null) return;
	now = Date.now();
	timer = setInterval(tick, 30_000);
	document.addEventListener('visibilitychange', onVisible);
}

function stop(): void {
	if (timer !== null) {
		clearInterval(timer);
		timer = null;
	}
	document.removeEventListener('visibilitychange', onVisible);
}

export function currentTime(): number {
	return now;
}

/** Bring every relative label up to `Date.now()` after a value update. */
export function refreshClock(): void {
	now = Date.now();
}

export function subscribeClock(): () => void {
	subscribers += 1;
	if (subscribers === 1) start();
	return () => {
		subscribers = Math.max(0, subscribers - 1);
		if (subscribers === 0) stop();
	};
}
