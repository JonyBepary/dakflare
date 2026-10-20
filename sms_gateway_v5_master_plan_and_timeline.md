# SMS Gateway v5 — Master Plan, Backend-First Strategy & Execution Timeline (Rev B — Fully Self-Contained)

> **Status:** Locked (v5 Architecture + Backend-First B1–B6 Strategy + Review C1–C4 / M1–M5 Patched)
> **Start Date:** October 18, 2026
> **Core Principle:** Freeze and verify 100% of the Cloudflare Worker + Durable Object API contract against the Node.js Virtual Android Device and Hoppscotch **before** opening Android Studio (`B4 Freeze Gate`).

## 1. Executive Summary & Integration Risk Strategy

The entire integration risk in a custom Android-to-Cloudflare SMS gateway lives in three places:

1. **ECDSA Canonical String & Encoding Drift:** Any mismatch between Android's `SHA256withECDSA` (`ASN.1 DER` converted to 64-byte `IEEE P1363`) and the Worker's Web Crypto verifier causes silent `401/403` failures in production.
2. **Durable Object Hibernation Edge Cases:** Validating `setWebSocketAutoResponse`, the 8-second `ack_timeout` half-open socket recovery, first-45-second `connectedAt` fallback, and `evicted_max_ts` replay protection is nearly impossible to debug from a physical phone.
3. **Two-Phase ACK Ordering (`PENDING → DISPATCHED → ACKED_BY_DEVICE → SENT → DELIVERED`):** A physical phone sending multipart SMS over a cellular carrier is slow (5–15 seconds) and unobservable; if the client fails to ACK immediately upon Room DB persistence (before calling `SmsManager`), the 8-second `ack_timeout` will fire mid-send.

All three risks are validated deterministically in **Milestones B1–B4** using the zero-dependency Node.js Virtual Android Device (`sms_gateway_test_harness.mjs`) and Hoppscotch (`hoppscotch_sms_gateway_collection.json`). Once **B4** passes twice in a row against `wrangler dev --local` (plus a one-time `--remote` smoke check for WebSocket Hibernation), the API contract is frozen and Kotlin becomes a straightforward client implementation in **B5–B6**.

## 2. Milestone Roadmap & Schedule (B1–B6)

Two timeline tracks are provided below starting **October 18, 2026**: a **7-Day Focused Sprint** (~4–6 hrs/day) and a **14-Day Part-Time Track** (~2 hrs/day).

| Milestone | Target Window (7-Day Sprint) | Target Window (14-Day Part-Time) | Core Deliverables | Acceptance Gate (Must Pass to Advance) |
| :--- | :--- | :--- | :--- | :--- |
| **B1: Worker Scaffold, D1 & Pairing** | **Day 1** (Oct 18) | **Days 1–2** (Oct 18–19) | `wrangler.toml`, D1 schema (`messages`, `rules`, `devices`, `pairing_codes`), DO SQLite DDL in `blockConcurrencyWhile`, `/v1/admin/pairing-code`, `/v1/device/pair`. | `curl /v1/admin/pairing-code` returns a code; atomic D1 `DELETE ... RETURNING *` pairs device in both D1 & DO and rejects reuse/expiry with `401`. |
| **B2: ECDSA P1363 Auth & Replay Guard** | **Day 2** (Oct 19) | **Days 3–4** (Oct 20–21) | `withDevice` body-preserving middleware, Web Crypto ECDSA P-256 P1363 verifier, `transactionSync`-wrapped `device_meta` 32-nonce ring buffer + `evicted_max_ts` guard. | `node sms_gateway_test_harness.mjs selftest` and `pair` pass; parallel requests succeed; tampered body and replayed/evicted nonces return `401`. |
| **B3: Batch Sync, Poll, Status & AST Rules** | **Day 3** (Oct 20) | **Days 5–6** (Oct 22–23) | `/v1/sms/incoming/batch` (`ON CONFLICT DO NOTHING`), `/v1/sms/outgoing/poll`, `/v1/sms/status/batch`, `/v1/sms/send`, `/v1/rules` with pure-JS AST ReDoS + length linter. | Harness `suite` steps 1–10 pass; Hoppscotch collection `1.1 → 2.5` succeeds through the `:8788` signing proxy. |
| **B4: Hibernating WS, Alarms & FCM Push** | **Day 4** (Oct 21) | **Days 7–8** (Oct 24–25) | `setWebSocketAutoResponse` ping/pong, `serializeAttachment`, multiplexed `scheduled_tasks` alarm (`expire`, `offline_alert`, `ack_timeout`), FCM HTTP v1 OAuth2 client. **API Contract Freeze.** | Harness `ws` + full `suite` pass **twice consecutively** without state corruption; `wrangler d1 execute` confirms persisted rows. |
| **B5: Android Keystore, Pairing & Transport** | **Days 5–6** (Oct 22–23) | **Days 9–11** (Oct 26–28) | Android Keystore ECDSA P-256 keygen, Kotlin `derToP1363()`, QR/code pairing UI, `SignedHttpClient` (root-CA pinned), `remoteMessaging` ForegroundService + WS client. | Physical Android 14/15 phone pairs, connects over WSS, survives 6+ hours without FGS timeout, and restarts on `BOOT_COMPLETED`. |
| **B6: Android SMS Pipeline, Auto-Reply & FCM** | **Day 7** (Oct 24) | **Days 12–14** (Oct 29–31) | `SmsReceiver` (`goAsync` + PDU concat), `AutoReplyEngine` (`libphonenumber` E.164, mask/shortcode filter, `re2j`), Room queues, `SmsSender` multipart receipts, FCM downgrade guard, ADB provisioning. | Full carrier SIM test: airplane-mode recovery, Bangla UCS-2 multipart SMS, `bKash`/shortcode mask ignore, and >30 SMS/30m burst without system modal. |

## 3. Day-by-Day Execution Checklist

### Phase 1: Backend & Virtual Device Verification (Days 1–4)

