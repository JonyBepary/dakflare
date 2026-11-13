# 05 — Voice: warm hands, hard numbers

Status: proposed 2026-10-29. Review only: no application file was changed to produce
this document.

The visual direction (`DESIGN_2026.md`) buys warmth with cream, pastel containers and one
dopamine moment per success. This file does the same work in words, and holds the same
line: warmth is spent where nothing is at stake, and never where a number is.

Read for this review: `docs/DESIGN_2026.md`, `docs/CONSOLE_UX.md`,
`docs/WAVE2_NATIVE_SMS.md`, `design/preview.html`, the user-facing strings in
`dashboard/src/lib/components/*`, `dashboard/src/routes/*/+page.svelte`,
`dashboard/src/lib/{api,commands,presence,format}.ts` and
`simulator/src/routes/{+layout,+page}.svelte`.

Normative neighbours: `CONSOLE_UX.md` owns the five device states, the
rules-vs-flows pipeline and one-reply-per-message. `DESIGN_2026.md` owns colour, motion
and where the mascot may stand. This file owns **what the product says and how**.

---

## 1. The voice chart (one page)

Three traits, in precedence order. When they conflict, the earlier one wins: **exact**
beats **steady**, and **steady** beats **warm**.

| Trait | What it means in practice | Sounds like, in a sentence | Never write (the opposite) |
|---|---|---|---|
| **Exact** | The count, the name and the state are the ones the machine has. Nothing rounded, nothing softened, nothing summarised away. The subject of the sentence is a real thing. | "3 of 4 devices answering. Pixel 8 has not been heard from in 16 hours." | "Most of your fleet is healthy — one phone needs a nudge!" |
| **Warm at the edges** | Warmth is spent only where nothing is at stake: greeting, empty state, pairing success, the quiet panel, a confirmed send. It is a tone of address, not a layer of decoration. | "Nothing is on fire. One stale phone, no failed sends." | "Oops! Something went wrong 😬" |
| **Steady** | Bad news is one short sentence, a cause, and the next action. No alarm, no apology theatre, no comfort the data cannot support. | "The phone never collected it. Send again when it is back." | "🚨 Your gateway is DOWN — messages are not being delivered!" |

### 1.1 Who is speaking

- **"You" is the operator**, always. There is exactly one, and they are competent.
- **Never "we".** There is no company in the sentence: this is self-hosted software with
  one human in front of it. "We could not reach the gateway" invents a support team.
- **The system is a thing, not a person**: *the console*, *the gateway*, *the phone*,
  *the device*. Lower case in running text, third person, no moods.
- **The mascot never speaks** (§3.2).

### 1.2 Where warmth is allowed

| Spend warmth | Never spend warmth |
|---|---|
| first paint, greeting, empty states, pairing success, the quiet panel, a delivered send | any error, any alert, any destructive confirmation, any table row, any sentence carrying a number, any log line |

This is the whole brief in one row: the operator opens this at 02:00 because a phone
stopped answering. A cheerful voice there reads as a product that has not understood the
job. A flat voice on the empty state reads as a product nobody finished.

### 1.3 The copy already in the repo

The prose in this codebase is mostly *already in voice*. The failures cluster in one
place — **wherever the UI narrates the protocol** — and in the last-ditch error strings.
That is the useful finding: this is not a rewrite of the product, it is a rewrite of the
send tracker and the fallback layer.

**Already matches; keep and copy the pattern.**

| String (verbatim) | Where | Why it works |
|---|---|---|
| "Queued, waiting for the phone to pick it up." | `lib/commands.ts` | One clause, exact, no jargon above the operator. |
| "{n} devices have not been heard from" | `AlertBanner.svelte` | The fact, with a count, and no adjective. |
| "3 of 4 devices answering" | `routes/+page.svelte` | The anchor number, stated as a ratio rather than a percentage or a mood. |
| "That token was not accepted." | `routes/login/+page.svelte` | Blames the token, not the person. |
| "The gateway did not answer in time. Try again." | `lib/api.ts` | Cause, then action, and no apology. |
| "A rule pairs a sender matcher and a message matcher with an optional reply." | `routes/rules/+page.svelte` | Explains the consequence of having none, not the absence (CONSOLE_UX §6). |
| "A pairing link sets this for you. Enter it by hand only when you are typing a bare code." | `simulator/+page.svelte` | Second person, concrete, tells the operator which case they are in. |
| "Nothing is on fire" / "One stale phone and no failed sends." | `design/preview.html` | The only joke, immediately qualified by the two numbers that make it true. |

