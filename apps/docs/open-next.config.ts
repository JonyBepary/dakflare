import { defineCloudflareConfig } from "@opennextjs/cloudflare";

/**
 * The docs site runs on Cloudflare Workers through OpenNext.
 *
 * It needs no incremental cache, no tag cache and no R2 for this content: every page is
 * prerendered, and the two dynamic routes (`/api/md`, `/api/mcp`) answer from the bundle and
 * from `public/`. Adding a cache later is a change here, not in the app.
 */
export default defineCloudflareConfig({});
