#!/usr/bin/env node
/**
 * Agent runtime shell — stage A policy checks.
 *
 * The Worker source imports its siblings without file extensions (the bundler
 * resolves them), so this file registers a tiny resolve hook that tries `.ts`
 * first, exactly like `assistant-prompt.mjs`. Nothing here touches Workers
 * types or a real D1: the ticket lifecycle runs against an in-memory map, and
 * the Origin matrix is pure string comparison.
 *
 * Asserted:
 *   - the Origin matrix: exact same-origin and a configured origin pass; a
 *     prefix lookalike and a missing Origin refuse;
 *   - the ticket lifecycle: mint, expire, spend twice, wrong session (which
 *     does NOT burn the ticket), and the bindings that make a ticket single-use;
 *   - the routing allowlist refuses any Durable Object class except ASSISTANT;
 *   - `assertHuman` refuses an agent credential and allows a session actor.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-runtime.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveExtensionless(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    path.extname(specifier) === ""
  ) {
    const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : HERE;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = path.resolve(base, specifier + suffix);
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context, nextResolve);
}

registerHooks({ resolve: resolveExtensionless });

const {
  ASSISTANT_BINDING,
  checkUpgradeRequest,
  isTrustedOrigin,
  assertAssistantRoute,
  mintTicket,
  redeemTicket,
} = await import("../agent-runtime.ts");

const { assertHuman } = await import("../authority.ts");

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
    console.log(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

/* ── an in-memory D1 for exactly the ticket statements ─────────────────── */

function makeTicketDB() {
  const tickets = new Map();
  const uses = new Map();

  function statement(sql) {
    const state = { args: [] };
    return {
      bind(...args) {
        state.args = args;
        return this;
      },
      async run() {
        const args = state.args;
        if (sql.includes("DELETE FROM agent_runtime_tickets WHERE expires_at <= ?")) {
          const now = args[0];
          let changes = 0;
          for (const [hash, row] of tickets) {
            if (row.expires_at <= now) {
              tickets.delete(hash);
              changes += 1;
            }
          }
          return { meta: { changes } };
        }
        if (sql.includes("DELETE FROM agent_runtime_ticket_uses WHERE used_at <= ?")) {
          const cutoff = args[0];
          for (const [hash, usedAt] of uses) if (usedAt <= cutoff) uses.delete(hash);
          return { meta: { changes: 0 } };
        }
        if (sql.includes("INSERT INTO agent_runtime_tickets")) {
          const [tokenHash, sessionId, objectName, createdAt, expiresAt] = args;
          tickets.set(tokenHash, {
            session_id: sessionId,
            object_name: objectName,
            created_at: createdAt,
            expires_at: expiresAt,
          });
          return { meta: { changes: 1 } };
        }
        if (
          sql.includes("DELETE FROM agent_runtime_tickets") &&
          sql.includes("session_id = ?")
        ) {
          const [tokenHash, sessionId, objectName, now] = args;
          const row = tickets.get(tokenHash);
          if (
            row !== undefined &&
            row.session_id === sessionId &&
            row.object_name === objectName &&
            row.expires_at > now
          ) {
            tickets.delete(tokenHash);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        }
        if (sql.includes("DELETE FROM agent_runtime_tickets WHERE token_hash = ?")) {
          const changes = tickets.delete(args[0]) ? 1 : 0;
          return { meta: { changes } };
        }
        if (sql.includes("INSERT OR REPLACE INTO agent_runtime_ticket_uses")) {
          uses.set(args[0], args[1]);
          return { meta: { changes: 1 } };
        }
        throw new Error(`unhandled ticket statement: ${sql}`);
      },
      async first() {
        const args = state.args;
        if (sql.includes("FROM agent_runtime_tickets WHERE token_hash = ?")) {
          return tickets.get(args[0]) ?? null;
        }
        if (sql.includes("FROM agent_runtime_ticket_uses WHERE token_hash = ?")) {
          return uses.has(args[0]) ? { used: 1 } : null;
        }
        throw new Error(`unhandled ticket read: ${sql}`);
      },
    };
  }

  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      const results = [];
      for (const item of statements) results.push(await item.run());
      return results;
    },
    _tickets: tickets,
    _uses: uses,
  };
}