* **Day 1 — Milestone B1 (Storage & Bootstrap Pairing):**
  * Initialize `worker/` with `wrangler.toml` bindings for `DEVICE` (SQLite Durable Object), `DB` (D1), and `KV` (FCM bearer token cache).
  * Apply D1 migrations (`migrations/0001_init.sql`) for `messages`, `rules`, `devices`, and `pairing_codes`.
  * Implement DO constructor schema initialization inside `this.ctx.blockConcurrencyWhile()` for `commands`, `scheduled_tasks`, `devices`, and `device_meta`.
  * Implement `POST /v1/admin/pairing-code`, `POST /v1/device/pair` (atomic D1 `DELETE FROM pairing_codes WHERE code = ? AND expires_at > ? RETURNING *` + D1 `devices` upsert + DO `/__pair`), and `GET /v1/devices`.
* **Day 2 — Milestone B2 (ECDSA P-256 P1363 & Concurrency-Safe Replay Protection):**
  * Implement `verifyDeviceSignature()` in `worker/src/auth/ecdsa.ts` and body-preserving `withDevice()` wrapper in `worker/src/index.ts`.
  * Implement `/__auth/verify` inside the Durable Object: read `public_key_spki` synchronously, run `await crypto.subtle.verify()` outside locks, then wrap the `device_meta` read → `evicted_max_ts` check → `recent_nonces` check → ring-buffer append → `UPDATE` inside `this.ctx.storage.transactionSync(() => { ... })`.
  * Verify against `node sms_gateway_test_harness.mjs selftest` and `node sms_gateway_test_harness.mjs pair`.
* **Day 3 — Milestone B3 (HTTP Batch Endpoints, Two-Phase HTTP ACK & AST Linter):**
  * Wire `handleSend`, `handleSendBatch`, `handleIncomingBatch`, `handlePoll`, `handleStatusBatch`, `handleRulesGet`, and `handleRulesPost`.
  * Use `ON CONFLICT(device_id, local_id) DO NOTHING` in `handleIncomingBatch` and validate `Date.parse(m.received_at)` against `NaN`.
  * Ensure `handleRulesPost` enforces length caps (`matcher_value <= 512`, `reply_template <= 1000`) and validates **both** sender regex (`matcher.value`) and body regex (`body_matcher.value`) with `lintRegex()`.
  * Ensure DO `/__status` and `/__http_ack` call `this.cancelAckTimeout(command_id)` (which deletes the task and reschedules/clears the DO alarm when a row is removed).
* **Day 4 — Milestone B4 (WebSocket Hibernation, Multiplexed Alarms & API Freeze):**
  * Forward WebSocket upgrades via `stub.fetch(new Request(url.toString(), req))` so hop-by-hop `Upgrade` headers stay intact.
  * Configure `this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"op":"ping"}', '{"op":"pong"}'))` in the DO constructor and `server.serializeAttachment({ deviceId, connectedAt: Date.now() })` on upgrade.
  * Implement multiplexed `alarm()` handler over `scheduled_tasks` (`expire`, `offline_alert` with `getWebSocketAutoResponseTimestamp ?? connectedAt` re-check, and 8-second `ack_timeout` → close socket + FCM HTTP v1 push).
  * Pass all **B4 Acceptance Gates** (including back-to-back `node sms_gateway_test_harness.mjs suite` runs and a one-time `wrangler dev --remote` hibernation check). **Freeze backend API.**

### Phase 2: Android Client Implementation (Days 5–7)

* **Days 5–6 — Milestone B5 (Android Crypto, Pairing & `remoteMessaging` FGS):**
  * Implement Android Keystore ECDSA P-256 key generation (`KeyGenParameterSpec` with `PURPOSE_SIGN`), signing via `Signature.getInstance("SHA256withECDSA")`, and `derToP1363()` conversion.
  * Build `SignedHttpClient` with OkHttp root-CA SPKI pinning (ISRG Root X1/X2, GTS Root R1/R4) and millisecond `X-Timestamp` headers.
  * Build `GatewayForegroundService` (`foregroundServiceType="remoteMessaging"`) + `BootReceiver` (`RECEIVE_BOOT_COMPLETED`) + WebSocket state machine (`hello`, 45s `ping`, two-phase `ack`).
* **Day 7 — Milestone B6 (SMS Pipeline, On-Device Auto-Reply & Provisioning):**
  * Implement `SmsReceiver` (`goAsync()` + multipart PDU concatenation) and Room `IncomingMessage` / `OutgoingMessage` queues.
  * Implement `AutoReplyEngine` with mandatory pre-filters (1: `libphonenumber` E.164 normalization; 2: drop alphanumeric masks like `bKash`, `NAGAD`, `GP`; 3: drop shortcodes < 10 digits unless `allow_shortcode_reply: true`; 4: self-number loop check via `READ_PHONE_NUMBERS`) and `com.google.re2j:re2j` matching.
  * Implement `SmsSender` (`SmsManager.createForSubscriptionId()`, `divideMessage()`, per-part `PendingIntent` counters) and `FCMService` (checking `isIgnoringBatteryOptimizations || priority == PRIORITY_HIGH` before starting FGS, falling back to expedited `WorkManager`).
  * Run ADB device provisioning (`sms_outgoing_check_max_count = 99999`) and complete carrier SIM verification.

## 4. Architecture & Frozen Protocol Summary (v5)

| Layer | Component | Specification |
| :--- | :--- | :--- |
| **Cloudflare Edge** | Worker + Durable Object (per device) | Hibernating WebSocket (`setWebSocketAutoResponse` for 45s `ping`/`pong`), DO SQLite (`commands`, `scheduled_tasks`, `devices`, `device_meta`), D1 (`messages`, `rules`, `devices`, `pairing_codes`), KV (`fcm_bearer_token`). |
| **Device Auth** | ECDSA P-256 (IEEE P1363) | Canonical string: `${method}\n${pathname}${search}\n${timestampMs}\n${nonceHex}\n${sha256Hex(body)}`. Signed on Android via `SHA256withECDSA` + `derToP1363()` (64 bytes). |
| **Replay Guard** | `device_meta` Single-Row Ring Buffer | Wrapped in `transactionSync()`: rejects `Math.abs(now - ts) > 300_000 ms`, `ts <= evicted_max_ts`, or `nonce IN recent_nonces` (max 32 entries). Updates `evicted_max_ts` when an unexpired nonce is evicted (1 SQLite row write/request). |
| **Command State Machine** | Two-Phase ACK (`8s ack_timeout`) | `PENDING → DISPATCHED → ACKED_BY_DEVICE → SENT → DELIVERED` (or `FAILED`/`EXPIRED`). Android must ACK immediately after Room insert **before** calling `SmsManager`. If un-ACKed after 8s, DO closes WS, reverts to `PENDING`, and sends high-priority FCM. |
| **Android Background** | `remoteMessaging` FGS + FCM v1 | Exempt from Android 15's 6-hour `dataSync` timeout and allowed from `BOOT_COMPLETED`. Uses timed 30s wake locks (`wakeLock.acquire(30_000L)`). |

