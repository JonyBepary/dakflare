// Client-rendered only: this is an authenticated admin app, so there is no SEO
// or server-rendering benefit. Every route is still PRERENDERED to its own HTML
// shell at build time, so the assets layer can serve `/admin/devices` directly
// (no SPA fallback, and `/admin/index.html` keeps the root route). The shell is
// empty until the client hydrates, which is exactly what a SPA wants.
export const ssr = false;
export const prerender = true;
