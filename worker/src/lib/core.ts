/**
 * Calls from the split agent Worker to the main Worker.
 *
 * The service binding is the transport; ADMIN_TOKEN is the credential the main
 * Worker's existing `/v1` router already understands. The agent Worker is
 * internal-only and holds the same token as the CLI.
 */
import type { Env } from "../index";

export async function coreFetch(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  if (env.CORE === undefined) {
    return Response.json({ error: "binding_unavailable" }, { status: 503 });
  }
  const token = env.ADMIN_TOKEN;
  if (token === undefined || token === "") {
    return Response.json({ error: "binding_untrusted" }, { status: 503 });
  }
  const headers = new Headers({
    authorization: `Bearer ${token}`,
    "x-dakflare-client": "cli",
  });
  let body: string | undefined;
  if (init.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.body);
  }
  try {
    return await env.CORE.fetch(`https://core${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
    });
  } catch (error) {
    return Response.json(
      { error: "binding_failed", message: String(error).slice(0, 200) },
      { status: 502 }
    );
  }
}