**Out of voice; rewrite.**

| String (verbatim) | Where | The defect |
|---|---|---|
| "The gateway returned `command: null` for this id. It may have expired out of the device's store, or the id was never a command." | `CommandTracker.svelte` | JSON and backticks in a sentence. The operator does not have a "store". |
| "Polling stopped — this is a final state." | `CommandTracker.svelte` | Narrates the poller. The operator is watching a message, not a loop. |
| "Stopped checking after 30 seconds." | `CommandTracker.svelte` | Same; the interesting fact is that the phone has not taken it yet. |
| "The phone handed the message to the SIM." | `lib/commands.ts` | The SIM does not send; the radio does (WAVE2 §8). Factually loose and it reads like a wiring diagram. |
| "Queued commands are drained over the device's WebSocket, or on its next poll if the device is not connected." | `DeviceDetail.svelte` | Transport detail in a panel about a phone. |
| "Command {id} accepted for {device}. The state below follows it until the device or carrier reports a final result." | `SendSmsForm.svelte` | "Command", "final result": two internal nouns in one sentence. |
| "Something went wrong. Try again." | `lib/api.ts` | The only string in the product with no subject. |
| "Something broke" / "Unexpected error." | `routes/+error.svelte` | Mismatched register: one is a shrug, the other is a stack trace. |
| "Purged 3 message(s)" / "captured 2 outbound message(s)" | `simulator/+page.svelte` | `(s)` is machine output; the sentence should not need a bracket to be true. |

---

## 2. The microcopy that ships

Strings below are final; `{…}` marks a value that is rendered in `.mono`. Two variants
appear only where the surface genuinely changes tone (console vs phone). Everything else
has one form.

### 2.1 Send states

One vocabulary for the message, a separate one for the phone. The wire enum is never
shown: today `CommandTracker.svelte:188` and `DeviceDetail.svelte:486` print
`{command.state}`, so an operator reads `ACKED_BY_DEVICE` in a badge.

| Wire state | Badge | Line under it |
|---|---|---|
| `PENDING` | **Queued** | "Queued. The phone collects it when it next checks in." |
| `DISPATCHED` | **Queued** | "Queued. Handed to the phone over its live link; waiting for it to accept." |
| `ACKED_BY_DEVICE` | **Received** | "The phone has it and is sending it now." |
| `SENT` | **Sent** | "The phone handed it to the radio. The carrier has not confirmed delivery." |
| `DELIVERED` | **Delivered** | "The carrier confirmed delivery." (Do not ship until receipts are real — WAVE2 §8.) |
| `FAILED` | **Failed** | "The phone could not send it. {reason}" |
| `EXPIRED` | **Not sent** | "The phone never collected it. Nothing was sent." |

**Not answered** is an inbound state, not a command state. Every such row uses the same
two opening words so the log scans:

| Reason | String |
|---|---|
| carrier mask | "Not answered. The sender is a carrier mask, and masks never get an automatic reply." |
| shortcode without `allow_shortcode` | "Not answered. This is a shortcode; the rule that matched does not allow them." |
| self-number guard | "Not answered. It came from this phone's own number." |
| nothing matched | "Not answered. No rule or flow matched." |
| device replied itself | **Answered** — "Answered on the phone." |
| gateway-side rule replied | **Answered** — "Answered by rule {name}." |

### 2.2 Permission prompts (phone app)

The pre-prompt runs before the Android dialog and must say what the app is (WAVE2 §3).

**SMS access — pre-prompt**

> **Let this phone answer SMS**
> DakFlare is a gateway, not a messenger. It reads every message that reaches this SIM
> and sends only the replies your rules choose.
> `[ Allow SMS access ]`  `[ Not now ]`

