import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { mintTicketThroughRoute, seedAdminSession } from "./helpers";

/**
 * The agent upgrade gate, end to end through the real Worker entry point.
 *
 * Only the pool can run this: `SELF.fetch` reaches `handleFetch` with a
 * WebSocket upgrade, D1 holds the minted ticket, and the pinned `AssistantAgent`
 * Durable Object answers the 101. A node harness would have to fake the upgrade,
 * the D1 ticket table and the routing hook.
 */
const AGENT_URL = "https://example.com/agents/assistant/assistant";

function upgrade(ticket?: string, origin = "https://example.com", cookie?: string): Promise<Response> {
  const url = new URL(AGENT_URL);
  if (ticket !== undefined) url.searchParams.set("ticket", ticket);
  const headers: Record<string, string> = {
    Upgrade: "websocket",
    Connection: "Upgrade",
    Origin: origin,
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version": "13",
  };
  if (cookie !== undefined) headers.Cookie = cookie;
  return SELF.fetch(url.toString(), { headers });
}

describe("agent upgrade gate", () => {
  it("refuses a socket with no ticket as 401 agent_ticket_missing", async () => {
    const response = await upgrade();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "agent_ticket_missing" });
  });

  it("refuses an untrusted Origin as 403 agent_origin_untrusted", async () => {
    const response = await upgrade("any-ticket", "https://console.example.evil.test");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "agent_origin_untrusted" });
  });

  it("upgrades to 101 with a minted ticket, the right Origin and a session cookie", async () => {
    const { cookie } = await seedAdminSession("owner");
    const ticket = await mintTicketThroughRoute(cookie);

    const response = await upgrade(ticket, "https://example.com", cookie);
    expect(response.status).toBe(101);
    expect(response.webSocket).toBeDefined();
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test done");
  });
});
