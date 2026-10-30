/**
 * One polite live region for the whole console, mounted by +layout.svelte
 * before any page renders. A notice is inserted with its text already in
 * place, so a live region created at that moment is not reliably announced;
 * writing into a region that already exists is.
 *
 * The text is cleared before each new message so a repeated identical
 * message still changes the region and is announced again.
 */
class Announcer {
	text = $state('');

	announce(message: string): void {
		const next = message.trim();
		if (next === '') return;
		this.text = '';
		// A separate task: Svelte batches the clear and the set into one flush
		// otherwise, and the region never passes through empty.
		queueMicrotask(() => {
			this.text = next;
		});
	}
}

export const announcer = new Announcer();

export function announce(message: string): void {
	announcer.announce(message);
}
