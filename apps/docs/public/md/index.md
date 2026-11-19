# DakFlare — Sovereign Multi-Platform Messaging Hub & SMS Gateway

DakFlare pairs an Android handset (`dev.dakflare.simulator`) with a Cloudflare Worker (`dakflare-worker`). The handset holds the SIM, acts as the Android default SMS app (`android.app.role.SMS`), signs every HTTP/WebSocket request with a hardware-wrapped P-256 key (`keystore:v1:<iv>:<ciphertext>`), and evaluates `dakflare.flow/v2` graphs locally in Rust. The Worker verifies signatures and replay nonces, orchestrates four SQLite-backed Durable Objects (`DeviceGateway`, `AuthGuard`, `AuthorityGuard`, `AssistantAgent`), stores state in D1 (`sms_gateway`, 17 migrations `0001`–`0017`), dispatches webhooks via `WEBHOOK_QUEUE` and long delays via `FlowExecutionWorkflow`, serves the SvelteKit console at `/admin`, and exposes an agent control plane (`/mcp`, `/v1/agent/*`, `DakFlareApi` service binding).

## Navigation Index (Ordered by Onboarding Priority)

- **Start Here (Tutorials)**: `/start/quickstart.md`, `/start/first-wasm-flow.md`, `/start/connect-mcp-agent.md`
- **How-To Guides**: `/guides/android-node-pairing.md`, `/guides/durable-objects-routing.md`, `/guides/visual-workflow-editor.md`, `/guides/agent-authority-and-webhooks.md`, `/guides/self-hosting-production.md`
- **Reference**: `/reference/api-reference.md`, `/reference/mcp-tools.md`, `/reference/wasm-flow-abi.md`, `/reference/cli-and-env.md`, `/reference/state-machines.md`, `/reference/glossary.md`
- **Architecture**: `/architecture/sovereign-edge-model.md`, `/architecture/security-p256-identity.md`, `/architecture/wasm-and-agent-isolation.md`
- **Machine Endpoints**: `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `/SKILL.md`, `/AGENTS.md`, `POST /mcp`

## System Topology at a Glance

| Layer | Implementation | Responsibility |
| --- | --- | --- |
| **Handset Radio** | `simulator/` (Tauri v2 + Rust `core/` + Kotlin `bridge/` + Svelte 5) | Owns the SIM, holds `android.app.role.SMS`, wraps P-256 identity in Android Keystore, runs `simulator/flow` offline, syncs via WebSocket or polling |
| **Edge Coordinator** | `worker/` (`dakflare-worker`, TypeScript on Cloudflare Workers) | Verifies P-256 signatures & nonces, hosts REST API, Better Auth, channels (SMS, Telegram, WhatsApp Cloud), `flow.wasm` fallback, Clef System 1, and `/mcp` |
| **Durable Objects** | `DeviceGateway` (`DEVICE`), `AuthGuard` (`AUTH_GUARD`), `AuthorityGuard` (`AUTHORITY_GUARD`), `AssistantAgent` (`ASSISTANT`) | Per-device command queue/replay/alarms, account & IP lockout, live grant windows, and stateful streaming agent runtime |
| **Durable Storage & Async** | D1 (`DB` / `sms_gateway`), KV (`KV`), R2 (`MEDIA_BUCKET`), Queue (`WEBHOOK_QUEUE`), Workflow (`FLOW_WORKFLOW`) | 17-migration SQLite ledger, FCM token cache, 24h agent attachments, SSRF-guarded webhook retries, >5s flow delays |
| **Operator Console** | `dashboard/` (Svelte 5 with SvelteKit `adapter-static` → `worker/public/admin`) | Served at `/admin`; fleet presence, messages, Svelte Flow editor with WebMCP, approvals/grants, floating Assistant, audit log, security |
| **Operator CLI** | `cli/` (`dakflare`, zero-dependency Node 22+) | 27 commands, `--agent` single-JSON contract, semantic exit codes (`0, 1, 2, 3, 4, 5, 6, 75`), `dakflare mcp serve` stdio bridge |
