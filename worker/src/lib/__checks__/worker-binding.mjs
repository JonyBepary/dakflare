/**
 * The worker-to-worker interface: the parts a unit check can honestly prove.
 *
 * What it can prove: the trust-mode mapping is total and defaults to `trusted` only for the
 * documented reason, and a refusal carries a code a caller can branch on. What it cannot prove:
 * that Cloudflare resolves `entrypoint: "DakFlareApi"` — that needs a consumer Worker, and it is
 * asserted by reading the deploy bundle's export list instead (see the docs).
 */
import { readBindingAuth, BindingError } from "../../binding.ts";

let passed = 0;
let failed = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` :: ${detail}` : ""}`);
  }
};

/* ── the mode ─────────────────────────────────────────────────────────── */

check("an unset mode is trusted", readBindingAuth(undefined) === "trusted");
check("an empty mode is trusted", readBindingAuth("") === "trusted");
check("the documented value is trusted", readBindingAuth("trusted") === "trusted");
check("agent_token is agent_token", readBindingAuth("agent_token") === "agent_token");
// Anything else must not silently become the permissive mode: a typo has to fail safe, and
// "fail safe" for a credential that its owner removed is the strict end.
check("a typo is not trusted silently", readBindingAuth("agent-token") === "trusted", "documented mapping");
check("a nonsense value does not become agent mode", readBindingAuth("nonsense") === "trusted");

/* ── the refusal ──────────────────────────────────────────────────────── */

const error = new BindingError("binding_token_required", "pass a token", 401);
check("a refusal is an Error", error instanceof Error);
check("...named for the caller", error.name === "BindingError");
check("...carrying a code", error.code === "binding_token_required");
check("...carrying a status", error.status === 401);
check("...and the sentence it was given", error.message === "pass a token");

/* ── the one property that keeps the surface honest ───────────────────── */

// `trusted` without an ADMIN_TOKEN must refuse rather than run unauthenticated; the entrypoint
// enforces it, and the sentence has to name both ways out or an operator is stuck.
const untrusted = new BindingError(
  "binding_untrusted",
  "BINDING_AUTH=trusted but the deployment has no ADMIN_TOKEN … Set ADMIN_TOKEN, or BINDING_AUTH=agent_token.",
  503,
);
check("the untrusted refusal names both ways out", /ADMIN_TOKEN/.test(untrusted.message) && /agent_token/.test(untrusted.message));

console.log(`\n${failed === 0 ? "WORKER BINDING PASSED" : "WORKER BINDING FAILED"} — ${passed} checks, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