## 5. Complete Self-Contained Backend Code (`worker/`)

Every file required to run `wrangler dev --local` and pass the B4 conformance suite is included verbatim below.

### 5.1 `worker/wrangler.toml` & `worker/migrations/0001_init.sql`

```toml
# worker/wrangler.toml
name = "sms-gateway-worker"
main = "src/index.ts"
compatibility_date = "2026-04-07"

[[durable_objects.bindings]]
name = "DEVICE"
class_name = "DeviceGateway"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DeviceGateway"]

[[d1_databases]]
binding = "DB"
database_name = "sms_gateway"
database_id = "00000000-0000-0000-0000-000000000000"

[[kv_namespaces]]
binding = "KV"
id = "00000000000000000000000000000000"

[vars]
ADMIN_TOKEN = "dev-admin-token"
```

```sql
-- worker/migrations/0001_init.sql
CREATE TABLE IF NOT EXISTS pairing_codes (
  code       TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_codes(expires_at);

CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  fcm_token  TEXT,
  paired_at  INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  local_id    TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  peer        TEXT NOT NULL,
  body        TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  auto_reply  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(device_id, local_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id, received_at DESC);

CREATE TABLE IF NOT EXISTS rules (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  priority        INTEGER NOT NULL DEFAULT 0,
  matcher_type    TEXT NOT NULL,
  matcher_value   TEXT NOT NULL,
  body_type       TEXT NOT NULL,
  body_value      TEXT NOT NULL,
  reply_template  TEXT NOT NULL,
  cooldown_s      INTEGER NOT NULL DEFAULT 60,
  max_per_hour    INTEGER NOT NULL DEFAULT 10,
  sim_slot        INTEGER NOT NULL DEFAULT 0,
  allow_shortcode INTEGER NOT NULL DEFAULT 0,
  updated_at      INTEGER NOT NULL
);
```

### 5.2 `worker/src/index.ts` (Router & Middleware)

```typescript
import { DeviceGateway } from "./durable-object";
import { verifyDeviceSignature } from "./auth/ecdsa";
import { handleAdminPairingCode, handleDevicePair, handleDevicesList } from "./routes/pair";
import { handleSend, handleSendBatch } from "./routes/send";
import { handleWs } from "./routes/ws";
import { handleIncomingBatch } from "./routes/incoming";
import { handlePoll } from "./routes/poll";
import { handleStatusBatch } from "./routes/status";
import { handleRulesGet, handleRulesPost } from "./routes/rules";

export { DeviceGateway };

export interface Env {
  DEVICE: DurableObjectNamespace<DeviceGateway>;
  DB: D1Database;
  KV: KVNamespace;
  ADMIN_TOKEN: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}

function withAdmin(req: Request, env: Env, fn: () => Promise<Response>): Promise<Response> {
  const auth = req.headers.get("Authorization") ?? "";
  if (!env.ADMIN_TOKEN || auth !== `Bearer ${env.ADMIN_TOKEN}`) {
    return Promise.resolve(new Response("unauthorized", { status: 401 }));
  }
  return fn();
}

async function withDevice(
  req: Request,
  env: Env,
  fn: (req: Request, env: Env, deviceId: string, body: string) => Promise<Response>
): Promise<Response> {
  const verify = await verifyDeviceSignature(req, env);
  if (!verify.ok) return new Response(verify.reason, { status: 401 });
  return fn(req, env, verify.deviceId, verify.body);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    // 1. Public bootstrap pairing route (authenticated by single-use pairing_code)
    if (req.method === "POST" && pathname === "/v1/device/pair") {
      return handleDevicePair(req, env);
    }

    // 2. Admin routes
    if (req.method === "POST" && pathname === "/v1/admin/pairing-code") {
      return withAdmin(req, env, () => handleAdminPairingCode(req, env));
    }
    if (req.method === "GET" && pathname === "/v1/devices") {
      return withAdmin(req, env, () => handleDevicesList(env));
    }
    if (req.method === "POST" && pathname === "/v1/rules") {
      return withAdmin(req, env, () => handleRulesPost(req, env));
    }
    if (req.method === "POST" && pathname === "/v1/sms/send") {
      return withAdmin(req, env, () => handleSend(req, env));
    }
    if (req.method === "POST" && pathname === "/v1/sms/send/batch") {
      return withAdmin(req, env, () => handleSendBatch(req, env));
    }
    const statusMatch = pathname.match(/^\/v1\/device\/([^/]+)\/status$/);
    if (req.method === "GET" && statusMatch) {
      return withAdmin(req, env, async () => {
        const stub = env.DEVICE.get(env.DEVICE.idFromName(statusMatch[1]));
        return stub.fetch("https://do/__device_status");
      });
    }

    // 3. ECDSA-authenticated device routes
    if (req.method === "GET" && pathname === "/v1/device/ws") {
      return withDevice(req, env, (r, e, devId) => handleWs(r, e, devId));
    }
    if (req.method === "POST" && pathname === "/v1/sms/incoming/batch") {
      return withDevice(req, env, (r, e, devId, body) => handleIncomingBatch(r, e, devId, body));
    }
    if (req.method === "POST" && pathname === "/v1/sms/outgoing/poll") {
      return withDevice(req, env, (r, e, devId, body) => handlePoll(r, e, devId, body));
    }
    if (req.method === "POST" && pathname === "/v1/sms/status/batch") {
      return withDevice(req, env, (r, e, devId, body) => handleStatusBatch(r, e, devId, body));
    }
    if (req.method === "GET" && pathname === "/v1/rules") {
      return withDevice(req, env, (r, e, devId) => handleRulesGet(r, e, devId));
    }

    return new Response("not found", { status: 404 });
  },
};
```

