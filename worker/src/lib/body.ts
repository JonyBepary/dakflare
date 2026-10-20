/**
 * Bounded request-body reading (hardening S2).
 *
 * Why this exists: `await req.text()` / `await req.json()` will happily buffer
 * whatever the caller sends. Cloudflare does not bill subrequests you make, but
 * it does bill and quota your Worker invocations, your CPU, and every downstream
 * D1/DO unit that the parsed payload then touches — so an unbounded body is an
 * unbounded cost vector, and on Workers Free (10 ms CPU per invocation, 100k
 * requests/day) an unauthenticated 2 MiB body is a cheap way to burn both.
 *
 * Critically, the cap is enforced by **reading the stream**, not by inspecting
 * `Content-Length`. A `Transfer-Encoding: chunked` request simply omits that
 * header, so a header check is a bypass, not a guard.
 */

export type BoundedBody = { ok: true; text: string } | { ok: false };

/**
 * Read at most `maxBytes` of the request body.
 *
 * Returns `{ ok: false }` as soon as the limit is crossed, cancelling the stream
 * so the rest is never buffered. `GET`/`HEAD` and a missing body yield `""`.
 */
export async function readBodyBounded(req: Request, maxBytes: number): Promise<BoundedBody> {
  if (req.method === "GET" || req.method === "HEAD") return { ok: true, text: "" };

  const stream = req.body;
  if (!stream) return { ok: true, text: "" };

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    // A truncated or aborted upload is a bad request, not a 500.
    return { ok: false };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

/** Parse a bounded body as JSON, keeping the too-large and malformed cases distinct. */
export type JsonBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: "payload_too_large" | "bad_request" };

export async function readJsonBoundedResult(
  req: Request,
  maxBytes: number
): Promise<JsonBodyResult> {
  const body = await readBodyBounded(req, maxBytes);
  if (!body.ok) return { ok: false, reason: "payload_too_large" };
  if (body.text.trim() === "") return { ok: true, value: {} };
  try {
    const parsed: unknown = JSON.parse(body.text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "bad_request" };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, reason: "bad_request" };
  }
}
