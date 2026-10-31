/**
 * The acknowledgement shape, PROTOCOL_CONTRACT_V5 Rev E §6.
 *
 * An ack is an OBJECT, not a bare command id:
 *
 *     { "acks": [{ "command_id": "...", "claim_token": "..." }] }
 *
 * The token is the lease the edge granted when it handed the command over. It is
 * what makes the state machine safe: a device may only move a command
 * `LEASED -> DISPATCHED` while it still holds that exact lease. A late ack from
 * a device whose lease already expired, or an ack from a DIFFERENT device that
 * guessed the id, is a no-op instead of a claim.
 *
 * `ack_command_ids` is gone. A body that still carries it is a v5.2.1 client
 * talking to a v6.0 Worker, and the honest answer is a 400 rather than silence:
 * silently ignoring the key would leave the phone believing it had acknowledged
 * commands that are in fact churning leases on its own handset.
 */

import { MAX_ACK_IDS } from "./config";

export interface Ack {
  command_id: string;
  claim_token: string;
}

/**
 * Validate an `acks` array.
 *
 * Returns `[]` when the key is absent (an ordinary poll), `null` when the value
 * is present but unusable (caller answers 400), and otherwise the entries that
 * have both a non-empty id and a non-empty token. A malformed ENTRY is dropped
 * rather than failing the whole request: a device that acked one command badly
 * should still get its next batch, and a dropped ack is a no-op the lease timer
 * already covers.
 */
export function parseAcks(value: unknown): Ack[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  // Bounded before the loop, exactly like every other request array: an
  // unbounded array is an unbounded amount of Durable Object work.
  if (value.length > MAX_ACK_IDS) return null;

  const acks: Ack[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.command_id !== "string" || row.command_id === "") continue;
    if (typeof row.claim_token !== "string" || row.claim_token === "") continue;
    acks.push({ command_id: row.command_id, claim_token: row.claim_token });
  }
  return acks;
}

/** True when a body still speaks the retired v5.2.1 ack vocabulary. */
export function carriesRetiredAckKey(body: Record<string, unknown>): boolean {
  return body.ack_command_ids !== undefined;
}
