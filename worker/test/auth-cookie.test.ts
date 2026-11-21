import { describe, expect, it } from "vitest";
import { hasSessionCookie } from "../src/auth/guard";

const req = (cookie?: string): Request =>
  new Request("https://example.com/v1/auth/me", cookie === undefined ? undefined : { headers: { cookie } });

describe("hasSessionCookie", () => {
  it("recognises current, secure, legacy and chunked session cookies", () => {
    expect(hasSessionCookie(req("better-auth.session_token=abc"))).toBe(true);
    expect(hasSessionCookie(req("__Secure-better-auth.session_token=abc"))).toBe(true);
    expect(hasSessionCookie(req("better-auth-session_token=abc"))).toBe(true);
    expect(hasSessionCookie(req("__Secure-better-auth-session_token=abc"))).toBe(true);
    expect(hasSessionCookie(req("better-auth.session_token.0=abc"))).toBe(true);
  });

  it("does not treat an unrelated cookie as a session", () => {
    expect(hasSessionCookie(req("theme=dark; other-better-auth.session_token=abc"))).toBe(false);
    expect(hasSessionCookie(req(""))).toBe(false);
    expect(hasSessionCookie(req())).toBe(false);
  });
});
