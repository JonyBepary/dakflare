---
name: dakflare
description: "Operate, deploy, automate, and integrate DakFlare—the sovereign Android + Cloudflare Workers SMS gateway, Telegram/WhatsApp hub, Rust/Wasm flow engine, and MCP control plane."
---

# DakFlare — Unified Agent Skill

Use this skill whenever provisioning, debugging, messaging, authoring `dakflare.flow/v2` graphs, or integrating agents with a DakFlare deployment.

## Core Architecture & Canonical Names

- **Handset (`dev.dakflare.simulator`)**: Tauri v2 + Rust `core/` + Kotlin telephony + Svelte 5. Holds `android.app.role.SMS`, wraps its P-256 private key in Android Keystore (`keystore:v1:<iv>:<ciphertext>`), runs `simulator/flow` offline, and operates honestly as `poll-only` on GMS-free LineageOS.
- **Edge Coordinator (`dakflare-worker`)**: Cloudflare Worker with 4 SQLite Durable Objects (`DeviceGateway`/`DEVICE`, `AuthGuard`/`AUTH_GUARD`, `AuthorityGuard`/`AUTHORITY_GUARD`, `AssistantAgent`/`ASSISTANT`), D1 `sms_gateway` (17 migrations `0001`–`0017`), `KV` (FCM cache), `MEDIA_BUCKET` (R2, 24h `agent_attachments`), `WEBHOOK_QUEUE`, `FLOW_WORKFLOW` (`FlowExecutionWorkflow`), `AI` (Clef System 1), and 7 rate limiters.
- **Canonical Identifiers (Never Substitute Synonyms)**: `device_id` (never `handsetId`), `command_id`, `local_id`, `dkf_agt_` (agent token), `ag1_` (apply handle), `dakflare.flow/v2`, `DakFlareApi`.

## Non-Negotiable Rules (and Why)

1. **An SMS send is asynchronous; `SENT` is NOT delivery.**
   - *Why*: `SENT` only means the handset radio accepted the SMS. Carrier delivery is confirmed only on `DELIVERED` (`verification.passed === true`).
   - *Do*: Pass `--idempotency-key` whenever a retry is possible. If `dakflare send` exits `75` (still in flight), poll `dakflare status <command_id>`—never re-run `send`.
2. **Never give an agent `ADMIN_TOKEN`.**
   - *Why*: Agents can be prompt-injected into runaway SMS spend. Mint a scoped `dkf_agt_` token (`dakflare auth mint-agent-token`). Costly scopes (`sms:send:production` ≤1h, `flow_deploy_prod` ≤1d, `enable_shortcode` ≤15m, `dlq_bulk_replay` ≤15m) require a live time-boxed human grant. `devices:revoke` and `auth:reset` are `NEVER_GRANTABLE`.
3. **Never write coordinates into `dakflare.flow/v2` and never leave variables unbound on any branch.**
   - *Why*: The Worker computes deterministic `rank-v1` layouts on save, and the validator intersects variables guaranteed across every incoming edge so templates never render empty strings at runtime. Patterns must use RE2-compatible `(?<name>...)` (never `(?P<name>...)`).
4. **Always run `dakflare flows apply --dry-run` before writing, and use `dakflare flows heal` for extraction drift.**
   - *Why*: `flows heal` proves byte-for-byte capture compatibility against historical D1 messages and exits `6` if any regression occurs.
5. **Keep all three Cloudflare configs in sync and verify deploys by evidence.**
   - *Why*: `cf deploy` reads `worker/cloudflare.config.ts`, while `wrangler` reads `worker/wrangler.toml` and `worker/wrangler.account.toml`. Run `cd worker && npm run check:config`. Pass the D1 **UUID** (never `sms_gateway`) to `cf d1 migrations apply`. Because `cf deploy` can exit `1` on an intermittent Cloudflare Workflows API 500 even after uploading cleanly, always verify with `npm run verify:deploy` and `dakflare doctor`.
6. **Never uninstall the Android app to fix pairing.**
   - *Why*: Uninstalling wipes the local libSQL store, the Keystore-wrapped P-256 identity, and the battery whitelist. Run `dakflare doctor` and `dakflare devices` first.
7. **Inbound webhooks (`POST /v1/webhooks/:id`) can read and propose, never act.**
   - *Why*: Webhook turns run as synthetic actor `webhook:<id>`, so `authorizeAct` refuses all effects with `webhook_cannot_act` even when an autonomy window is open.

## CLI Quick Reference (`--agent` Always Emits Single JSON)

```bash
dakflare capabilities --agent                      # discover all 28 commands
dakflare doctor --agent                            # full edge + handset health
dakflare send --device <id> --to <e164> --body "..." --idempotency-key <key> --agent
dakflare status <command_id> --device <id> --wait 60s --agent
dakflare flows apply flow.json --dry-run --agent
dakflare flow test --flow <id> --corpus corpus.jsonl --agent
dakflare trace <id> --agent
dakflare mcp serve --token-file ~/.dakflare-agent-token
```

Semantic exit codes: `0` ok, `1` failed, `2` usage/invalid, `3` not found, `4` permission, `5` conflict, `6` precondition/approval_required, `75` temporary/in-flight.
