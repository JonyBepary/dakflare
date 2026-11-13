# DakFlare Multi-Platform AI-First Agentic Hub Specification

> **Specification Version**: 7.0.0 proposal  
> **Status**: partly shipped. The table below is the tree today; the rest of the document is the
> design it was written against.
> **Applies to**: Cloudflare Workers, Durable Objects, D1, Android app, SvelteKit console  

---

## 0. What is in the tree today

| Area | State |
|---|---|
| Telegram and WhatsApp Cloud webhooks | shipped: `worker/src/channels/`, `POST /v1/channels/{telegram,whatsapp}/webhook` |
| Conversations, `messages.channel`, `messages.conversation_id` | shipped in `0007_multi_platform_and_conversations.sql` |
| WhatsApp 24-hour window and `template_required` | shipped in `channels/whatsapp-cloud.ts` |
| Canonical lifecycle object | shipped: `worker/src/lib/canonical-lifecycle.ts` |
| `FlowExecutionWorkflow` for delays and long steps | shipped; delays over five seconds |
| `WEBHOOK_QUEUE` for outbound webhooks | shipped |
| Workflow versions, audience lists, plugin tables | schema shipped in `0007`; no route, console or runtime reads them yet |
| Editor | shipped as two surfaces (`Steps`, `Map`) plus a read-only `Source` sheet, not the tri-modal Simple/Canvas/Code below |
| `MEDIA_BUCKET` (R2) and `AI` (Workers AI) | bindings only; no Worker route reads them |
| Signal and the Android notification bridge | not implemented |
| Plugin registry, signed catalogs and the WASM sandbox | not implemented; the tables exist |
| `WEBHOOK_DLQ` | not implemented; device dead letters live in the Durable Object and are read by `dakflare dlq` |
| AI Gateway, BYOK and OAuth provider phases | not implemented |

---

## 1. Executive Summary

DakFlare began as a self-hosted SMS gateway pairing one Android handset with one Cloudflare Worker coordinator. With the v6.1.0 release, core radio leasing, D1 authority atomicity, loop detection, and SSRF protections were hardened and verified. 

DakFlare v7.0 transitions the platform from a single-handset SMS relay into an **AI-first, multi-platform agentic messaging hub** spanning SMS, WhatsApp, Telegram, Signal, and third-party extensions.

```
                                  DAKFLARE v7.0 TOPOLOGY
                                  
   +─────────────────────────────── MESSAGING CHANNELS ───────────────────────────────+
   │                                                                                  │
   │   Android Handset       Telegram Bot API      WhatsApp Cloud API     Signal / ...│
   │    (SMS/MMS Radio)       (Secret Token)        (Meta Graph API)    (Handset Notif)
   +───────────┬─────────────────────┬─────────────────────┬─────────────────────┬────+
               │                     │                     │                     │
               ▼                     ▼                     ▼                     ▼
   +──────────────────────────────────────────────────────────────────────────────────+
   │                   CLOUDFLARE WORKER COORDINATOR (EDGE RUNTIME)                   │
   │                                                                                  │
   │  Ingress Router & Webhook Verifier ──> Canonical Lifecycle Normalizer            │
   │                                                                                  │
   │  ┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐ │
   │  │  Durable Objects (DO) │  │  Cloudflare Workflows │  │   Workers AI (env.AI) │ │
   │  │  • DeviceGateway      │  │  • FlowExecutionWF    │  │   • @cf/.../clef-flash│ │
   │  │  • ConversationCoord  │  │    (step.sleep/do/    │  │   • ai_classify       │ │
   │  │  • Auth/AuthorityGuard│  │     waitForEvent)     │  │   • ai_extract        │ │
   │  └───────────────────────┘  └───────────────────────┘  └───────────────────────┘ │
   │                                                                                  │
   │  ┌───────────────────────┐  ┌───────────────────────┐  ┌───────────────────────┐ │
   │  │  Cloudflare Queues    │  │  Storage Tiers        │  │   WASM Plugin Sandbox │ │
   │  │  • WEBHOOK_QUEUE      │  │  • D1 (Relational/AST)│  │   • Tier-1 WASI/WASM  │ │
   │  │  • WEBHOOK_DLQ        │  │  • R2 (Media/Blobs)   │  │   • Signed Repos      │ │
   │  │                       │  │  • KV (Session cache) │  │     (index.min.json)  │ │
   │  └───────────────────────┘  └───────────────────────┘  └───────────────────────┘ │
   +──────────────────────────────────────────────────────────────────────────────────+
               ▲                                                   ▲
               │                                                   │
               ▼                                                   ▼
   +────────────────────────────+                     +───────────────────────────────+
   │   TRI-MODAL SUPER EDITOR   │                     │      AGENT CONTROL PLANE      │
   │   • Simple Mode (WHEN/IF)  │                     │   • Model Context Protocol    │
   │   • Canvas Mode (SvelteFlow│                     │     (POST /v1/mcp)            │
   │   • Code Mode (YAML/JSON)  │                     │   • Authority Grants & Tokens │
   │   • Live flow.wasm Bench   │                     │   • Human-in-the-Loop (HITL)  │
   +────────────────────────────+                     +───────────────────────────────+
```