/* ── Origin matrix ─────────────────────────────────────────────────────── */

const TRUST_ENV = {
  AUTH_BASE_URL: "https://console.example",
  AUTH_TRUSTED_ORIGINS: "https://ops.example, https://second.example",
};

function request(origin, target = "https://console.example/agents/assistant/assistant") {
  const headers = origin === null ? {} : { Origin: origin };
  return new Request(target, { headers });
}

{
  const exact = isTrustedOrigin(request("https://console.example"), TRUST_ENV);
  check("exact same-origin passes", exact.ok === true, JSON.stringify(exact));

  const extra = isTrustedOrigin(request("https://ops.example"), TRUST_ENV);
  check("configured AUTH_TRUSTED_ORIGINS passes", extra.ok === true, JSON.stringify(extra));

  const base = isTrustedOrigin(request("https://console.example"), {
    AUTH_BASE_URL: "https://console.example",
    AUTH_TRUSTED_ORIGINS: "",
  });
  check("AUTH_BASE_URL counts as trusted", base.ok === true, JSON.stringify(base));

  const lookalike = isTrustedOrigin(
    request("https://console.example.evil.test"),
    TRUST_ENV
  );
  check(
    "prefix lookalike is refused",
    lookalike.ok === false && lookalike.reason === "origin_untrusted",
    JSON.stringify(lookalike)
  );

  const lookalike2 = isTrustedOrigin(request("https://ops.example.evil.test"), TRUST_ENV);
  check("trusted-list prefix lookalike is refused", lookalike2.ok === false);

  const absent = isTrustedOrigin(request(null), TRUST_ENV);
  check(
    "absent Origin is refused",
    absent.ok === false && absent.reason === "origin_missing",
    JSON.stringify(absent)
  );

  const malformed = isTrustedOrigin(request("not an origin"), TRUST_ENV);
  check("malformed Origin is refused", malformed.ok === false, JSON.stringify(malformed));
}

{
  const good = checkUpgradeRequest(
    new Request("https://console.example/agents/assistant/assistant?ticket=abc", {
      method: "GET",
      headers: { Origin: "https://console.example", Upgrade: "websocket" },
    }),
    TRUST_ENV
  );
  check("upgrade with all three checks passes", good.ok === true && good.ticket === "abc");

  const noTicket = checkUpgradeRequest(
    new Request("https://console.example/agents/assistant/assistant", {
      method: "GET",
      headers: { Origin: "https://console.example", Upgrade: "websocket" },
    }),
    TRUST_ENV
  );
  check(
    "upgrade without a ticket refuses",
    noTicket.ok === false && noTicket.response.status === 401,
    String(noTicket.ok)
  );

  const wrongMethod = checkUpgradeRequest(
    new Request("https://console.example/agents/assistant/assistant?ticket=abc", {
      method: "POST",
      headers: { Origin: "https://console.example", Upgrade: "websocket" },
    }),
    TRUST_ENV
  );
  check("non-GET upgrade refuses", wrongMethod.ok === false);
}

/* ── ticket lifecycle ──────────────────────────────────────────────────── */

const SESSION_A = "session-a";
const SESSION_B = "session-b";