**SMS access — declined or revoked**

> **SMS access is off**
> The phone can pair, but it cannot receive or send until you allow it. No message is
> answered while this is off.
> `[ Open settings ]`

**Phone number — pre-prompt**

> **Use this phone's number?**
> For one thing: never to text it. If a message arrives from this phone's own number, no
> rule will answer it. The number stays on the phone.
> `[ Share the number ]`  `[ Not now ]`

**Phone number — declined**

> No number shared. The self-number guard is off: a message from this phone's own number
> could get an automatic reply.

**Notifications** (Android 13+, the foreground service) — "DakFlare keeps answering while
the app is closed. This notification is how Android lets it run; it stays quiet."

### 2.3 Pairing success

Console (factual; one `pop`, mint sheet, mascot once):

> **Paired as Mi A3 · Grameenphone**
> This code was single-use and is now spent. The phone appears on Overview after its first
> check-in.

Phone (the one place the voice may grin):

> **Paired.**
> This phone answers for `{host}`. Keep the app open, or leave the service on, and the
> rules you set will do the rest.

Pairing failure, either surface: "That code was already used or has expired. Mint a new
one." Never "Invalid code" — the code is not the operator's mistake.

### 2.4 Empty states

Empty states explain the mechanism (CONSOLE_UX §6). Title states the fact; body states
what will happen next.

**Empty thread — phone**

> **No messages yet**
> Messages to this SIM show up here. Replies go out in the same thread.

**Empty thread — console, one device**

> **No messages for this device yet**
> Inbound SMS appears after the phone syncs. Anything you queue here appears immediately.

**No devices — console Devices page**

> **No devices paired yet**
> Mint a single-use code and open the link on the phone you want to answer. Until one is
> paired, nothing can reply.

**No devices — compose panel**

> **No device paired yet**
> Pair a phone before sending. Mint a code on Devices, then come back.

### 2.5 Gateway unreachable (console → Worker)

"Offline" is a word about a **phone** (CONSOLE_UX §2). The console's own connection is
never "offline" — it is *not answering*, because that is the only thing the console
actually knows.

> **The gateway is not answering**
> These numbers are from the last successful check. The page tries again on the next
> refresh. `{error}`

with `[ Try again ]`. On the phone, where the link *is* the device's link, "Offline" is
correct: "Offline. Messages stay on this phone and upload when the gateway is back."

### 2.6 Alerts

The banner already carries the right shape; keep it and fix the two sentences around it.

- One device: "**Pixel 8** has not been heard from in 16 hours." Name it — "1 device
  has not been heard from" makes the operator count to one.
