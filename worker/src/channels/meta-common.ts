/**
 * Shared primitives for the Meta platforms this Worker speaks directly:
 * WhatsApp Business Cloud, Facebook Messenger Platform, and Instagram Messaging.
 *
 * Everything here is zero-dependency: `crypto.subtle` for HMAC and the digest
 * used by the constant-time challenge compare, `fetch` for Graph API calls.
 *
 * Two rules this file exists to keep:
 *
 *  1. The signature is verified over the RAW BYTES Meta sent, before any JSON
 *     parse. Re-serialising `JSON.parse(body)` changes key order and whitespace,
 *     so the HMAC stops matching for every event but the canonical one. The
 *     caller reads `request.arrayBuffer()` exactly once and passes those bytes.
 *  2. A secret comparison never uses `!==`. The challenge compare and the
 *     Telegram secret-token compare hash both sides to equal-length digests and
 *     compare those in constant time, so a wrong token cannot be recovered a
 *     character at a time from response latency.
 */

/** Meta's standard messaging window; a reply must arrive inside it or use a tag. */
export const META_WINDOW_MS = 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const HMAC_KEYS = new Map<string, Promise<CryptoKey>>();

function getHmacKey(secret: string): Promise<CryptoKey> {
  let cached = HMAC_KEYS.get(secret);
  if (cached === undefined) {
    // A small bound: a bot rotate loop must not grow this map forever.
    if (HMAC_KEYS.size >= 64) HMAC_KEYS.clear();
    cached = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    HMAC_KEYS.set(secret, cached);
  }
  return cached;
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/**
 * Constant-time equality over two UTF-8 strings.
 *
 * Both sides are hashed first, which makes the compared buffers the same
 * length regardless of the inputs. Length then cannot leak through the loop
 * bound, and SHA-256 collisions are not a practical forgery path for a
 * webhook verify token.
 */
export async function constantTimeTokenEqual(a: string, b: string): Promise<boolean> {
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(digestA);
  const right = new Uint8Array(digestB);
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

/**
 * Verify `X-Hub-Signature-256: sha256=<hex>` over the raw request bytes.
 *
 * `crypto.subtle.verify` is the constant-time comparison; this function only
 * rejects shapes the platform cannot have produced (missing header, wrong
 * algorithm, non-hex, wrong digest length). It returns `false` rather than
 * throwing so a malformed signature is a 401, never a 500.
 */
export async function verifyMetaWebhookSignature(
  req: Request,
  rawBody: Uint8Array | ArrayBuffer | string,
  appSecret: string | undefined
): Promise<boolean> {
  const header = req.headers.get("X-Hub-Signature-256");
  if (appSecret === undefined || appSecret === "" || header === null) return false;
  if (!header.startsWith("sha256=")) return false;

  const hex = header.slice("sha256=".length).trim();
  if (hex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(hex)) return false;

  const signature = fromHex(hex);
  if (signature === null) return false;

  const data =
    typeof rawBody === "string"
      ? encoder.encode(rawBody)
      : rawBody instanceof Uint8Array
        ? rawBody
        : new Uint8Array(rawBody);

  const key = await getHmacKey(appSecret);
  return crypto.subtle.verify("HMAC", key, signature, data);
}

/**
 * Meta's one-time webhook subscription handshake (`hub.mode=subscribe`).
 *
 * Returning the challenge is the proof that this endpoint's owner knows the
 * verify token, so the comparison must not leak the token. The kit compared
 * with `!==` under a comment claiming constant time; this hashes both sides
 * and compares the digests with a fixed-length accumulator instead.
 */
export async function handleMetaChallenge(
  url: URL,
  expectedVerifyToken: string | undefined
): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (expectedVerifyToken === undefined || expectedVerifyToken === "") {
    return new Response("Forbidden", { status: 403 });
  }
  if (mode !== "subscribe" || token === null || challenge === null) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!(await constantTimeTokenEqual(token, expectedVerifyToken))) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** The status values Meta reports for an outbound message. */
export type MetaDeliveryStatus = "sent" | "delivered" | "read" | "failed";

export interface MetaStatusUpdate {
  channel: "whatsapp" | "messenger" | "instagram";
  channelMessageId: string;
  peerId: string;
  status: MetaDeliveryStatus;
  timestamp: number;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Map a platform status onto the `messages.reply_state` vocabulary.
 *
 * `messages.reply_state` is written by the existing delivery path as
 * `queued | sent | delivered | failed`; `read` is a Meta-only receipt and a
 * CHECK in the schema rejects it. A read receipt necessarily means delivered,
 * so it lands as `delivered` rather than inventing a state the rest of the
 * product would have to learn.
 */
export function toReplyState(status: MetaDeliveryStatus): "sent" | "delivered" | "failed" {
  switch (status) {
    case "sent":
      return "sent";
    case "failed":
      return "failed";
    case "delivered":
    case "read":
      return "delivered";
  }
}