---

## 2. Ratified Architectural Decisions

### 2.1. Messaging Platform Integration Strategy: Official Cloud APIs First

1. **Phase 1 (Native Official Cloud APIs)**:
   - **Telegram**: Telegram Bot API (`POST /v1/channels/telegram/webhook`) verifying `X-Telegram-Bot-Api-Secret-Token`. Instant setup, zero cost, built-in retry parameters.
   - **WhatsApp**: Meta WhatsApp Business Cloud API (`POST /v1/channels/whatsapp/webhook`) verifying `X-Hub-Signature-256`. Enforces the 24-hour customer service window natively.
   - **SMS/MMS**: Android Handset Native Radio (`SmsReceiver.kt` + `SmsManager`) via the existing cryptographic WebSocket/P-256 transport (`history/PROTOCOL_CONTRACT_V5.md`).
2. **Phase 2 (Android Handset Notification Bridge)**:
   - For platforms without bot APIs (Signal) or where personal numbers are automated, an Android `NotificationListenerService` and `RemoteInput` bridge runs on the handset. The phone's official apps (WhatsApp, Signal, Telegram) receive messages and send replies using OS-level intents without protocol reverse engineering or ban risk.
3. **Phase 3 (Companion Linked-Device Protocol Wrappers)**:
   - Linked-device clients (e.g. Baileys / whatsmeow) are deferred to optional, community-run plugins due to account suspension risks.

### 2.2. 100% Cloudflare Free-Tier Native (with Elastic Pro Scaling)

The architecture operates completely within the limits of Cloudflare's Free tier:
- **Workflows**: Max 3,000 steps/day on Free. We utilize a **Hybrid Fast-Path**: linear, immediate flows (trigger $\to$ extract $\to$ reply) execute in-isolate synchronously via `flow.wasm` (0 workflow steps). A Cloudflare Workflow instance is triggered *only* when a flow requires `delay > 0` (`step.sleep`), webhook retries (`step.do`), or human approval (`step.waitForEvent`).
- **Queues**: 10,000 operations/day free. Webhook and outbound batches are coalesced using `sendBatch()`, with dead-letter messages drained into D1 `dead_letters` to prevent loss at the 24-hour Free retention cliff.
- **R2**: 10 GB-month free. Attachments auto-expire according to `MESSAGE_RETENTION_DAYS` (default 90 days), with presigned direct upload/download URLs generated via `aws4fetch`.
- **Workers AI**: 10,000 free Neurons/day. Deterministic keyword and regex filters execute in `flow.wasm` *before* invoking AI models, with ultra-lightweight models (`@cf/cloudflare/clef-flash` and `@cf/meta/llama-3.1-8b-instruct-fast`) consuming $\approx 1.5 - 3$ Neurons per classification.
- **Plugin Sandboxing**: Standard Workers Free does not include Workers for Platforms (dispatch namespaces). Third-party plugins default to WebAssembly (WASM) sandboxes with memory and CPU fuel limits, with Workers for Platforms reserved for enterprise multi-tenant deployments.

### 2.3. AI Provider Evolution
- **Phase 1 (Default)**: Native Cloudflare Workers AI (`env.AI`). Zero external API keys.
- **Phase 2 (BYOK)**: Cloudflare AI Gateway universal endpoint for Gemini, Claude, and OpenAI with encrypted API keys in D1.
- **Phase 3 (OAuth 2.1 PKCE)**: RFC 9728 / OpenRouter PKCE flows for browser-delegated token minting without manual key handling.

