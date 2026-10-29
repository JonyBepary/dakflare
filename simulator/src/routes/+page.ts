import { redirect } from '@sveltejs/kit';

// The SPA's home is Threads. SvelteKit's client router turns a load redirect
// into a history replacement, so launching at `/` leaves no extra entry behind
// for Android's back button to walk into.
export const load = () => {
	throw redirect(307, '/messages');
};
