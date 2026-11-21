import { bindings, defineConfig, exports } from "cf/config";

/**
 * The split agent Worker (`dakflare-agent-worker`).
 *
 * Deployed from its own directory so `cf build` produces an isolated Build
 * Output. It is not reachable from the internet; the main Worker calls it
 * through the AGENT_SVC service binding.
 */
export default defineConfig({
	worker: {
		name: "dakflare-agent-worker",
		compatibilityDate: "2026-04-07",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint: "../src/agent-worker.ts",
		previewUrls: false,
		workersDev: false,
		observability: { enabled: true, headSamplingRate: 1 },
		exports: {
			AssistantAgent: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			ASSISTANT: bindings.durableObject({
				worker: "dakflare-agent-worker",
				exportName: "AssistantAgent",
			}),
			DB: bindings.d1({
				name: "sms_gateway",
				id: "8d88069e-71cf-49a2-ba33-c150b02246b7",
			}),
			MEDIA_BUCKET: bindings.r2({ name: "dakflare-media" }),
			AI: bindings.ai(),
			CORE: bindings.worker({ worker: "dakflare-worker" }),
			AGENT_RUNTIME: bindings.text("on"),
			D1_READ_REPLICATION: bindings.text("off"),
		},
	},
});