### 5.3 `worker/src/auth/ecdsa.ts`

```typescript
import { Env } from "../index";

export async function verifyDeviceSignature(
  req: Request,
  env: Env
): Promise<{ ok: true; deviceId: string; body: string } | { ok: false; reason: string }> {
  const deviceId = req.headers.get("X-Device-Id") ?? "";
  const tsStr = req.headers.get("X-Timestamp") ?? "";
  const nonce = req.headers.get("X-Nonce") ?? "";
  const sigB64 = req.headers.get("X-Signature") ?? "";

  if (!deviceId || !tsStr || !nonce || !sigB64) {
    return { ok: false, reason: "missing auth headers" };
  }

  const ts = Number(tsStr);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300_000) {
    return { ok: false, reason: "timestamp out of window" };
  }

  const body = ["GET", "HEAD"].includes(req.method) ? "" : await req.text();
  const bodyDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const bodyHex = [...new Uint8Array(bodyDigest)].map((b) => b.toString(16).padStart(2, "0")).join("");

  const url = new URL(req.url);
  const canonical = `${req.method.toUpperCase()}\n${url.pathname}${url.search}\n${tsStr}\n${nonce}\n${bodyHex}`;

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const res = await stub.fetch("https://do/__auth/verify", {
    method: "POST",
    body: JSON.stringify({ deviceId, ts, nonce, canonical, sigB64 }),
  });

  if (res.status !== 200) {
    return { ok: false, reason: await res.text() };
  }
  return { ok: true, deviceId, body };
}
```

### 5.4 `worker/src/routes/pair.ts`, `send.ts`, `ws.ts`, `incoming.ts`, `poll.ts`, `status.ts`, `rules.ts`

```typescript
// worker/src/routes/pair.ts
import { Env } from "../index";

export async function handleAdminPairingCode(req: Request, env: Env): Promise<Response> {
  let ttlMs = 600_000; // default 10 minutes
  try {
    const body = (await req.json()) as any;
    if (typeof body?.ttl_ms === "number") ttlMs = body.ttl_ms;
  } catch {
    // empty body ok
  }
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const pairing_code = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  const expires_at = Date.now() + ttlMs;

  await env.DB.prepare(`INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)`).bind(pairing_code, expires_at).run();
  return Response.json({ pairing_code, expires_at });
}

export async function handleDevicePair(req: Request, env: Env): Promise<Response> {
  const { pairing_code, device_id, public_key_spki, fcm_token = null } = (await req.json()) as any;
  if (!pairing_code || !device_id || !public_key_spki) {
    return new Response("pairing_code, device_id, public_key_spki required", { status: 400 });
  }

  const now = Date.now();
  // Atomic single-use D1 consume
  const consumed = await env.DB.prepare(
    `DELETE FROM pairing_codes WHERE code = ? AND expires_at > ? RETURNING code`
  )
    .bind(pairing_code, now)
    .first();

  if (!consumed) {
    return new Response("invalid or expired pairing code", { status: 401 });
  }

  // Persist to D1 device registry (for admin fleet visibility)
  await env.DB.prepare(
    `INSERT INTO devices (device_id, public_key, fcm_token, paired_at, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       public_key = excluded.public_key,
       fcm_token  = excluded.fcm_token,
       last_seen  = excluded.last_seen`
  )
    .bind(device_id, public_key_spki, fcm_token, now, now)
    .run();

  // Persist to per-device Durable Object SQLite (for fast local ECDSA verify & FCM wake)
  const stub = env.DEVICE.get(env.DEVICE.idFromName(device_id));
  await stub.fetch("https://do/__pair", {
    method: "POST",
    body: JSON.stringify({ device_id, public_key_spki, fcm_token }),
  });

  return Response.json({ ok: true });
}

export async function handleDevicesList(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT device_id, fcm_token, paired_at, last_seen FROM devices ORDER BY last_seen DESC`
  ).all();
  return Response.json({ devices: rows.results });
}

// worker/src/routes/send.ts
export async function handleSend(req: Request, env: Env): Promise<Response> {
  const { device_id, to, body, priority = "normal", expires_in_s = 600 } = (await req.json()) as any;
  if (!device_id || !to || !body) {
    return new Response("device_id, to, body required", { status: 400 });
  }

  const command_id = crypto.randomUUID();
  const stub = env.DEVICE.get(env.DEVICE.idFromName(device_id));
  await stub.fetch("https://do/__enqueue", {
    method: "POST",
    body: JSON.stringify({
      command_id,
      to,
      body,
      priority,
      expires_at: Date.now() + expires_in_s * 1000,
    }),
  });
  return Response.json({ command_id });
}

export async function handleSendBatch(req: Request, env: Env): Promise<Response> {
  const { device_id, commands } = (await req.json()) as any;
  if (!device_id || !Array.isArray(commands)) {
    return new Response("device_id, commands[] required", { status: 400 });
  }

  const stub = env.DEVICE.get(env.DEVICE.idFromName(device_id));
  const ids: string[] = [];
  for (const c of commands) {
    const command_id = crypto.randomUUID();
    ids.push(command_id);
    await stub.fetch("https://do/__enqueue", {
      method: "POST",
      body: JSON.stringify({
        command_id,
        to: c.to,
        body: c.body,
        priority: c.priority ?? "normal",
        expires_at: Date.now() + (c.expires_in_s ?? 600) * 1000,
      }),
    });
  }
  return Response.json({ command_ids: ids });
}

// worker/src/routes/ws.ts (C4 fix: preserve WebSocket Upgrade request via new Request)
export async function handleWs(req: Request, env: Env, deviceId: string): Promise<Response> {
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const url = new URL(req.url);
  url.searchParams.set("device_id", deviceId);
  return stub.fetch(new Request(url.toString(), req));
}