---

## 3. Explicit Multi-Channel State Machines

### 3.1. Unified Multi-Channel Outbound Delivery Machine

```
              ┌───────────────┐
              │    QUEUED     │
              └───────┬───────┘
                      │
                      ▼
         ┌─────────────────────────┐
         │  LEASED_OR_DISPATCHING  │
         └────────────┬────────────┘
                      │
                      ▼
         ┌─────────────────────────┐
         │   ACCEPTED_BY_CHANNEL   │ (SENT)
         └────────────┬────────────┘
         ┌────────────┴────────────┐
         │                         │
         ▼                         ▼
  ┌──────────────┐          ┌──────────────┐
  │  DELIVERED   │          │ SETTLED_SENT │ (SMS carrier grace 5m)
  └──────┬───────┘          └──────┬───────┘
         │                         │
         ▼                         ▼
  ┌──────────────┐          ┌──────────────┐
  │     READ     │          │   TERMINAL   │
  └──────────────┘          └──────────────┘
```

- **States**: `QUEUED` $\to$ `LEASED_OR_DISPATCHING` $\to$ `ACCEPTED_BY_CHANNEL` $\to$ `DELIVERED` $\to$ `READ`.
- **Terminal States**: `DELIVERED`, `READ`, `SETTLED_SENT` (SMS without status PDU after 5m grace), `FAILED_PERMANENT`, `EXPIRED`.
- **Transient States**: `RETRY_BACKOFF` (HTTP 429 `retry_after`), `FALLBACK_TRIGGERED` (WhatsApp failed $\to$ SMS queued).
- **Canonical Lifecycle Tuple**: Every command and outbound message response includes:
  ```json
  {
    "lifecycle": {
      "channel": "sms",
      "state": "ACCEPTED_BY_CHANNEL",
      "substate": "awaiting_carrier_pdu",
      "is_terminal": false,
      "settled": false,
      "remediation": null
    }
  }
  ```

### 3.2. Conversation Session & Policy Window Machine

Per `(channel, account_id, peer_id)`:

```
        ┌──────────────────┐
        │    NO_SESSION    │
        └────────┬─────────┘
                 │ Inbound Customer Message
                 ▼
        ┌──────────────────┐
        │   WINDOW_OPEN    │ (expires_at = inbound + 24h)
        └────────┬─────────┘
                 │ 24 Hours Elapsed
                 ▼
        ┌──────────────────┐
        │  TEMPLATE_ONLY   │ (Free-text disabled; pre-approved templates only)
        └────────┬─────────┘
                 │ STOP / Opt-Out Received
                 ▼
        ┌──────────────────┐
        │    OPTED_OUT     │ (All outbound blocked)
        └──────────────────┘
```

- **`NO_SESSION`**: No prior customer interaction.
- **`WINDOW_OPEN`**: Inbound customer message received within the last 24 hours. Free-form text, media, and interactive messages are permitted.
- **`TEMPLATE_ONLY`**: Window expired. In WhatsApp, only pre-approved Meta Business Templates are permitted. Free-form attempts return exit code `6` (`precondition: template_required`).
- **`OPTED_OUT`**: Peer replied with `STOP`, `UNSUBSCRIBE`, or carrier block keyword. All outbound traffic fails closed.

### 3.3. Connector & Companion Session Machine

Normalizes Android KeyStore P-256 handsets, WhatsApp companions, Signal sessions, and Telegram webhooks into one fleet model:
- `UNCONFIGURED` $\to$ `PAIRING_QR_READY` $\to$ `HANDSHAKING` $\to$ `LIVE_SOCKET` $\to$ `SYNCED_POLLING` $\to$ `DEGRADED_RATE_LIMITED` $\to$ `REAUTH_REQUIRED` $\to$ `REVOKED`.

---

## 4. Editor specification (`dakflare.flow/v3`)

