import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createActTools } from "../src/agent/act";
import { Journal, type JournalStorage } from "../src/agent/journal";
import { runTurn } from "../src/agent/loop";
import type { AgentTool } from "../src/agent/types";

/**
 * Journal replay against the deployed seams.
 *
 * The model is stubbed through the same `options.model` seam
 * `__checks__/agent-loop.mjs` uses. What only the pool adds is the other two
 * ends: the journal writes to the real `AssistantAgent` SQLite (via
 * `runInDurableObject`), and authorisation reads the real D1 grant row, so the
 * ``use_count`` this test leaves unchanged is a persisted column rather than a
 * mock's counter.
 */
const ACTOR = { userId: "u1", label: "tester", role: "admin", canGrantOwner: true } as const;
const TO = "+15550001";
const KEY = "pool-replay";

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  return { id, name, arguments: JSON.stringify(args) };
}

async function seedGrant(): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO agent_tokens
         (id, name, token_hash, scopes_json, max_per_hour, sent_current_hour,
          hour_window_start, created_at, created_by)
       VALUES ('autonomy:agent', 'agent autonomy (runtime)', 'autonomy-not-a-credential',
               '["sms:send:production","rules:write","flow_deploy_prod"]', 0, 0, 0, ?, 'test')
       ON CONFLICT(id) DO NOTHING`
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO agent_autonomy
         (id, enabled, sms_cap, write_cap, expires_at, updated_by, updated_at, allow_rules, actor)
       VALUES (1, 1, 10, 50, ?, 'tester', ?, 0, 'tester')
       ON CONFLICT(id) DO UPDATE SET enabled = 1, expires_at = excluded.expires_at,
         updated_by = excluded.updated_by, actor = excluded.actor`
    ).bind(now + 3_600_000, now),
    env.DB.prepare(
      `INSERT INTO authority_grants
         (id, agent_token_id, scope, target_json, granted_by, granted_at,
          expires_at, revoked_at, use_count, last_used_at)
       VALUES ('grant_replay', 'autonomy:agent', 'sms:send:production', ?, 'tester', ?, ?, NULL, 0, NULL)
       ON CONFLICT(id) DO UPDATE SET use_count = 0, revoked_at = NULL, expires_at = excluded.expires_at`
    ).bind(JSON.stringify({ recipients: [TO], max_uses: 5 }), now, now + 3_600_000),
  ]);
}

/** A scripted streaming adapter: one tool call, then a plain answer. */
function adapter() {
  const rounds: Array<{
    tokens?: string[];
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  }> = [
    { toolCalls: [toolCall("send_sms", { device_id: "d1", to: TO, body: "hi" }, "call_replay")] },
    { tokens: ["recorded"] },
  ];
  let index = 0;
  return {
    calls: 0,
    async chat() {
      throw new Error("the streaming fake must be driven through chatStream");
    },
    async chatStream(
      _messages: unknown,
      _options: unknown,
      onEvent: (event: { type: string; text: string }) => void
    ) {
      const round = rounds[Math.min(index, rounds.length - 1)];
      index += 1;
      this.calls += 1;
      let text = "";
      for (const delta of round.tokens ?? []) {
        text += delta;
        onEvent({ type: "token", text: delta });
      }
      return { text, tokensIn: 7, tokensOut: 3, toolCalls: round.toolCalls };
    },
  };
}

async function runOnce(sessionId: string) {
  const stub = env.ASSISTANT.getByName("assistant");
  // Lifecycle's onStart (our ledger) runs on the first entry point; the
  // wrapper `runInDurableObject` uses does not pass through it.
  await stub.fetch("https://assistant/__runtime/status");
  return runInDurableObject(stub, async (instance, ctx) => {
    const journal = new Journal({
      sql: ctx.storage.sql as unknown as JournalStorage["sql"],
      transactionSync: (fn: () => unknown) => ctx.storage.transactionSync(fn),
    });
    const effects = { dispatches: 0 };
    const tools: AgentTool[] = createActTools({
      dispatch: {
        async createRule() {
          effects.dispatches += 1;
          return Response.json({ ok: true });
        },
        async sendSms() {
          effects.dispatches += 1;
          return Response.json({ ok: true, command_id: "cmd_pool_1" });
        },
        async deployFlow() {
          effects.dispatches += 1;
          return Response.json({ ok: true });
        },
      },
    });
    const frames: Array<Record<string, unknown>> = [];
    const result = await runTurn(
      instance.env,
      ACTOR,
      sessionId,
      "send it",
      tools,
      {
        model: adapter(),
        journal,
        budget: { chargeTokens: async () => {} },
        idempotencyKey: KEY,
        onEvent: (frame) => frames.push(frame as unknown as Record<string, unknown>),
      }
    );
    return {
      effects,
      frames,
      answer: result.answer,
      dispatches: effects.dispatches,
    };
  });
}

describe("journal replay", () => {
  it("settles one effect, reports replayed:true and leaves the grant use count unchanged", async () => {
    await seedGrant();

    const first = await runOnce("pool:turn:a");
    expect(first.dispatches).toBe(1);
    let grant = await env.DB.prepare(
      `SELECT use_count FROM authority_grants WHERE id = 'grant_replay'`
    ).first<{ use_count: number }>();
    expect(grant?.use_count).toBe(1);

    // Same call id: runTurn derives `${idempotencyKey}:${turn}:${index}`, and a
    // first turn in a second journal session reproduces it exactly.
    const second = await runOnce("pool:turn:b");
    expect(second.dispatches).toBe(0);
    expect(second.answer).toBe("recorded");

    const toolFrame = second.frames.find((frame) => frame.type === "tool");
    expect(toolFrame).toBeDefined();
    const toolResult = toolFrame?.result as { ok: boolean; data?: { replayed?: boolean } };
    expect(toolResult.ok).toBe(true);
    expect(toolResult.data?.replayed).toBe(true);

    grant = await env.DB.prepare(
      `SELECT use_count FROM authority_grants WHERE id = 'grant_replay'`
    ).first<{ use_count: number }>();
    expect(grant?.use_count).toBe(1);
  });
});