// worker/src/routes/incoming.ts (M3 + Minor fix: ON CONFLICT DO NOTHING + Date.parse check)
export async function handleIncomingBatch(
  _req: Request,
  env: Env,
  deviceId: string,
  rawBody: string
): Promise<Response> {
  const data = JSON.parse(rawBody || "{}");
  const { messages = [], ack_command_ids = [], fcm_token } = data;

  const stmt = env.DB.prepare(
    `INSERT INTO messages
       (id, device_id, local_id, direction, peer, body, received_at, auto_reply)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(device_id, local_id) DO NOTHING`
  );

  let accepted = 0;
  let duplicates = 0;
  for (const m of messages) {
    const receivedTs = Date.parse(m.received_at);
    if (Number.isNaN(receivedTs)) {
      return new Response(`invalid received_at on local_id=${m.local_id}`, { status: 400 });
    }
    const r = await stmt
      .bind(
        crypto.randomUUID(),
        deviceId,
        m.local_id,
        "in",
        m.sender_e164 || m.sender,
        m.body,
        receivedTs,
        m.auto_reply_sent ? 1 : 0
      )
      .run();
    if (r.meta.changes > 0) accepted++;
    else duplicates++;
  }

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  if (ack_command_ids.length || fcm_token) {
    await stub.fetch("https://do/__http_ack", {
      method: "POST",
      headers: { "X-Device-Id": deviceId },
      body: JSON.stringify({ ack_command_ids, fcm_token }),
    });
  }

  const commands = await stub.fetch("https://do/__pending").then((r) => r.json());
  return Response.json({ accepted, duplicates, commands });
}

// worker/src/routes/poll.ts
export async function handlePoll(
  _req: Request,
  env: Env,
  deviceId: string,
  rawBody: string
): Promise<Response> {
  const { ack_command_ids = [], fcm_token } = JSON.parse(rawBody || "{}");
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));

  if (ack_command_ids.length || fcm_token) {
    await stub.fetch("https://do/__http_ack", {
      method: "POST",
      headers: { "X-Device-Id": deviceId },
      body: JSON.stringify({ ack_command_ids, fcm_token }),
    });
  }

  const commands = await stub.fetch("https://do/__pending").then((r) => r.json());
  return Response.json({ commands });
}

// worker/src/routes/status.ts
export async function handleStatusBatch(
  _req: Request,
  env: Env,
  deviceId: string,
  rawBody: string
): Promise<Response> {
  const { updates = [] } = JSON.parse(rawBody || "{}");
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const valid = ["SENT", "DELIVERED", "FAILED", "EXPIRED", "ACKED_BY_DEVICE"];
  let applied = 0;

  for (const u of updates) {
    if (!valid.includes(u.status)) continue;
    await stub.fetch("https://do/__status", {
      method: "POST",
      body: JSON.stringify({ command_id: u.command_id, status: u.status }),
    });
    applied++;
  }
  return Response.json({ applied });
}

// worker/src/routes/rules.ts (Includes length bounds + dual matcher/body ReDoS AST lint)
export async function handleRulesGet(_req: Request, env: Env, _deviceId: string): Promise<Response> {
  const rows = await env.DB.prepare(`SELECT * FROM rules WHERE enabled=1 ORDER BY priority DESC`).all();
  return Response.json({ rules: rows.results });
}

