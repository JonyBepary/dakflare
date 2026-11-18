import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedAdminSession } from "./helpers";
import { isBlockedWebhookHost } from "../src/lib/flow-ir";
import { validateBaseUrl } from "../src/lib/ai/settings";
import { computeDeviceLifecycle } from "../src/lib/canonical-lifecycle";

describe("security guards, SSRF, and SSE origin checks", () => {
  it("blocks SSRF bypass variants on webhook URLs while allowing public HTTPS", () => {
    const blocked = [
      "http://example.com/hook",
      "https://good.com@127.0.0.1/hook",
      "https://0x7f000001/hook",
      "https://2130706433/hook",
      "https://0177.0.0.1/hook",
      "https://[::]/hook",
      "https://[::1]/hook",
      "https://[::ffff:127.0.0.1]/hook",
      "https://[::ffff:169.254.169.254]/latest/meta-data",
      "https://100.64.0.1/hook",
      "https://198.18.0.1/hook",
      "https://[fc00::1]/hook",
      "https://[fd12:3456::1]/hook",
      "https://[fe80::1]/hook",
      "https://localhost/hook",
      "https://api.internal/hook",
      "https://printer.local/hook",
      "https://169.254.169.254./latest/meta-data",
    ];
    for (const url of blocked) {
      expect(isBlockedWebhookHost(url), `expected blocked: ${url}`).toBe(true);
    }

    expect(isBlockedWebhookHost("https://hooks.example.com/dakflare")).toBe(false);
    expect(isBlockedWebhookHost("https://8.8.8.8/webhook")).toBe(false);
  });

  it("enforces AI baseUrl loopback/private/origin restrictions", () => {
    expect(validateBaseUrl("http://localhost:11434").ok).toBe(true);
    expect(
      validateBaseUrl("http://localhost:11434", { authBaseUrl: "https://gw.example.com" }).ok
    ).toBe(false);
    expect(validateBaseUrl("https://169.254.169.254/v1").ok).toBe(false);
    expect(validateBaseUrl("https://[fc00::1]/v1").ok).toBe(false);
    expect(
      validateBaseUrl("https://api.openai.com/v1", {
        allowedOrigins: "https://models.example.com",
      }).ok
    ).toBe(false);
    expect(
      validateBaseUrl("https://models.example.com/v1", {
        allowedOrigins: "https://models.example.com",
      }).ok
    ).toBe(true);
  });

  it("reports REVOKED lifecycle when revoked_at is set", () => {
    const lifecycle = computeDeviceLifecycle({
      archived_at: null,
      revoked_at: Date.now() - 1_000,
      ws_connected: true,
      last_seen_at: Date.now(),
    });
    expect(lifecycle.state).toBe("REVOKED");
    expect(lifecycle.substate).toBe("device_revoked");
    expect(lifecycle.is_online).toBe(false);
  });

  it("allows Origin-less same-origin GET SSE stream reads and rejects cross-site/untrusted", async () => {
    const { cookie } = await seedAdminSession("owner");
    const streamUrl = "https://example.com/agents/assistant/assistant/streams/s1?from=0";

    const crossSite = await SELF.fetch(streamUrl, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toEqual({ error: "agent_origin_untrusted" });

    const evilOrigin = await SELF.fetch(streamUrl, {
      headers: { Cookie: cookie, Origin: "https://evil.example.test" },
    });
    expect(evilOrigin.status).toBe(403);

    const sameSiteEventSource = await SELF.fetch(streamUrl, {
      headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    });
    expect(sameSiteEventSource.status).not.toBe(403);
    await sameSiteEventSource.body?.cancel();
  });
});
