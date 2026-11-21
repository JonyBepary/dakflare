import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import { hostRpId, resolveRpId } from "../src/auth/settings";

/**
 * A fresh install gets no AUTH_BASE_URL: `dakflare up` keeps local origins out
 * of the deployed secrets, and one pack serves every account. The passkey rpId
 * therefore has to come from the request. The old fallback was the domain the
 * project was written on, which made every other deployment fail the ceremony.
 */
const env = (overrides: Partial<Env> = {}): Env => ({ ...overrides }) as Env;

describe("WebAuthn rpId", () => {
  it("uses the workers.dev account subdomain, never the worker host", () => {
    expect(hostRpId("dakflare-worker.sohelahmedjony.workers.dev")).toBe(
      "sohelahmedjony.workers.dev"
    );
    expect(hostRpId("dakflare-worker.fresh-account.workers.dev")).toBe(
      "fresh-account.workers.dev"
    );
  });

  it("keeps a custom domain whole and drops the port", () => {
    expect(hostRpId("sms.example.com")).toBe("sms.example.com");
    expect(hostRpId("console.example.com:8787")).toBe("console.example.com");
    expect(hostRpId("127.0.0.1:8787")).toBe("127.0.0.1");
    expect(hostRpId("[::1]:8787")).toBe("::1");
  });

  it("lets an operator pin the rpId", () => {
    expect(
      resolveRpId(
        env({ AUTH_RP_ID: "login.example.com" }),
        "https://dakflare-worker.fresh.workers.dev/api/auth/passkey/generate-register-options"
      )
    ).toBe("login.example.com");
  });

  it("prefers AUTH_BASE_URL over the request", () => {
    expect(
      resolveRpId(
        env({ AUTH_BASE_URL: "https://console.example.com" }),
        "https://dakflare-worker.fresh.workers.dev/api/auth/passkey/generate-register-options"
      )
    ).toBe("console.example.com");
  });

  it("derives from the request when the deployment ships no auth origin", () => {
    expect(
      resolveRpId(
        env(),
        "https://dakflare-worker.fresh-account.workers.dev/api/auth/passkey/generate-register-options"
      )
    ).toBe("fresh-account.workers.dev");
  });

  it("returns undefined when there is neither a pin nor a request", () => {
    expect(resolveRpId(env())).toBeUndefined();
  });
});
