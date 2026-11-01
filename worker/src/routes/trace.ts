/**
 * Provenance routes — `trace`, the dead-letter queue, and socket inspection.
 *
 * All three are read-only and all three reach into the device's Durable Object,
 * which is the only place the queue, the timers and the sockets exist. The Worker
 * contributes authentication and the D1 half; nothing is cached, because a cached
 * trace is a story about a moment that has already passed.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";
import { traceMessage } from "../lib/reply-fate-trace";
import { RE_DEVICE_ID } from "../auth/canonical";

/** `GET /v1/admin/trace/:id[?device_id=]` */
export async function handleTrace(env: Env, rawId: string, url: URL): Promise<Response> {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return err("bad_request", 400);
  }
  if (id === "" || id.length > 128) return err("bad_request", 400);

  const rawDevice = url.searchParams.get("device_id");
  if (rawDevice !== null && rawDevice !== "" && !RE_DEVICE_ID.test(rawDevice)) {
    return err("bad_request", 400);
  }

  const trace = await traceMessage(env, {
    id,
    ...(rawDevice === null || rawDevice === "" ? {} : { deviceId: rawDevice }),
  });
  return Response.json(trace);
}

/** `GET /v1/admin/dlq?device_id=…[&limit=]` */
export async function handleDlq(env: Env, url: URL): Promise<Response> {
  const deviceId = url.searchParams.get("device_id") ?? "";
  if (deviceId === "" || !RE_DEVICE_ID.test(deviceId)) return err("bad_request", 400);
  const limit = clampLimit(url.searchParams.get("limit"), 50);

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  try {
    const response = await stub.fetch(`https://do/__dlq?limit=${limit}`, { method: "GET" });
    if (!response.ok) return err("storage_unavailable", 503);
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({ device_id: deviceId, ...body });
  } catch (error) {
    console.error(`[dlq] object unreachable for ${deviceId}: ${String(error)}`);
    return err("storage_unavailable", 503);
  }
}

/** `GET /v1/admin/ws?device_id=…` */
export async function handleWsInspect(env: Env, url: URL): Promise<Response> {
  const deviceId = url.searchParams.get("device_id") ?? "";
  if (deviceId === "" || !RE_DEVICE_ID.test(deviceId)) return err("bad_request", 400);

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  try {
    const response = await stub.fetch("https://do/__ws", { method: "GET" });
    if (!response.ok) return err("storage_unavailable", 503);
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({ device_id: deviceId, ...body });
  } catch (error) {
    console.error(`[ws] object unreachable for ${deviceId}: ${String(error)}`);
    return err("storage_unavailable", 503);
  }
}

function clampLimit(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(200, Math.max(1, Math.trunc(parsed)));
}