The editor shipped as two surfaces plus a sheet: `Steps` (the form-like surface, default), `Map` (the
SvelteFlow canvas) and `Source` (read-only JSON with apply). The tri-modal name below was the design
target; YAML, monaco and the 50-state ring buffer did not ship. Undo is grouped by edit burst.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  ← Workflow / Order Confirmation [v5 • Published]  [Simple] [Canvas] [Code]    │
└─────────────────────────────────────────────────────────────────────────────────┘
```

1. **Simple Mode (Form Builder)**:
   - Default for linear rules (trigger $\to$ extract $\to$ reply) and mobile screens.
   - Clean, stacked `WHEN` (channel & trigger), `IF` (filters & rate limits), `THEN` (action) cards.
   - 100% interoperable with Canvas Mode.
2. **Canvas Mode (`@xyflow/svelte`)**:
   - For multi-branching DAGs, conditional splits, multi-channel fallbacks (Try WhatsApp $\to$ Fail $\to$ SMS), and agent loops.
   - Built on `$state.raw()` with an immutable 50-state snapshot ring buffer for `Ctrl+Z` / `Ctrl+Y` undo/redo.
   - Stable handle IDs: dynamic case handles use stable UUIDs rather than array indices (`case:0`, `case:1`) to prevent branch rewiring during reorders.
   - Direct embedded `flow.wasm` client-side evaluation ($< 16$ms instantaneous path animation).
3. **Code Mode (Declarative YAML / JSON)**:
   - Full JSON Schema validation and monaco/code-mirror editing with live visual diffing for power users and AI agents.

---

## 5. Decentralized Plugin Ecosystem (Tachiyomi / Mihon Style)

Plugins are distributed via static, signed JSON registries (`index.min.json`):

```
[ Plugin Repository ]
  ├── index.min.json (Catalog, versions, SHA-256, Ed25519 signatures, permissions)
  └── packages/
      └── com.dakflare.whatsapp.cloud-1.0.0.dkfpkg
```

### 5.1. Dual-Tier Sandboxing
- **Tier 1 (WASI / WebAssembly)**: Pure data transforms, custom matchers, and regex synthetics. Zero network, memory capped at 16 MiB, CPU fuel metered. Runs identically in Worker edge and Android Rust.
- **Tier 2 (Networked Connectors & Tools)**: Outbound fetch calls mediated through host allowlisting (`manifest.permissions.allowed_hosts`), secrets injected at the edge, and private RFC 1918 IPs blocked.

---

## 6. Implementation Action Plan

Status: phase 1 is done except the parts noted; phase 2 is done except the DLQ; phases 3 and 4 are
partial and not started as described.

### Phase 1: Database Migration & Core Edge Bindings (shipped)
1. **D1 Migration `0007_multi_platform_and_conversations.sql`**:
   - Add `channel` and `conversation_id` to `messages`.
   - Create `conversations` table.
   - Create `workflow_versions` table for immutable versioning and rollbacks.
   - Create `audience_lists` and `audience_members` tables.
   - Create `plugin_repos` and `installed_plugins` tables.
   - Extend `workflows` with `channel`, `priority`, `cooldown_s`, and `max_per_hour`.
2. **Edge Configuration Sync**:
   - Add `AI`, `MEDIA_BUCKET`, `WEBHOOK_QUEUE`, and `FLOW_WORKFLOW` bindings to `cloudflare.config.ts`, `wrangler.toml`, and templates.
3. **Canonical Lifecycle Object**:
   - Implement `worker/src/lib/canonical-lifecycle.ts` and attach to command/message APIs.

### Phase 2: Official Messaging Channels & Hybrid Fast-Path (shipped, no `WEBHOOK_DLQ`)
1. Implement `worker/src/channels/telegram.ts` (Bot API webhook + 429 retry backoff).
2. Implement `worker/src/channels/whatsapp-cloud.ts` (Meta Graph API + 24h window enforcement).
3. Wire Cloudflare Workflow `FlowExecutionWorkflow` for durable delays and webhooks.

### Phase 3: Editor surfaces and WASM simulation (partial: Steps, Map, Source; no YAML/monaco)
1. Switch `WorkflowEditor.svelte` to `$state.raw()` with undo/redo ring buffer.
2. Embed `flow.wasm` into the dashboard bundle for sub-16ms client-side trace evaluation.
3. Implement `[Simple] [Canvas] [Code]` view switcher.

### Phase 4: Plugin Registry & Android Notification Bridge (not started; tables only)
1. Implement `@dakflare/plugin-sdk` and `index.min.json` Ed25519 verifier.
2. Build Android `NotificationBridgeService.kt` for native notification capture and reply intents.
