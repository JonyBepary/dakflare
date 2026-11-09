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
 *   cf d1 create sms_gateway
 *   npx wrangler kv namespace create KV
 */

export default defineConfig({
	worker: {
		name: "dakflare-worker",
		compatibilityDate: "2026-04-07",
		// better-auth imports node:crypto in its password utilities.
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "src/index.ts",
		previewUrls: false,

		observability: {
			enabled: true,
			headSamplingRate: 1,
		},

		/**
		 * Replaces wrangler.toml's `[[migrations]] new_sqlite_classes = ["DeviceGateway"]`.
		 * `storage: "sqlite"` matches the deployed backend exactly.
		 */
		exports: {
			DeviceGateway: exports.durableObject({ storage: "sqlite" }),
			// The single globally named failed-auth counter (lib/auth-limits.ts).
			AuthGuard: exports.durableObject({ storage: "sqlite" }),
			// The single globally named authority-grant expiry timer (v6.1 P0).
			AuthorityGuard: exports.durableObject({ storage: "sqlite" }),
		},

		triggers: [
			triggers.scheduled({
				schedule: "17 3 * * *",
			}),
		],

		env: {
			// ── inline configuration ────────────────────────────────────────────
			// Admin auth gate: `legacy` keeps ADMIN_TOKEN; `new` uses Better Auth
			// sessions via requireRole() (see worker/src/lib/config.ts authMode).
			AUTH_LOCKOUT_WINDOW_SECONDS: bindings.text("900"),
			// The free-tier password factor: the browser runs PBKDF2, the Worker
			// only peppers and compares. Without this var the factor is `off`, so
			// a cf deploy silently disabled password sign-in that wrangler.toml
			// had been enabling.
			AUTH_PASSWORD_MODE: bindings.text("client-derived"),
			// Magic link is advertised but sends nothing until RESEND_API_KEY is
			// a Worker secret; the sandbox sender is fine until a domain exists.
			MAGIC_LINK_FROM: bindings.text("DakFlare <onboarding@resend.dev>"),
			MAGIC_LINK_TTL_SECONDS: bindings.text("900"),
			FCM_BASE_URL: bindings.text("https://fcm.googleapis.com"),
			GOOGLE_TOKEN_URL: bindings.text("https://oauth2.googleapis.com/token"),
			MESSAGE_RETENTION_DAYS: bindings.text("90"),
			INCOMING_ROWS_PER_DAY: bindings.text("10000"),
			// AGPL-3.0 §13: `/source` redirects here.
			SOURCE_URL: bindings.text("https://github.com/OWNER/dakflare"),

			// ── storage ─────────────────────────────────────────────────────────
			// `id` is optional for D1 — provisioning fills it in on first deploy.
			DB: bindings.d1({
				name: "sms_gateway",
				id: "<D1_DATABASE_ID>",
			}),
			// KV needs a namespace id: run `npx wrangler kv namespace create KV` and paste it.
			KV: bindings.kv({
				id: "<KV_NAMESPACE_ID>",
			}),

			// ── Durable Object ──────────────────────────────────────────────────
			DEVICE: bindings.durableObject({
				worker: "dakflare-worker",
				exportName: "DeviceGateway",
			}),
			AUTH_GUARD: bindings.durableObject({
				worker: "dakflare-worker",
				exportName: "AuthGuard",
			}),
			AUTHORITY_GUARD: bindings.durableObject({
				worker: "dakflare-worker",
				exportName: "AuthorityGuard",
			}),

			// ── rate limiting (hardening S3) ────────────────────────────────────
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
			AUTH_FAIL_LIMITER: bindings.rateLimit({
				namespace: "1004",
				simple: { limit: 120, period: 60 },
			}),
			PAIR_GLOBAL_LIMITER: bindings.rateLimit({
				namespace: "1005",
				simple: { limit: 300, period: 60 },
			}),
			// Failed-auth lockout backstop (see lib/auth-limits.ts).
			AUTH_ACCOUNT_LIMITER: bindings.rateLimit({
				namespace: "1006",
				simple: { limit: 5, period: 60 },
			}),
			AUTH_IP_LIMITER: bindings.rateLimit({
				namespace: "1007",
				simple: { limit: 20, period: 60 },
			}),
		},
	},
});
