import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two Workers, two Vitest projects.
 *
 * The production split means the main Worker no longer owns `AssistantAgent`:
 * it proves the actor and forwards `/agents/*`, MCP and the conversation routes
 * through `AGENT_SVC`. A single-Worker harness could only test that by keeping
 * the old topology alive, so the projects mirror the deployment instead.
 *
 * - `main` runs `wrangler.toml` and mounts the real agent Worker as a Miniflare
 *   auxiliary Worker. `AGENT_SVC` resolves to it, so the gate, the proxy and the
 *   WebSocket upgrade are the production path.
 * - `agent` runs `wrangler.agent.toml` directly, which is the only way to get
 *   `env.ASSISTANT` plus `runInDurableObject` for the storage, journal and
 *   stream tests.
 *
 * Secrets are supplied here, never in either `wrangler.toml`, for the same
 * reason the deployment keeps them out of those files. The values are test-only
 * and fixed so a cookie signed in one test is readable in the next.
 */
const TEST_SECRETS = {
  ADMIN_TOKEN: "test-admin-token",
  // Test-only, and deliberately not the local `.dev.vars` value.
  BETTER_AUTH_SECRET: "dGVzdC1vbmx5LXNlY3JldC1ub3QtZm9yLWRlcGxveW1lbnQ=",
  AUTH_BASE_URL: "https://example.com",
  AUTH_TRUSTED_ORIGINS: "https://example.com",
} as const;

/** The D1 binding the auxiliary Worker shares with the Worker under test. */
const DATABASE_ID = "8d88069e-71cf-49a2-ba33-c150b02246b7";

interface MiniflareModule {
  type: "ESModule" | "CompiledWasm";
  path: string;
  contents: string | Uint8Array;
}

/**
 * Bundle the real agent Worker for Miniflare's auxiliary Worker slot.
 *
 * `cf deploy` bundles `src/agent-worker.ts` itself; Miniflare needs a module
 * graph it can start, so this is the same entry point through esbuild. Node
 * builtins stay external — `nodejs_compat` provides them inside workerd — and a
 * `createRequire` banner keeps the CJS dependencies that `require("path")` from
 * failing at startup. The output is generated per run and never written to the
 * repository.
 */
async function bundleAgentWorker(): Promise<MiniflareModule[]> {
  const result = await build({
    entryPoints: [path.join(HERE, "src/agent-worker.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "es2022",
    write: false,
    outfile: "agent-worker.js",
    external: ["cloudflare:*"],
    loader: { ".wasm": "file" },
    assetNames: "[name]-[hash]",
    logLevel: "silent",
    banner: {
      // Miniflare does not define `import.meta.url` for an auxiliary Worker's
      // module, so give createRequire a fixed base. Nothing is resolved
      // relative to it: the graph is bundled and only node builtins external.
      js: 'import { createRequire } from "node:module";\nconst require = createRequire("file:///worker/agent-worker.js");',
    },
  });
  return result.outputFiles.map((file) => ({
    type: file.path.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
    path: path.basename(file.path),
    contents: file.contents,
  }));
}

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(HERE, "migrations"));
  const agentModules = await bundleAgentWorker();

  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.toml" },
              // The deployed Worker has an `[ai]` binding, which is remote-only.
              // No test calls it, and starting the remote proxy session would
              // need a Cloudflare account (and could bill). Keep every binding
              // local.
              remoteBindings: false,
              miniflare: {
                bindings: { ...TEST_SECRETS, TEST_MIGRATIONS: migrations },
                // The split agent Worker, built from the same entry point as
                // `worker/agent/cloudflare.config.ts`. Its `ASSISTANT` namespace
                // is separate storage, as in production.
                workers: [
                  {
                    name: "dakflare-agent-worker",
                    compatibilityDate: "2026-04-07",
                    compatibilityFlags: ["nodejs_compat"],
                    modules: agentModules,
                    bindings: {
                      AGENT_RUNTIME: "on",
                      D1_READ_REPLICATION: "off",
                      ...TEST_SECRETS,
                    },
                    d1Databases: { DB: DATABASE_ID },
                    r2Buckets: { MEDIA_BUCKET: "dakflare-media" },
                    durableObjects: {
                      ASSISTANT: { className: "AssistantAgent", useSQLite: true },
                    },
                  },
                ],
              },
            }),
          ],
          test: {
            name: "main",
            include: ["test/**/*.test.ts"],
            // These three need the object itself, not the proxy: they read and
            // write its SQLite through `runInDurableObject`.
            exclude: [
              "test/durable-storage.test.ts",
              "test/journal-replay.test.ts",
              "test/streams-resume.test.ts",
            ],
            setupFiles: ["./test/setup.ts"],
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.agent.toml" },
              remoteBindings: false,
              miniflare: {
                bindings: { ...TEST_SECRETS, TEST_MIGRATIONS: migrations },
                workers: [
                  // `CORE` targets the main Worker in production. The agent
                  // tests never call it, but Miniflare refuses to start with a
                  // service binding it cannot resolve, so stand the target up.
                  {
                    name: "dakflare-worker",
                    compatibilityDate: "2026-04-07",
                    compatibilityFlags: ["nodejs_compat"],
                    script:
                      "export default { fetch: () => Response.json({ error: 'test_stub' }, { status: 503 }) };",
                    modules: true,
                  },
                ],
              },
            }),
          ],
          test: {
            name: "agent",
            include: [
              "test/durable-storage.test.ts",
              "test/journal-replay.test.ts",
              "test/streams-resume.test.ts",
            ],
            setupFiles: ["./test/setup.ts"],
          },
        },
      ],
    },
  };
});
