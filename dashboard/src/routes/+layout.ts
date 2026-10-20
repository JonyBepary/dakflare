// Client-rendered only. The dashboard is an authenticated admin app: no SEO, no
// server rendering, and no server routes (adapter-static). All data comes from the
// same origin's JSON API with the session cookie.
export const ssr = false;
export const prerender = false;