{
  const db = makeTicketDB();
  const now = 1_000_000;
  const minted = await mintTicket({ DB: db }, SESSION_A, "assistant", now);
  check("mint returns a 60 s expiry", minted.expires_at === now + 60_000);
  check("mint returns a 43-char URL-safe token", /^[A-Za-z0-9_-]{43}$/.test(minted.ticket));

  const spent = await redeemTicket({ DB: db }, minted.ticket, SESSION_A, "assistant", now + 1);
  check("redeem succeeds for the minting session", spent.ok === true, JSON.stringify(spent));
  check("the row is deleted on redemption", db._tickets.size === 0);

  const replay = await redeemTicket({ DB: db }, minted.ticket, SESSION_A, "assistant", now + 2);
  check(
    "a replay is refused as already_used",
    replay.ok === false && replay.reason === "already_used",
    JSON.stringify(replay)
  );
}

{
  const db = makeTicketDB();
  const now = 2_000_000;
  const minted = await mintTicket({ DB: db }, SESSION_A, "assistant", now);
  const expired = await redeemTicket(
    { DB: db },
    minted.ticket,
    SESSION_A,
    "assistant",
    minted.expires_at + 1
  );
  check(
    "an expired ticket is refused as expired",
    expired.ok === false && expired.reason === "expired",
    JSON.stringify(expired)
  );
}

{
  const db = makeTicketDB();
  const now = 3_000_000;
  const minted = await mintTicket({ DB: db }, SESSION_A, "assistant", now);
  const wrong = await redeemTicket({ DB: db }, minted.ticket, SESSION_B, "assistant", now + 1);
  check(
    "a ticket from another session is refused",
    wrong.ok === false && wrong.reason === "wrong_session",
    JSON.stringify(wrong)
  );
  check("a wrong-session attempt does not burn the ticket", db._tickets.size === 1);

  const owner = await redeemTicket({ DB: db }, minted.ticket, SESSION_A, "assistant", now + 2);
  check("the owning session still spends it", owner.ok === true, JSON.stringify(owner));
}

{
  const db = makeTicketDB();
  const now = 4_000_000;
  const minted = await mintTicket({ DB: db }, SESSION_A, "assistant", now);
  const wrongObject = await redeemTicket({ DB: db }, minted.ticket, SESSION_A, "other", now + 1);
  check(
    "a ticket is bound to the pinned object name",
    wrongObject.ok === false && wrongObject.reason === "wrong_object",
    JSON.stringify(wrongObject)
  );

  const unknown = await redeemTicket({ DB: db }, "a".repeat(43), SESSION_A, "assistant", now + 1);
  check(
    "a token that was never minted is refused as unknown",
    unknown.ok === false && unknown.reason === "unknown",
    JSON.stringify(unknown)
  );
}

/* ── the routing allowlist ─────────────────────────────────────────────── */

{
  check("ASSISTANT is allowed", assertAssistantRoute({ className: ASSISTANT_BINDING }) === null);
  for (const other of ["DEVICE", "AUTH_GUARD", "AUTHORITY_GUARD", "device", ""]) {
    const refused = assertAssistantRoute({ className: other });
    check(
      `class "${other}" is refused with 404`,
      refused instanceof Response && refused.status === 404,
      refused === null ? "allowed" : String(refused.status)
    );
  }
}

/* ── assertHuman ───────────────────────────────────────────────────────── */

{
  const agent = {
    userId: null,
    label: "agent:ci",
    role: "agent",
    canGrantOwner: false,
    agentTokenId: "tok_1",
  };
  const refused = assertHuman(agent);
  check("an agent credential is refused", refused.ok === false);
  check(
    "the refusal is a permission error",
    refused.ok === false && refused.response.status === 403,
    refused.ok ? "allowed" : String(refused.response.status)
  );

  const session = {
    userId: "user_1",
    label: "owner@example.test",
    role: "owner",
    canGrantOwner: true,
    sessionId: "session-a",
  };
  check("a human session actor is allowed", assertHuman(session).ok === true);

  const machine = {
    userId: null,
    label: "admin-token",
    role: "machine",
    canGrantOwner: true,
  };
  check("the ADMIN_TOKEN machine credential is allowed", assertHuman(machine).ok === true);

  check("a missing actor is refused", assertHuman(null).ok === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
