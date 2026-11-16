import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Workers Vitest pool.
 *
 * The tests run inside workerd against the real `wrangler.toml`, so D1, the
 * Durable Object namespaces and the WebSocket upgrade path are the production
 * ones rather than re-implementations. `__checks__` stays on plain node: it is
 * the fast, dependency-free lane (`node --experimental-strip-types`).
 *
 * Secrets are supplied here, never in `wrangler.toml`, for the same reason the
 * deployment keeps them out of that file. The values are test-only and fixed so
 * a cookie signed in one test is readable in the next.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(HERE, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        // The deployed Worker has an `[ai]` binding, which is remote-only. No
        // test calls it, and starting the remote proxy session would need a
        // Cloudflare account (and could bill). Keep every binding local.
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token",
            // Test-only, and deliberately not the local `.dev.vars` value.
            BETTER_AUTH_SECRET: "dGVzdC1vbmx5LXNlY3JldC1ub3QtZm9yLWRlcGxveW1lbnQ=",
            AUTH_BASE_URL: "https://example.com",
            AUTH_TRUSTED_ORIGINS: "https://example.com",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/setup.ts"],
    },
  };
});