- Several: "{n} devices have not been heard from. Newest: {label} · raised 4h ago."
- Action: `Acknowledge` (label), `Acknowledge alert for {label}` (aria-label).
- Acknowledged: "Acknowledged. It leaves the open list; the history stays."
- Ack failed: "Could not acknowledge {label}. {error}" — keep, it is already right.
- Check failed: "The console could not check for alerts. {error}" (today: "Alert check
  unavailable.").
- The deployment headline is never allowed to imply the fleet is reachable
  (CONSOLE_UX §3). "Deployment nominal" is instrumentation dialect; use "**Gateway
  running**" and let the fleet line underneath carry the fleet.

### 2.7 Destructive confirmations

Title asks the question; body names the object, the consequence and the escape; the
button repeats the verb. No mascot, no motion, no exclamation (DESIGN_2026 §2–3).

| Surface | Title | Body | Confirm |
|---|---|---|---|
| Revoke device | **Revoke this device?** | "**Mi A3** (`dev29b9c2…`) stops authenticating now. Its key is destroyed on the gateway and any queued message is dropped. Pair it again with a new code to bring it back." | `Revoke device` |
| Delete messages | **Delete this device's messages?** | "Every message and flow run stored for **Mi A3** is deleted. The device stays paired and new messages keep arriving. This cannot be undone." | `Delete messages` |
| Delete rule | **Delete this rule?** | "Anything that matches it stops getting an answer. The workflow, if one matches too, becomes the only thing that can reply." | `Delete rule` |
| Forget phone (app) | **Forget this phone?** | "The signing key is removed from this phone. If it is still paired, revoke it in the console first — otherwise the gateway keeps trusting a key that no longer exists." | `Forget this phone` |

`Forget` on the phone and `Revoke` on the console are deliberately different words: one
removes a key locally, the other removes trust remotely, and the operator can do either
without the other.

### 2.8 Numbers, plurals and claims

Rules for any sentence carrying a value.

1. **Values are mono, and the mark travels with the sentence.** Phone numbers, device and
   command ids, pairing codes, counts, timestamps and versions render in `.mono`
   (`font-variant-numeric: tabular-nums`). A number in prose without the mono class is a
   copy bug, not a styling preference.
2. **Never abbreviate identity or count in a data row.** `+88017612829`, not
   `+8801…2829`; `1,204`, not `1.2k`; `18:42:07`, not `6:42 pm`. A number may be masked
   only where the protocol already masks it (sender masks in a log), and then exactly as
   received. A phone number is never truncated into an avatar or an ellipsis
   (DESIGN_2026 §3).
3. **Elapsed time is the one exception, and it is conditional.** `4m ago` is allowed as a
   data-row value in mono, because the exact stamp is always available (`formatAbsolute`
   on hover, or the absolute line beneath). The same duration in prose is spelled out:
   "not heard from in 16 hours".
4. **Counts in copy are numerals, always**: "3 devices", "1 device". Never "three". This
   is already the house style ("3 of 4 devices answering") and it removes a whole class
   of inconsistency.
5. **No pluralisation brackets.** `message(s)` is forbidden; use the plural helper, and if
   a sentence cannot take a clean plural, rewrite the sentence.
6. **No estimates and no invented zeros.** "about", "roughly", "~" are barred from fleet,
   message and time counts; a value that was never reported says "not reported"
   (CONSOLE_UX §6).
7. **No claim above the evidence.** "Sent" means handed to the radio. "Delivered" is
   printed only from a carrier receipt. Until M5.5 ships, the strongest true sentence is
   the one in §2.1.

---

## 3. Naming and personality

### 3.1 What "DakFlare" is allowed to be

The name is a tool, not a character. *Ḍāk* (ডাক) was the relay: a runner carried a
dispatch to the next station and handed it on. Flare is the Cloudflare edge, the last
station. That is the story and it belongs in `README.md` and launch copy — **never in the
product UI**, where it would be a paragraph the operator has read forty times.

| Form | Where | Rule |
|---|---|---|
| `DakFlare` | prose, titles, buttons, docs | the only form in a sentence |
| `DAKFLARE` | mono wordmark, ≤11px | login footer and the app topbar only; never in a sentence |
| `dakflare` | hostnames, CLI, `dakflare://` | lower case, never a brand mention |

It may be: the subject of a factual sentence ("DakFlare pairs a phone with your Cloudflare
account"), a wordmark, a URL scheme, a command name. It may not be: a "we", a promise
("DakFlare keeps you safe"), a personality with opinions, or a word that appears in every
string. Once per screen is enough.

The phone app is **DakFlare**, not "DakFlare device". `device app` in the current
`+layout.svelte` topbar and `<title>DakFlare device</title>` are lab labels; they do not
survive the rebuild.

Vocabulary, because it is already half-decided in the code: **device** is the paired
record (nav, tables, "paired devices", error codes); **phone** is the object in the room
("waiting for the phone", "the phone is asleep", "pair a phone"). The current copy does
this naturally and it should stay deliberate.

### 3.2 The mascot: Daki

**Daki** (DAH-kee, from ডাকি — "I call"), a small line-drawn phone with a face and a check
bubble. Named so that writers stop calling it "the mascot" and treat it as one drawing
with one job; the name itself appears in alt text and release notes, never in a headline
and never on a nameplate.

Limits, from `DESIGN_2026.md` §3 and the surfaces that exist today:

- **Exactly three places**: the empty state, pairing success, and the all-quiet panel. The
  third does not exist in the console yet — it is a build item, not a licence to draw Daki
  somewhere else in the meantime.
- **"Empty state" means one specific empty**: no devices paired, or no traffic at all. Not
  every `EmptyState` — never the filtered log ("No inbound messages in this window"),
  because that absence was caused by a filter, not by quiet.
- **Never** beside an error, a destructive dialog, a message body, a table, a chart, or
  any sentence carrying a number. One instance per page.
- It moves only with `mascot-idle` (4s bob) in the quiet state, and `pop` once on pairing
  success. It has no other poses, no props, no gender, no dialogue, and it is always
  redundant to text — if the heading is removed, nothing is lost.

### 3.3 Icon and illustration language

One hand draws everything: 1.5px stroke, round caps and joins on a 24px grid at 16, 20 and
24px, redrawn on that grid rather than replaced, with the existing `Icon.svelte` names
kept. Illustration is the same hand at 2px ink on cream, one object per drawing, front-on,
with at most one mint fill and no perspective, gradient, drop shadow or 3D. Faces exist
only on Daki; status icons, device glyphs and empty-state marks are objects, not
characters. Icons carry no colour except the semantic chip they sit in; charts stay flat
2px strokes with no area fill; no emoji, no stock art, no illustrated metaphor inside a
table or an alert. The only decorative motion in the system is Daki's bob.

---

## 4. Do / don't, for copy PRs

| # | Write | Not this | Because |
|---|---|---|---|
| 1 | "Message log" + one factual line | "Welcome back! Here's what's happening 👋" | A screen title is a label, not a greeting; the greeting already happened above it. |
| 2 | "The gateway did not answer in time. Try again." | "Oops! Something went wrong." | Cause and action; "something" with no subject cannot be acted on. |
| 3 | "That token was not accepted." | "You entered an invalid token." | Blame the object, not the operator. |
| 4 | "3 of 4 devices answering" | "Most devices are up" | The operator acts on the difference between 3 and 4; a summary deletes it. |
| 5 | "1 message" / "2 messages" | "message(s)" | A bracket in a sentence is machine output leaking into the UI. |
| 6 | "Paired as Mi A3." | "Woohoo! You're all set 🎉" | The success is small and repeatable; celebration should not outrank the fact. |
| 7 | "Sent. The carrier has not confirmed delivery." | "Delivered!" before a receipt exists | A claim above the evidence is how a gateway loses trust once and forever. |
| 8 | "The phone collects it on its next check-in." | "Command `null`; PENDING → DISPATCHED" | Wire vocabulary belongs in the protocol doc, not in a sentence to a human. |
| 9 | no exclamation marks, no emoji, ever | "Uh oh!" / 🚨 / ✅ | One loud mark makes every quiet one unreadable, and there are 40 quiet ones per screen. |
| 10 | "DakFlare pairs a phone with your Cloudflare account." | "We're working hard to keep your messages flowing." | There is no "we"; the software is the subject. |

---

## 5. Three strings to change immediately

All three are on the send path — the one screen the operator stares at while waiting — and
all three are cheap.

**1. The badge prints the wire enum.**
`CommandTracker.svelte:188` (and the same at `DeviceDetail.svelte:486`) renders
`{command.state}`, so a normal send shows `ACKED_BY_DEVICE`.

Replace with the word from §2.1 — `Queued`, `Received`, `Sent`, `Delivered`, `Failed`,
`Not sent` — and keep the raw state in `title` for support.

**2. A protocol payload is quoted in a sentence.**
`CommandTracker.svelte:238`:

> "The gateway returned `command: null` for this id. It may have expired out of the
> device's store, or the id was never a command."

Replace with:

> "No record of this command. It either expired before the phone collected it, or it was
> never a command."

**3. The universal failure has no subject.**
`lib/api.ts:146`: `'Something went wrong. Try again.'`

Replace with:

> "The console could not finish that. Try again; check the gateway log if it keeps
> happening."

This is the string every unrecognised failure lands on, and the same file already proves
the house voice at line 107 ("Could not reach the gateway. Check the connection and try
again.") — the fallback is the only place that forgot.
