import { bindings, defineConfig, exports, triggers } from "cf/config";

/**
 * TEMPLATE — copy to `cloudflare.config.ts` for a fresh install:
 *
 *   cp cloudflare.config.template.ts cloudflare.config.ts
 *
 * Deliberately contains no D1 id and no KV id. Those identify *one account's* resources; committing
 * them makes the repo deployable only into the author's account.
 *
 * The committed `cloudflare.config.ts` keeps the maintainer's ids so their own deploys do not create a
 * fresh empty database. A fork replaces it with this file.
 *
 * Create the resources first, or let `cf deploy` / `wrangler deploy` provision them:
 *   npx wrangler d1 create sms_gateway
 *   npx wrangler kv namespace create KV
 */

export default defineConfig({
	worker: {
		name: "dakflare-worker",
		compatibilityDate: "2026-04-07",
		entrypoint: "src/index.ts",
		previewUrls: false,

		observability: {
			enabled: true,
			headSamplingRate: 1,
		},

		exports: {
			DeviceGateway: exports.durableObject({ storage: "sqlite" }),
		},

		triggers: [triggers.scheduled({ schedule: "17 3 * * *" })],

		env: {
			FCM_BASE_URL: bindings.text("https://fcm.googleapis.com"),
			GOOGLE_TOKEN_URL: bindings.text("https://oauth2.googleapis.com/token"),
			MESSAGE_RETENTION_DAYS: bindings.text("90"),
			// AGPL-3.0 §13: point `/source` at YOUR fork.
			SOURCE_URL: bindings.text("https://github.com/OWNER/dakflare"),

			// `id` is optional for D1 — provisioning fills it in on first deploy.
			DB: bindings.d1({ name: "sms_gateway" }),

			// KV needs a namespace id: run `npx wrangler kv namespace create KV` and paste it.
			KV: bindings.kv({ id: "<KV_NAMESPACE_ID>" }),

			DEVICE: bindings.durableObject({
				worker: "dakflare-worker",
				exportName: "DeviceGateway",
			}),

			PAIR_LIMITER: bindings.rateLimit({
				namespace: "1001",
				simple: { limit: 30, period: 60 },
			}),
			ADMIN_LIMITER: bindings.rateLimit({
				namespace: "1002",
				simple: { limit: 600, period: 60 },
			}),
			DEVICE_LIMITER: bindings.rateLimit({
				namespace: "1003",
				simple: { limit: 600, period: 60 },
			}),
		},
	},
});
