/**
 * WebSocket upgrade — PROTOCOL_CONTRACT_V5 Rev C §1.2 and master plan §5.4 (C4).
 *
 * §1.2: the upgrade is a signed request and therefore carries NO query string;
 * the device is identified by `X-Device-Id`, which `withDevice` has already
 * validated and verified. The `device_id` search param added below lives only on
 * the Worker -> Durable Object hop, which is not the wire protocol.
 *
 * C4: the request must be re-wrapped — `new Request(url, req)` — rather than
 * mutated, because a `Request`'s url is immutable and because the `Upgrade`
 * header and the socket handshake have to reach the Durable Object intact. The
 * authenticated GET has no body, so nothing has been consumed at this point.
 */

import type { Env } from "../index";

export async function handleWs(req: Request, env: Env, deviceId: string): Promise<Response> {
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const url = new URL(req.url);
  url.search = "";
  url.searchParams.set("device_id", deviceId);

  return stub.fetch(new Request(url.toString(), req));
}
