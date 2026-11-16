import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

/**
 * One schema for the whole file.
 *
 * `applyD1Migrations` records what it applied in `d1_migrations`, so calling it
 * once before the first test is enough; `reset()` is deliberately not used
 * between tests because the pool's isolated storage already gives each file a
 * clean database.
 */
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
