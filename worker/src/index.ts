/**
 * SMS Gateway v5 — Worker entry point.
 * Implements PROTOCOL_CONTRACT_V5 Rev C §1 (transport), §3.2 (validation order),
 * §6 (command state machine surface) and §8 (error envelope), and ports
 * master plan §5.2 with brief fixes #2, #19 and #20.
 *
 * Auth surfaces:
 *   - public:  POST /v1/device/pair              (single-use pairing code)
 *   - admin:   Authorization: Bearer <ADMIN_TOKEN>, constant-time compared
 *   - device:  ECDSA P-256 signature over the §2 canonical string
 */

import { DeviceGateway } from "./durable-object";
import { verifyDeviceSignature } from "./auth/ecdsa";
import { handleAdminPairingCode, handleDevicePair, handleDevicesList } from "./routes/pair";
import { handleSend, handleSendBatch } from "./routes/send";
import { handleWs } from "./routes/ws";
import { handleIncomingBatch, handleMessagesList } from "./routes/incoming";
import { handlePoll } from "./routes/poll";
import { handleCommandStatus, handleStatusBatch } from "./routes/status";
import { handleRulesGet, handleRulesPost } from "./routes/rules";

export { DeviceGateway };

export interface Env {
  DEVICE: DurableObjectNamespace<DeviceGateway>;
  DB: D1Database;
  /** Load-bearing: lib/fcm.ts caches the FCM HTTP v1 bearer token here. */
  KV: KVNamespace;
  /**
   * Admin bearer token. Comes from `.dev.vars` locally or `wrangler secret put`
   * remotely; it is deliberately NOT in `[vars]`. When unset, `withAdmin` fails
   * closed with 401 (see the comment there).
   */
  ADMIN_TOKEN?: string;
  /** FCM HTTP v1 service-account JSON. Absent is a normal local-dev state. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  /** Redirectable so the harness can point FCM at a local stub. */
  FCM_BASE_URL: string;
  GOOGLE_TOKEN_URL: string;
  /** Optional timing overrides, clamped in lib/config.ts. */
  ACK_TIMEOUT_MS?: string;
  OFFLINE_ALERT_MS?: string;
  STALE_SOCKET_MS?: string;
  NONCE_WINDOW_MS?: string;
}

type DeviceHandler = (
  req: Request,
  env: Env,
  deviceId: string,
  body: string
) => Promise<Response>;

/**
 * Admin authentication — brief #20.
 *
 * The token is compared in constant time: both sides are hashed to SHA-256 first
 * (which fixes the length, so no length leak) and the digests are compared with a
 * single accumulating XOR loop rather than `===`, which short-circuits on the
 * first differing byte.
 *
 * Fail closed: if `ADMIN_TOKEN` is unset, every admin route answers 401. In local
 * dev without a non-dev token that means `wrangler dev` alone is not enough —
 * create `worker/.dev.vars` (see `.dev.vars.example`) or set the token with
 * `wrangler secret put ADMIN_TOKEN`.
 *
 * Note: §8 defines the code set for the DEVICE protocol only, so an admin auth
 * failure uses its own body and keeps `err()` strictly within §8.
 */
async function withAdmin(
  req: Request,
  env: Env,
  handler: () => Promise<Response>
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return unauthorized();

  const header = req.headers.get("Authorization") ?? "";
  const providedDigest = await sha256(header);
  const expectedDigest = await sha256(`Bearer ${expected}`);
  if (!timingSafeEqual(providedDigest, expectedDigest)) return unauthorized();

  return handler();
}

/** `withDevice` — §3.2 runs entirely inside `verifyDeviceSignature`. */
async function withDevice(req: Request, env: Env, handler: DeviceHandler): Promise<Response> {
  const result = await verifyDeviceSignature(req, env);
  if (!result.ok) return result.response;
  return handler(req, env, result.deviceId, result.body);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    /* ---- public bootstrapping ----------------------------------------- */
    if (method === "POST" && pathname === "/v1/device/pair") {
      return handleDevicePair(req, env);
    }

    /* ---- admin -------------------------------------------------------- */
    if (method === "POST" && pathname === "/v1/admin/pairing-code") {
      return withAdmin(req, env, () => handleAdminPairingCode(req, env));
    }
    if (method === "GET" && pathname === "/v1/devices") {
      return withAdmin(req, env, () => handleDevicesList(env));
    }
    if (method === "GET" && pathname === "/v1/messages") {
      return withAdmin(req, env, () => handleMessagesList(env, url));
    }
    if (method === "POST" && pathname === "/v1/rules") {
      return withAdmin(req, env, () => handleRulesPost(req, env));
    }
    if (method === "POST" && pathname === "/v1/sms/send") {
      return withAdmin(req, env, () => handleSend(req, env));
    }
    if (method === "POST" && pathname === "/v1/sms/send/batch") {
      return withAdmin(req, env, () => handleSendBatch(req, env));
    }

    const commandMatch = pathname.match(/^\/v1\/sms\/commands\/([^/]+)$/);
    if (method === "GET" && commandMatch) {
      const commandId = decodeURIComponent(commandMatch[1]);
      return withAdmin(req, env, () =>
        handleCommandStatus(env, url.searchParams.get("device_id") ?? "", commandId)
      );
    }

    const deviceStatusMatch = pathname.match(/^\/v1\/device\/([^/]+)\/status$/);
    if (method === "GET" && deviceStatusMatch) {
      const target = deviceStatusMatch[1];
      return withAdmin(req, env, async () => {
        const stub = env.DEVICE.get(env.DEVICE.idFromName(target));
        return stub.fetch("https://do/__device_status", { method: "GET" });
      });
    }

    /* ---- ECDSA-authenticated device routes ----------------------------- */
    if (method === "GET" && pathname === "/v1/device/ws") {
      return withDevice(req, env, (r, e, deviceId) => handleWs(r, e, deviceId));
    }
    if (method === "POST" && pathname === "/v1/sms/incoming/batch") {
      return withDevice(req, env, (r, e, deviceId, body) =>
        handleIncomingBatch(r, e, deviceId, body)
      );
    }
    if (method === "POST" && pathname === "/v1/sms/outgoing/poll") {
      return withDevice(req, env, (r, e, deviceId, body) => handlePoll(r, e, deviceId, body));
    }
    if (method === "POST" && pathname === "/v1/sms/status/batch") {
      return withDevice(req, env, (r, e, deviceId, body) => handleStatusBatch(r, e, deviceId, body));
    }
    if (method === "GET" && pathname === "/v1/rules") {
      return withDevice(req, env, (r, e, deviceId) => handleRulesGet(r, e, deviceId));
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Constant-time equality over two fixed-length digests. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
