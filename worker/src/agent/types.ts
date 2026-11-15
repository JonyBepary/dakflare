/**
 * The agent runtime's tool contract — pass 3, stages B and C.
 *
 * Everything here is deliberately small and dependency-free so `runTurn` can be
 * exercised with a fake model adapter and a fake journal under plain
 * `node --test`/`node --experimental-strip-types`, with no live model and no
 * Cloudflare binding.
 *
 * A tool is one of three kinds:
 *
 *   read     reads through an existing handler and returns its JSON
 *   propose  stages an `assistant_proposals` row; a human still accepts it
 *   act      performs the effect now, and only after `authorizeAct` says a live,
 *            effect-shaped grant covers it and the daily cap allows it
 *
 * `ToolContext.journal` is the object-local SQLite journal. The `callId` is
 * derived from the ask's idempotency key, never from the model: a model cannot
 * choose the key its own effect is deduplicated on.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import type { Journal } from "./journal";

/** The runtime acts as the human who opened the socket; the grant is the limit. */
export type AgentActor = AdminActor;

export type ToolResult =
  | { ok: true; output: string; data?: unknown }
  | { ok: false; reason: string; message: string };

/** The loop's own token meter. Never the console chat budget. */
export interface AgentBudget {
  chargeTokens(tokens: number): Promise<void>;
}

export interface AgentTool {
  name: string;
  description: string;
  kind: "read" | "propose" | "act";
  parameters: Record<string, unknown>;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  env: Env;
  actor: AgentActor;
  callId: string;
  journal: Journal;
  budget: AgentBudget;
  signal: AbortSignal;
}
