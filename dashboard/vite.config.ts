import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// Pure SPA: no server rendering, no server routes. The dashboard is served
			// as static assets by the API Worker under /admin, and talks to the same
			// origin's JSON API. See worker/src/index.ts for the /admin route.
			// No `fallback`: every route is prerendered to its own HTML file, so the
			// assets layer resolves `/admin/devices` directly. A fallback would
			// overwrite the root `index.html` with the generic shell.
			adapter: adapter({
				pages: '../worker/public/admin',
				assets: '../worker/public/admin'
			}),

			// Served under /admin, so every asset URL and route is prefixed.
			paths: { base: '/admin' },
		})
	],

	resolve: {
		// SvelteKit 3 dropped the implicit `$lib` alias. Keep it explicit in both the
		// bundler and tsconfig rather than opting into the deprecated `kit.alias`.
		alias: {
			$lib: new URL('./src/lib', import.meta.url).pathname
		}
	},

	// Local development only: forward the API and the session endpoint to
	// `wrangler dev`. Deliberately not a broad `/admin` proxy — that would swallow
	// the SPA's own routes under the same prefix.
	server: {
		proxy: {
			'/v1': 'http://127.0.0.1:8787',
			'/admin/session': 'http://127.0.0.1:8787'
		}
	}
});
