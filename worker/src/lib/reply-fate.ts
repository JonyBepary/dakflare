/**
 * One word for what became of an inbound message's reply, and the facts behind it.
 *
 * The console already has a per-row `reply_state` (queued/sent/failed/delivered)
 * for a reply that EXISTS. That answers "did the reply arrive". It cannot answer
 * the question an operator actually asks when a message was NOT answered: why
 * not. Six different things look identical from the outside — no rule matched, a
 * rule matched but its cooldown held it, its hourly cap held it, a flow ran and
 * said nothing, automation is disabled, or an agent is waiting for a human — and
 * they call for six different fixes.
 *
 * So there are seven verdicts, and every one of them is reachable:
 *
 *   replied              a reply was queued and the radio accepted it
 *   queued               a reply is queued but has not reached the radio yet
 *   failed               the reply command reached FAILED or EXPIRED
 *   suppressed_cooldown  a rule matched; its cooldown window was still open
 *   suppressed_hourly_cap a rule matched; its hourly cap was spent
 *   no_match             automation ran and nothing matched
 *   paused_hitl_approval an agent asked to send this, and a human has not answered
 *
 * `paused_hitl_approval` belongs to the same vocabulary because it is the same
 * question from the operator's side: a message did not go out and something is
 * waiting. It is derived from an approval request rather than a message row,
 * which is why the trace resolves an id to a request, a command or a message
 * before it decides.
 */

/**
 * The verdicts, in the order the console lists them: outcomes first, then the
 * three "nothing went out" reasons, then the one that is waiting on a person.
 */
export const SUMMARY_VERDICTS = [
  "replied",
  "queued",
  "failed",
  "suppressed_cooldown",
  "suppressed_hourly_cap",
  "no_match",
  "paused_hitl_approval",
] as const;

export type SummaryVerdict = (typeof SUMMARY_VERDICTS)[number];

const VERDICT_SET: ReadonlySet<string> = new Set(SUMMARY_VERDICTS);

export function isSummaryVerdict(value: unknown): value is SummaryVerdict {
  return typeof value === "string" && VERDICT_SET.has(value);
}

/** What the trace found, before it is reduced to one word. */
export interface FateFacts {
  /** True when the id resolved to an approval request that is still pending. */
  pending_approval: boolean;
  /** The reply command's state, when a reply was queued. */
  reply_command_state: string | null;
  /** True when the inbound row records an automated reply. */
  auto_reply: boolean;
  /** The persisted suppression, which cannot be recomputed after the fact. */
  suppressed: "suppressed_cooldown" | "suppressed_hourly_cap" | null;
}

export interface Fate {
  verdict: SummaryVerdict;
  /** Why, in operator words, one line per reason. */
  why: string[];
}

/** The command states that mean the radio has the message. */
const RADIO_STATES = new Set(["SENT", "DELIVERED"]);
const IN_FLIGHT_STATES = new Set(["PENDING", "LEASED", "DISPATCHED"]);
const DEAD_STATES = new Set(["FAILED", "EXPIRED"]);

/**
 * Reduce the facts to one word.
 *
 * Order matters and is the order of certainty: a decided approval outranks
 * everything (nothing else exists yet), then a reply command's real state, then
 * a recorded suppression, then silence.
 */
export function deriveFate(facts: FateFacts): Fate {
  if (facts.pending_approval) {
    return {
      verdict: "paused_hitl_approval",
      why: ["an agent asked to send this, and the request has not been answered"],
    };
  }

  const state = facts.reply_command_state;
  if (state !== null) {
    if (RADIO_STATES.has(state)) {
      return { verdict: "replied", why: [`the reply command is ${state}`] };
    }
    if (IN_FLIGHT_STATES.has(state)) {
      return {
        verdict: "queued",
        why: [`the reply command is ${state}; the radio has not accepted it yet`],
      };
    }
    if (DEAD_STATES.has(state)) {
      return {
        verdict: "failed",
        why: [`the reply command ended ${state}`],
      };
    }
    // An unrecognised state is reported rather than folded into "queued": a
    // vocabulary that grew should look like it grew, not like a healthy queue.
    return { verdict: "queued", why: [`the reply command is in state ${state}`] };
  }

  if (facts.suppressed !== null) {
    return {
      verdict: facts.suppressed,
      why:
        facts.suppressed === "suppressed_cooldown"
          ? ["a rule matched, and its cooldown window was still open"]
          : ["a rule matched, and its hourly cap was already spent"],
    };
  }

  if (facts.auto_reply) {
    // Automated, no command, no suppression: the row records a reply whose
    // command has aged out of retention. Honest answer, not a guess.
    return {
      verdict: "queued",
      why: ["the row records an automated reply, but its command is no longer stored"],
    };
  }

  return {
    verdict: "no_match",
    why: ["automation ran and nothing matched this message"],
  };
}