export async function handleRulesPost(req: Request, env: Env): Promise<Response> {
  const r = (await req.json()) as any;
  const matcherType = r.matcher?.type ?? r.matcher_type;
  const matcherValue = String(r.matcher?.value ?? r.matcher_value ?? "");
  const bodyType = r.body_matcher?.type ?? r.body_type;
  const bodyValue = String(r.body_matcher?.value ?? r.body_value ?? "");
  const replyTemplate = String(r.reply_template ?? "");

  const allowedMatcherTypes = ["exact", "prefix", "suffix", "glob", "regex"];
  const allowedBodyTypes = ["keyword", "regex"];
  if (!allowedMatcherTypes.includes(matcherType) || !allowedBodyTypes.includes(bodyType)) {
    return new Response("invalid matcher_type or body_type", { status: 400 });
  }
  if (matcherValue.length > 512 || bodyValue.length > 512 || replyTemplate.length > 1000) {
    return new Response("rule pattern or template exceeds length limit", { status: 400 });
  }

  if (matcherType === "regex") {
    const err = lintRegex(matcherValue);
    if (err) return new Response(`matcher regex rejected: ${err}`, { status: 400 });
  }
  if (bodyType === "regex") {
    const err = lintRegex(bodyValue);
    if (err) return new Response(`body regex rejected: ${err}`, { status: 400 });
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO rules
       (id, name, enabled, priority, matcher_type, matcher_value,
        body_type, body_value, reply_template, cooldown_s, max_per_hour,
        sim_slot, allow_shortcode, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      r.id,
      r.name,
      r.enabled ? 1 : 0,
      r.priority ?? 0,
      matcherType,
      matcherValue,
      bodyType,
      bodyValue,
      replyTemplate,
      r.cooldown_seconds ?? r.cooldown_s ?? 60,
      r.max_replies_per_hour ?? r.max_per_hour ?? 10,
      r.sim_slot ?? 0,
      r.allow_shortcode_reply || r.allow_shortcode ? 1 : 0,
      Date.now()
    )
    .run();
  return Response.json({ ok: true });
}

function lintRegex(p: string | null | undefined): string | null {
  if (!p) return null;
  if (/\\[1-9]/.test(p)) return "backreference";
  if (/\(\?<[=!]/.test(p)) return "lookbehind";
  if (/\([^()]*[*+][^()]*\)[*+{]/.test(p)) return "nested_quantifier";
  return null;
}
```

### 5.5 Complete `worker/src/durable-object.ts` (Includes C1, C3 `transactionSync`, & M4 Alarm Reschedule)

```typescript
import { DurableObject } from "cloudflare:workers";
import { Env } from "./index";

interface NonceEntry {
  n: string;
  ts: number;
  exp: number;
}

interface WsAttachment {
  deviceId: string;
  connectedAt: number;
}

const OFFLINE_ALERT_MS = 15 * 60 * 1000; // 15 minutes

export class DeviceGateway extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          device_id       TEXT PRIMARY KEY,
          public_key_spki TEXT NOT NULL,
          fcm_token       TEXT,
          updated_at      INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS device_meta (
          id             INTEGER PRIMARY KEY CHECK (id = 1),
          recent_nonces  TEXT NOT NULL,
          evicted_max_ts INTEGER NOT NULL DEFAULT 0,
          updated_at     INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO device_meta (id, recent_nonces, evicted_max_ts, updated_at)
        VALUES (1, '[]', 0, 0);

        CREATE TABLE IF NOT EXISTS commands (
          command_id TEXT PRIMARY KEY,
          to_e164    TEXT NOT NULL,
          body       TEXT NOT NULL,
          priority   TEXT NOT NULL DEFAULT 'normal',
          state      TEXT NOT NULL DEFAULT 'PENDING',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_commands_state ON commands(state, priority, created_at);

        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id      TEXT PRIMARY KEY,
          run_at  INTEGER NOT NULL,
          kind    TEXT NOT NULL,
          payload TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_run_at ON scheduled_tasks(run_at);
      `);

      // Hibernation-safe edge ping/pong auto-response
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('{"op":"ping"}', '{"op":"pong"}')
      );
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // 1. WebSocket Upgrade (/v1/device/ws)
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const deviceId = url.searchParams.get("device_id") ?? req.headers.get("X-Device-Id") ?? "";
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      const attachment: WsAttachment = { deviceId, connectedAt: Date.now() };
      server.serializeAttachment(attachment);

      this.scheduleTask("offline_alert", Date.now() + OFFLINE_ALERT_MS, "offline_alert", "{}");
      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. Bootstrap Pairing (/v1/device/pair -> /__pair)
    if (url.pathname === "/__pair") {
      const { device_id, public_key_spki, fcm_token } = (await req.json()) as any;
      this.ctx.storage.sql.exec(
        `INSERT INTO devices (device_id, public_key_spki, fcm_token, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           public_key_spki = excluded.public_key_spki,
           fcm_token       = excluded.fcm_token,
           updated_at      = excluded.updated_at`,
        device_id,
        public_key_spki,
        fcm_token ?? null,
        Date.now()
      );
      return new Response("ok");
    }

    // 3. ECDSA P1363 + transactionSync Nonce Ring-Buffer Verification (/__auth/verify)
    if (url.pathname === "/__auth/verify") {
      const { deviceId, ts, nonce, canonical, sigB64 } = (await req.json()) as any;
      return this.verifyAndConsume(deviceId, ts, nonce, canonical, sigB64);
    }

    // 4. Enqueue Outgoing Command (/v1/sms/send -> /__enqueue)
    if (url.pathname === "/__enqueue") {
      const { command_id, to, body, priority = "normal", expires_at } = (await req.json()) as any;
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO commands (command_id, to_e164, body, priority, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
        command_id,
        to,
        body,
        priority,
        now,
        expires_at
      );
      this.scheduleTask(`exp:${command_id}`, expires_at, "expire", JSON.stringify({ command_id }));

      // Check if an active, non-stale WebSocket is attached
      const pushed = this.tryPushOverWebSocket();
      if (!pushed) {
        await this.sendFcmHighPriorityWake();
      }
      return new Response("ok");
    }

    // 5. HTTP ACK + FCM Token Sync (/__http_ack)
    if (url.pathname === "/__http_ack") {
      const { ack_command_ids = [], fcm_token } = (await req.json()) as any;
      for (const id of ack_command_ids) {
        this.cancelAckTimeout(id);
        this.ctx.storage.sql.exec(
          `UPDATE commands SET state='ACKED_BY_DEVICE' WHERE command_id=?`,
          id
        );
      }
      if (fcm_token) {
        const deviceId = req.headers.get("X-Device-Id") ?? "";
        this.ctx.storage.sql.exec(
          `UPDATE devices SET fcm_token=?, updated_at=? WHERE device_id=?`,
          fcm_token,
          Date.now(),
          deviceId
        );
      }
      return new Response("ok");
    }

    // 6. Pull Pending Commands over HTTP Poll / Piggyback (/__pending)
    if (url.pathname === "/__pending") {
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT command_id, to_e164, body, priority, expires_at
           FROM commands WHERE state='PENDING'
           ORDER BY CASE priority
             WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at`
        )
        .toArray();

      const cmds = rows.map((r: any) => ({
        command_id: r.command_id,
        to: r.to_e164,
        body: r.body,
        priority: r.priority,
        expires_at: r.expires_at,
      }));

      for (const c of cmds) {
        this.ctx.storage.sql.exec(
          `UPDATE commands SET state='DISPATCHED' WHERE command_id=?`,
          c.command_id
        );
        this.scheduleTask(
          `ack:${c.command_id}`,
          Date.now() + 8000,
          "ack_timeout",
          JSON.stringify({ command_id: c.command_id })
        );
      }
      return Response.json(cmds);
    }

    // 7. Status Update Batch (/__status)
    if (url.pathname === "/__status") {
      const { command_id, status } = (await req.json()) as any;
      if (["ACKED_BY_DEVICE", "SENT", "DELIVERED", "FAILED", "EXPIRED"].includes(status)) {
        this.cancelAckTimeout(command_id);
      }
      this.ctx.storage.sql.exec(
        `UPDATE commands SET state=? WHERE command_id=?`,
        status,
        command_id
      );
      return new Response("ok");
    }

    // 8. Device Status Inspection (/__device_status)
    if (url.pathname === "/__device_status") {
      const sockets = this.ctx.getWebSockets();
      const qRow = this.ctx.storage.sql
        .exec(`SELECT COUNT(*) AS cnt FROM commands WHERE state IN ('PENDING', 'DISPATCHED')`)
        .toArray()[0] as any;
      return Response.json({
        ws_connected: sockets.length > 0,
        queue_depth: qRow?.cnt ?? 0,
      });
    }

    return new Response("not found", { status: 404 });
  }

  /**
   * C3 Fix: Runs slow Web Crypto verification outside locks, then performs the
   * device_meta read -> check -> append -> write atomically inside transactionSync().
   */
  private async verifyAndConsume(
    deviceId: string,
    ts: number,
    nonce: string,
    canonical: string,
    sigB64: string
  ): Promise<Response> {
    const devRows = this.ctx.storage.sql
      .exec(`SELECT public_key_spki FROM devices WHERE device_id=?`, deviceId)
      .toArray();
    if (devRows.length === 0) {
      return new Response("unknown device", { status: 401 });
    }

    const spkiB64 = (devRows[0] as any).public_key_spki as string;
    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    if (sigBytes.byteLength !== 64) {
      return new Response("signature must be 64-byte P1363", { status: 401 });
    }

    const spkiBytes = Uint8Array.from(atob(spkiB64), (c) => c.charCodeAt(0));
    const pubKey = await crypto.subtle.importKey(
      "spki",
      spkiBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      pubKey,
      sigBytes,
      new TextEncoder().encode(canonical)
    );
    if (!valid) {
      return new Response("invalid signature", { status: 401 });
    }

    // Synchronous atomic read-modify-write of device_meta (zero await inside)
    const now = Date.now();
    const replayErr = this.ctx.storage.transactionSync(() => {
      const meta = this.ctx.storage.sql
        .exec(`SELECT recent_nonces, evicted_max_ts FROM device_meta WHERE id=1`)
        .toArray()[0] as any;

      let evictedMaxTs = Number(meta.evicted_max_ts ?? 0);
      if (ts <= evictedMaxTs) {
        return "timestamp older than evicted_max_ts floor";
      }

      const list: NonceEntry[] = JSON.parse(meta.recent_nonces || "[]");
      if (list.some((e) => e.n === nonce)) {
        return "nonce replay detected";
      }

      // Prune already-expired entries (> 300s old)
      const active = list.filter((e) => e.exp > now);
      active.push({ n: nonce, ts, exp: now + 300_000 });

      // Cap ring buffer at 32 entries; update evicted_max_ts if a still-live entry is evicted
      while (active.length > 32) {
        const evicted = active.shift()!;
        if (evicted.exp > now && evicted.ts > evictedMaxTs) {
          evictedMaxTs = evicted.ts;
        }
      }

      this.ctx.storage.sql.exec(
        `UPDATE device_meta SET recent_nonces=?, evicted_max_ts=?, updated_at=? WHERE id=1`,
        JSON.stringify(active),
        evictedMaxTs,
        now
      );
      return null;
    });

    if (replayErr) {
      return new Response(replayErr, { status: 401 });
    }
    return new Response("ok", { status: 200 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    const attachment = (ws.deserializeAttachment() || {}) as WsAttachment;

    if (msg.op === "hello") {
      if (msg.fcm_token && attachment.deviceId) {
        this.ctx.storage.sql.exec(
          `UPDATE devices SET fcm_token=?, updated_at=? WHERE device_id=?`,
          msg.fcm_token,
          Date.now(),
          attachment.deviceId
        );
      }
      this.tryPushOverWebSocket(ws);
      return;
    }

    if (msg.op === "ack" && Array.isArray(msg.command_ids)) {
      for (const id of msg.command_ids) {
        this.cancelAckTimeout(id);
        this.ctx.storage.sql.exec(
          `UPDATE commands SET state='ACKED_BY_DEVICE' WHERE command_id=?`,
          id
        );
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec(`SELECT id, kind, payload FROM scheduled_tasks WHERE run_at <= ? ORDER BY run_at ASC`, now)
      .toArray();

    for (const task of due as any[]) {
      this.ctx.storage.sql.exec(`DELETE FROM scheduled_tasks WHERE id=?`, task.id);
      const payload = JSON.parse(task.payload || "{}");

      if (task.kind === "expire") {
        this.ctx.storage.sql.exec(
          `UPDATE commands SET state='EXPIRED' WHERE command_id=? AND state IN ('PENDING', 'DISPATCHED')`,
          payload.command_id
        );
      } else if (task.kind === "ack_timeout") {
        const rows = this.ctx.storage.sql
          .exec(`SELECT state FROM commands WHERE command_id=?`, payload.command_id)
          .toArray();
        if (rows.length > 0 && (rows[0] as any).state === "DISPATCHED") {
          this.ctx.storage.sql.exec(
            `UPDATE commands SET state='PENDING' WHERE command_id=?`,
            payload.command_id
          );
          for (const ws of this.ctx.getWebSockets()) {
            try {
              ws.close(1011, "ack_timeout");
            } catch {}
          }
          await this.sendFcmHighPriorityWake();
        }
      } else if (task.kind === "offline_alert") {
        const ws = this.ctx.getWebSockets()[0];
        if (ws) {
          const att = (ws.deserializeAttachment() || {}) as WsAttachment;
          const autoTs = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
          const lastSeen = autoTs ?? att.connectedAt ?? 0;
          if (now - lastSeen < OFFLINE_ALERT_MS) {
            this.scheduleTask("offline_alert", lastSeen + OFFLINE_ALERT_MS, "offline_alert", "{}");
            continue;
          }
        }
        console.warn(`[offline_alert] Device silent for > ${OFFLINE_ALERT_MS} ms`);
      }
    }

    this.syncNextAlarm();
  }

  private tryPushOverWebSocket(targetWs?: WebSocket): boolean {
    const ws = targetWs ?? this.ctx.getWebSockets()[0];
    if (!ws) return false;

    const att = (ws.deserializeAttachment() || {}) as WsAttachment;
    const autoTs = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime();
    const lastSeen = autoTs ?? att.connectedAt ?? Date.now();
    if (Date.now() - lastSeen > 120_000) {
      try {
        ws.close(1001, "stale_connection");
      } catch {}
      return false;
    }

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT command_id, to_e164, body, priority, expires_at
         FROM commands WHERE state IN ('PENDING', 'DISPATCHED')
         ORDER BY CASE priority
           WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at`
      )
      .toArray();

    if (rows.length === 0) return true;

    const commands = rows.map((r: any) => ({
      command_id: r.command_id,
      to: r.to_e164,
      body: r.body,
      priority: r.priority,
      expires_at: r.expires_at,
    }));

    ws.send(JSON.stringify({ op: "commands", commands }));

    for (const c of commands) {
      this.ctx.storage.sql.exec(
        `UPDATE commands SET state='DISPATCHED' WHERE command_id=?`,
        c.command_id
      );
      this.scheduleTask(
        `ack:${c.command_id}`,
        Date.now() + 8000,
        "ack_timeout",
        JSON.stringify({ command_id: c.command_id })
      );
    }
    return true;
  }

  private scheduleTask(id: string, runAt: number, kind: string, payload: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO scheduled_tasks (id, run_at, kind, payload) VALUES (?, ?, ?, ?)`,
      id,
      runAt,
      kind,
      payload
    );
    this.syncNextAlarm();
  }

  private cancelAckTimeout(commandId: string): void {
    const cursor = this.ctx.storage.sql.exec(
      `DELETE FROM scheduled_tasks WHERE id=?`,
      `ack:${commandId}`
    );
    if (cursor.rowsWritten > 0) {
      this.syncNextAlarm();
    }
  }

  private syncNextAlarm(): void {
    const next = this.ctx.storage.sql
      .exec(`SELECT MIN(run_at) AS m FROM scheduled_tasks`)
      .toArray()[0] as any;
    if (next?.m) {
      this.ctx.storage.setAlarm(Number(next.m));
    } else {
      this.ctx.storage.deleteAlarm();
    }
  }

  private async sendFcmHighPriorityWake(): Promise<void> {
    if (!this.env.FCM_SERVICE_ACCOUNT_JSON) return;
    // Production FCM HTTP v1 OAuth2 wake push implementation hooks here
  }
}
```

### 5.6 Patched Conformance Test Excerpt (`sms_gateway_test_harness.mjs` — Fixes C2, C3, M1, & Minor)

```javascript
// 1. Expired pairing code negative test (Minor fix)
const expRes = await adminRequest("POST", "/v1/admin/pairing-code", { ttl_ms: -1000 });
const expiredTry = await fetch(`${WORKER_URL}/v1/device/pair`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    pairing_code: expRes.data.pairing_code,
    device_id: identity.device_id,
    public_key_spki: identity.public_key_spki,
    fcm_token: identity.fcm_token,
  }),
});
assert(expiredTry.status === 401, "Expired pairing code must return 401");

// 2. Concurrent request test (C3 fix — proves transactionSync prevents nonce clobbering)
const [conc1, conc2] = await Promise.all([
  deviceRequest(identity, "POST", "/v1/sms/outgoing/poll", { device_id: identity.device_id, ack_command_ids: [] }),
  deviceRequest(identity, "POST", "/v1/sms/outgoing/poll", { device_id: identity.device_id, ack_command_ids: [] }),
]);
assert(conc1.status === 200 && conc2.status === 200, "Concurrent signed requests must both succeed");

// 3. Two-Step Poll-Then-ACK (C2 fix — poll with ack_command_ids:[] first, then ACK in second call)
const poll1 = await deviceRequest(identity, "POST", "/v1/sms/outgoing/poll", {
  device_id: identity.device_id,
  ack_command_ids: [],
  fcm_token: identity.fcm_token,
});
assert(poll1.data.commands.some((c) => c.command_id === cmdId), "First poll must return PENDING command");

const poll2 = await deviceRequest(identity, "POST", "/v1/sms/outgoing/poll", {
  device_id: identity.device_id,
  ack_command_ids: [cmdId],
  fcm_token: identity.fcm_token,
});
assert(!poll2.data.commands.some((c) => c.command_id === cmdId), "ACKed command must not re-appear in second poll");

// 4. Positive control witness after 33-request evicted_max_ts burst (M1 fix)
const freshAfterBurst = await deviceRequest(identity, "POST", "/v1/sms/outgoing/poll", {
  device_id: identity.device_id,
  ack_command_ids: [],
});
assert(freshAfterBurst.status === 200, "Fresh request after eviction burst must succeed (no self-DoS)");
```

## 6. B4 API Contract Freeze & Verification Gate

Companion testing artifacts located in the project workspace:
* **Virtual Android Device & E2E Runner:** `sms_gateway_test_harness.mjs`
* **Hoppscotch REST Collection:** `hoppscotch_sms_gateway_collection.json`

Run the following terminal sequence to validate Milestones B1–B4 before starting Android development in Milestone B5:

```bash
# Terminal 1 — Start local Worker + D1 + SQLite Durable Object
cd worker
npm install
wrangler d1 migrations apply sms_gateway --local
wrangler dev --local

# Terminal 2 — Run Virtual Android Device Conformance Suite
export WORKER_URL=http://localhost:8787
export ADMIN_TOKEN=dev-admin-token
node sms_gateway_test_harness.mjs selftest
node sms_gateway_test_harness.mjs pair
node sms_gateway_test_harness.mjs suite
node sms_gateway_test_harness.mjs suite   # Must pass twice in a row!

# Terminal 3 — Interactive Hoppscotch Proxy & Live WebSocket Phone
node sms_gateway_test_harness.mjs proxy
node sms_gateway_test_harness.mjs ws
```

### Mandatory B4 Freeze Checklist
* [ ] `selftest` passes (verifies ECDSA P-256 P1363 64-byte signing and DER → P1363 conversion).
* [ ] `pair` passes (verifies D1 single-use pairing code creation, expiry rejection, reuse rejection, and D1 + DO registration).
* [ ] `suite` passes all 11 conformance checks (pairing code expiry `401`, reuse `401`, body tamper `401`, nonce replay `401`, parallel concurrency `200`, 33-request `evicted_max_ts` eviction replay `401` + fresh positive control `200`, ReDoS regex `400`, incoming dedup, and two-step poll → ACK → `DELIVERED`).
* [ ] Re-running `suite` a second time immediately passes with zero state corruption.
* [ ] `ws` logs `hello`, edge auto-response `pong`, immediate `ack`, and `DELIVERED` batch transitions (plus one-time `wrangler dev --remote` hibernation check).
* [ ] Hoppscotch requests `1.1 → 2.5` succeed against `http://localhost:8788` without manual signature editing.
