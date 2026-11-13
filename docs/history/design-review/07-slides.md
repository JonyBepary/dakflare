# 07 — The deck: six slides, two decisions, one state machine

Status: proposed 2026-10-29. Outline and copy only — no HTML was built, no application
file was changed, and no number below was invented. This file is the only change.

Read for this review: `docs/DESIGN_2026.md` (141 lines), `docs/CONSOLE_UX.md` (128),
`docs/WAVE2_NATIVE_SMS.md` (249), `docs/design-review/{01,02,03,04}` (400 / 960 / 1015 /
373), `design/preview.html` (515), and the code the state machine names:
`simulator/src-tauri/gen/android/app/src/main/java/dev/dakflare/simulator/bridge/SmsReceiver.kt`,
`simulator/src-tauri/src/android.rs`, `simulator/core/src/{carrier,db,protocol}.rs`,
`worker/src/routes/incoming.ts`, `PROTOCOL_CONTRACT_V5.md` §6,
`dashboard/src/{lib/commands.ts,routes/messages/+page.svelte}`.

Normative neighbours: `CONSOLE_UX.md` owns the pipeline, the five states and the six
claimable metrics. `DESIGN_2026.md` owns tokens and the freeze list. `03` owns token
names and values, `04` owns composition, `02` owns components. **This file owns only the
deck**: what is on each slide, in what order, and what must never be on one.

Audience: the owner and the next contributor. Not investors — so there is no market, no
traction, no ask, and no slide whose job is to impress.

---

## 0. What the deck is for, and the shape it borrows

One sentence: **a contributor should be able to implement or review the redesign from
these six slides plus the four files they cite, without the chat.**

The skill's 15 strategies (`slide-strategies.md`) are mostly pitching or conference
structures — YC, Series A, Sales, QBR, All-Hands, Workshop. The only one that fits an
internal design handoff is **Product Demo (5–8 slides)**, with its "Live Demo" slot
replaced by **Before/After renders** because there is no shipped build to demo. The arc
that comes out is the skill's Duarte sparkline, compressed:

| # | Skill slot | Copy formula | Layout pattern |
|---|---|---|---|
| 1 | Hook / Problem | PAS (problem only, no agitation) | Two-column split |
| 2 | Solution overview | FAB | Comparison table |
| 3 | Live demo / screenshots | none — a picture | Product screenshot |
| 4 | Key features | FAB | Two-column split |
| 5 | How it works | none — a diagram | Timeline flow |
| 6 | CTA | AIDA's **A** only: one action | CTA closing, no `animate-pulse` |

Rejected from the skill, with the reason in this repo: power-word headlines
("Stop paying for dead phones"), gradient numerals, the `animate-pulse` CTA, any
testimonial or social-proof pattern (`copywriting-formulas.md` §Power Words,
§Social Proof). `01-ui-ux-pro-max.md` §4 already bans marketing copy in the product;
a deck that argues for that product cannot open with it.

**Deck-level rules, applied to all six**

- 1280×720, 16:9. Nothing below 13px, no body copy over 60 words per slide.
- Type: the product's own stacks — system sans + `ui-monospace` with tabular numerals.
  No webfont: `01` §1.3 and `02` §1.6 reject one for Bangla and for the offline webview,
  and the deck is not allowed a face the app cannot have.
- Colour: the deck uses `--df-*` values only. If a slide needs a colour the app does not
  own, the slide is wrong.
- **Every slide carries a `file §section` footer.** A slide without a citation is an
  opinion and does not belong in this deck.
- No transitions, no builds, no speaker notes longer than the slide.

---

## 1. The six slides

### 1.1 Summary

| # | The slide's job, in one sentence | Exact title | The one claim | The visual, and where its data comes from |
|---|---|---|---|---|
| 1 | Hand over the map — what changes, what is frozen — so no later slide re-litigates scope. | `Warm console, real SMS app` | The redesign is presentation only: tokens, composition and message states; the wire, the pipeline and the five device states do not move. | `scope-two-column.png` — five "frozen" rows vs five "changes" rows. Rows lifted verbatim from `DESIGN_2026.md` §6 and `CONSOLE_UX.md` §1–§2; the "changes" column from `03` §0 and `04` §2.1. No chart. |
| 2 | Get a yes/no on the palette values so `design/tokens.css` can be written. | `Cream paper, one coral, mono for facts` | The direction stays; three values change, because the document's own contrast claims do not survive arithmetic. | `tokens-three-fixes.png` — a 3-row table (as written / measured / ships) beside the six state chips at 1:1. Data: `03` §4.2 and §4.6; chips from §1.5. |
| 3 | Show the console's composition as a number, not a mood. | `One number big, one tint, three bands` | Overview becomes 6+3+3 → 8+4 → 12, with one hero number in tabular mono and at most one tinted container. | `overview-span-map.png` — the 968-wide span map with the 25% thumbnail inset. Data: `04` §4.1 (spans, gutters), §4.4, §6.3 (the removal list that produces the thumbnail). |
| 4 | Get a yes/no on four destinations and "one bar at a time", because that decides the route tree. | `Four destinations, one bar at a time` | The phone reads in the order the work happens — arrived, alive, answers, configuration — and inside a thread the composer replaces the dock. | `phone-four-frames.png` — frames A–D at 360×800, 1.4× scale, dock at 4 × 90dp. Data: `04` §3.0–§3.4; dock budget from `01` §2.1. |
| 5 | Make the one thing that must not be re-invented visible: where a message is at each hop, and which vocabulary may appear where. | `One SMS, from the radio to the console` | Every hop has exactly one honest state, and `sent` means the radio took it — never that the recipient got it. | `state-machine.png` — the two-lane, six-column diagram specified in §3. States and refs from §3's tables. |
| 6 | Turn the deck into work: what to read, what to run, what "done" looks like. | `Done is a checklist, not a screenshot` | "Done" is four reads, three runnable checks and eleven pass/fail boxes, all executable in one sitting. | `handoff-checklist.png` — the checklist in §4 as three columns. Data: `03` §2.4, `02` §7, `04` §6, `WAVE2` §5 and §8. |

Two slides carry decisions (2 and 4). The other four carry evidence. That ratio is the
point: a deck of six decisions is a meeting; a deck of six screenshots is a brochure.

### 1.2 Asset production notes

None of the six images exists yet, and each must be produced from repo material rather
than drawn by hand:

- `scope-two-column.png` — new, text only. Build it from the two tables it cites; if a
  row is not in `DESIGN_2026.md` §6 or `CONSOLE_UX.md` §1–§2, delete the row.
- `tokens-three-fixes.png` — the table is text; the chip strip is the six chips from
  `03` §1.5 rendered at their real 22px height, `live`…`unknown` plus `push`.
- `overview-span-map.png` — the map is arithmetic from `04` §4.1 (968 content, columns of
  66, gutters of 16, spans 230/312/476/640/968). The inset thumbnail is a **second
  render of `design/preview.html`** with the `04` §6.3 removal list applied in a scratch
  copy — not a promise, a before/after. Today's render is the "before" half.
- `phone-four-frames.png` — drawn from the tables in `04` §3.1–§3.4, at 360×800. The
  preview's existing phone block (`design/preview.html:475–500`) is the wrong shell (one
  scrolling page, no dock) and is not the source.
- `state-machine.png` — specified in §3, to be drawn.
- `handoff-checklist.png` — text only.

---

## 2. The two decision slides, in full

Both are written to be read in under fifteen seconds from four metres. If a line does
not fit the budget, it is cut, not shrunk.

### 2.1 Slide 2 — the direction

```
[eyebrow · 11px mono · top left]
DECISION 1 · TOKENS

[title · 44/48 600 · y=88 · max 2 lines]
Cream paper, one coral,
mono for facts

[claim · 20/28 · y=200 · max 2 lines, 62ch]
The direction stays. Three values change, because the
document's own contrast claims do not survive arithmetic.

[table · x=72, y=280, width 620]
TOKEN            AS WRITTEN   MEASURED          SHIPS
metadata ink     #857A6B      4.14:1 on card    #6B6153 · 5.97:1
accent text      #C9482A      4.39:1 on page    #B23B20 · 5.51:1
button label     #D9502C fill 4.02:1            #C9482A fill · 4.65:1

[right column · x=740, y=280, width 460 · 15/22]
Six pastels are containers, never text.
Coral is two roles: the thing you press, and the word on cream.
One file — design/tokens.css — imported by both apps.

[footer · 13px mono · y=660]
Measured in 03-design-system.md §4. No taste calls.
```

Word count: title 7 + claim 16 + right column 27 + footer 7 = **57 words**, plus one
three-row table. Fits 1280×720 with the table at 15/22 and 40px row height.

**Must NOT be on slide 2**

- The eleven-fill palette. A swatch strip is a demonstration, not a decision, and `04`
  §5.2 already names it as the tell of a generated dashboard.
- A "before" console screenshot. It invites restyling instead of a yes/no, and slide 3
  owns the before/after.
- The mascot, any gradient, any shadow larger than `--shadow-1` (`DESIGN_2026` §2).
- The words *warm*, *delightful*, *premium*, *accessible* standing alone. Warmth is a
  surface value and accessibility is a ratio; both are already on the slide as numbers.
- Dark-mode frames. `03` §4.5 and `02` §6.1 leave dark mode open; putting it here makes
  it a second, unmeasured decision.
- `--accent-fill` for dark. It still has no specified value (`02` §4.5, item 4).
- The alternative correction from `01` §1.3 (`--accent #B93F22`, one token for both
  roles). It is a real option; it belongs in the speaker's one sentence, not on the
  slide, because two valid answers on one slide produces no decision. This is
  conflict #1 in §6.

### 2.2 Slide 4 — the phone's information architecture

```
[eyebrow · 11px mono]
DECISION 2 · THE PHONE

[title · 44/48 600]
Four destinations, one bar at a time

[claim · 20/28 · max 2 lines, 62ch]
The phone is read in the order the work happens: what arrived,
is the gateway alive, what answers, configuration.

[dock strip · y=300 · four items at 1:1 · 90dp each]
Threads        Device        Flows        Settings

[frames · y=380 · four 360×800 frames at 1.4×, left of the text]
  A Threads      B Conversation      C Device      D Flows

[three lines · x=740 · 15/22]
One row per peer. Unread is a number.
Five states, the SIM, the queue. A dot, no count.
Inside a thread the composer is the bar. No dock.

[footer · 13px mono]
Left to right: the order a message travels. 01 §2.1.
```

Word count: title 6 + claim 19 + the three right-hand lines 28 + footer 7 (citation not
counted) = **60 words**, plus four frames and the dock strip (labels are not prose).

**Must NOT be on slide 4**

- Five tabs, a "More" tab, or a compose FAB. `01` §2 bans all three with a reason each;
  90dp per item at 360dp is the budget and five items spend it.
- A tab called **Automation**. The phone cannot execute rules (`WAVE2` §7); labelling it
  Automation is the same scope lie `CONSOLE_UX` §1 was written to kill.
- Contact names, initials or avatars for a phone number. `READ_CONTACTS` is not in the
  manifest (`WAVE2` §3), and `DESIGN_2026` §3 forbids a number as decoration.
- One chip carrying both message axes. Delivery (`queued/sent/failed`) and answering
  (`answered by flow · wf_gate v2`) are two lines, not one chip (`01` §3.2).
- The current 658-line bench — target URL, pair code, device list, carrier inject and a
  raw thread dump on one scroll (`02` §2.1). Pairing is the onboarding, not a tab.
- Any console screen, or the workflow canvas (`CONSOLE_UX` §7 defers canvas editing).
- A competitor screenshot as "reference". The product must not look like WhatsApp
  (`01` §4, last row), and a reference image argues for the thing being rejected.
- Dark frames, for the same reason as slide 2.
- The empty state's mascot. It is one of four empty variants (`02` §2.2, item 9) and
  deserves a line, not a quarter of the slide.

---

## 3. Slide 5 — the send/receive state machine, as a diagram spec

This is the only slide that must be built to a spec rather than composed. It exists
because the deck cannot answer "is this working?" without it, and because the current
mockup already gets it wrong: `design/preview.html:369` prints **`delivered`** for a flow
reply, a state the device store refuses (`simulator/core/src/db.rs:692`).

### 3.1 Canvas

- 1280×720. Diagram box 1136 × 440 at x=72, y=200. Title above, invariants below.
- Six columns of 176 with 16 gutters: `6×176 + 5×16 = 1136`. Two lanes of 168, 48 apart.
- One column = one hop. **Left to right is time, not a sequence diagram** — the second
  lane is the same message seen by the Worker, and it is empty for the first two hops,
  which is the offline guarantee, not a delay.
- Node: `--df-surface-card`, 1px `--df-border-hairline`, radius 12, padding 12. State
  word in 11px mono uppercase; one line of detail in 13px sans, max two lines.
- Lane A (device) sits on `--df-surface-card`; lane B (Worker) on `--df-surface-well`.
  **One peach node only** — the failure exit — and it is the only saturated colour on
  the slide.
- Arrows: 1.5px `--df-text-meta`, 6px head. Solid = shipped at the 2026-10-29 gate.
  Dashed 4/4 = specified, not yet true. No curved arrows, no crossing arrows.

### 3.2 Lane A — the device (Kotlin receiver → Rust core, no Tauri runtime)

| # | State word | What happens | Code |
|---|---|---|---|
| 1 | `RECEIVED` | `SMS_RECEIVED` arrives with no Activity and no webview; `goAsync()` keeps the broadcast alive while a worker thread runs; multipart parts are concatenated per sender. | `SmsReceiver.kt:29–98`; `WAVE2` §2 |
| 2 | `STORED` | The inbound row is written **before** any flow runs, state `received`. `local_id` derives from the PDU timestamp + sender, so a re-delivered broadcast cannot double-insert. | `carrier.rs:85–93`, `:232`; `WAVE2` §4 |
| 3 | `FLOW` | `run_flows` against the flows cached on the device. No synced flows = zero actions — the phone still receives and stores, and answers nothing. | `carrier.rs:117–230`; `WAVE2` §7 |
| 4 | `QUEUED` | An outbound row is written `queued` with `local_id = native-…`. It is not `sent` until the radio call returns. | `carrier.rs:171–176`; `SmsReceiver.kt:166–169` |
| 5 | `SENT` | `SmsManager` returns → `markOutbound("sent")`. A throw, or a refused sender, → `failed`. A mark failure leaves the row `queued`, never `sent`. | `SmsReceiver.kt:151–170`, `:198–204` |
| 6 | `FLUSH` | `flushPending` uploads pending inbound, their flow runs and unmirrored outbound in **one** `upload_batch`; then `received → uploaded` and outbound `mirrored = 1`. Best effort: a failure leaves the rows pending. | `carrier.rs:464–523`; `android.rs:107–153` |

Failure exit **F** (one node, below lane A, between columns 4 and 5): `FAILED` — "never
mirrored, never history." Reached from three places, all dashed: a declined sender
(`skip=self | mask | shortcode | no_send_permission`, `SmsReceiver.kt:111–142`), a target
that is a mask or shortcode (`:144–149`), and `SmsManager` throwing (`:159–164`). The row
is deliberately excluded from the mirror (`db.rs:557–571`), so a declined reply cannot
appear in the console as something that happened.

### 3.3 Lane B — the Worker

| # | State word | What happens | Code |
|---|---|---|---|
| 1 | `—` | Nothing. The Worker never sees the PDU. | — |
| 2 | `—` | Nothing. Local storage is authoritative until the flush. This is the offline path. | — |
| 3 | `RULES → FALLBACK` | Only for rows with `auto_reply_sent` false. Rules run by `priority DESC` inside cooldown and hourly cap; a rule that replied removes that row from the flow fallback. | `incoming.ts:316–344`; `CONSOLE_UX` §1 |
| 4 | `PENDING` | Only for a Worker-originated reply: a command is enqueued and recorded as an outbound `queued` row when the device polls. | `carrier.rs:377–430`; contract §6 |
| 5 | `SENT` | Command `ACKED_BY_DEVICE → SENT`. `DELIVERED` requires a carrier receipt and is **not true** at this gate — draw it dashed with the label `M5.5`. | `PROTOCOL_CONTRACT_V5.md` §6 (lines 317–336); `WAVE2` §5, §8 |
| 6 | `ROW` | D1 insert with `ON CONFLICT(device_id, local_id) DO NOTHING`; `reply_source` / `reply_ref` land on the inbound row. | `incoming.ts:236–288`; `0006_console.sql:31` |

### 3.4 Edges, and the two that go backwards

| From → to | Line | Label |
|---|---|---|
| A1 → A2 | solid | "persist first" |
| A2 → A3 | solid | "flows cached?" |
| A3 → A4 | solid | "send_sms action" |
| A4 → A5 | solid | "hand to radio" |
| A5 → A6 | solid | "best effort" |
| A6 → B6 | solid, crosses the lane | "one request" |
| B3 → B4 | dashed | "no rule replied" (device fallback only) |
| A4 → F, A5 → F | dashed | "declined / threw" |
| **B6 → A6** | **dashed, along the bottom** | **"flush retry · `poll_device`"** — the recovery sweep |
| **B5 → B5** | **dashed, self-loop** | **"receipt lands" — M5.5, not now** |

Those last two are the whole honesty of the diagram: one arrow that retries a failed
flush (`WAVE2` §8 — "`poll_device` is the safety net"), and one loop that does not exist
yet (M5.5). Everything else is one direction.

### 3.5 The vocabulary box (bottom right, 300 × 96)

Two vocabularies, two typefaces, never mixed:

```
message row    received · uploaded · queued · sent · failed        lowercase · sans
command        PENDING · DISPATCHED · ACKED_BY_DEVICE · SENT · DELIVERED · FAILED · EXPIRED
                                                                   UPPERCASE · mono
```

**The rule the slide teaches:** the bubble shows the *row* vocabulary, the console's
`CommandTracker` shows the *command* one, and `delivered` may not be rendered on a bubble
until M5.5 ships receipts. `03` §1.5 already defines
`--df-c-bubble-status-delivered-ink`; keep the token, do not render the word.

### 3.6 Invariants strip (three lines, 13px, under the diagram)

1. **One reply per message.** The device's reply sets `auto_reply_sent`; the Worker then
   skips rules *and* flows for that row (`incoming.ts:320`).
2. **A declined reply is `failed` and is never uploaded.** Nothing leaves the phone, so
   nothing enters history (`db.rs:557`).
3. **`sent` is the radio. `delivered` is the carrier.** Only the second is a promise, and
   it is not ours yet (`WAVE2` §5).

---

## 4. Slide 6 — the handoff checklist

Three columns, 1136 wide: **read** (4), **run** (3), **done** (11). One line each. No
paragraphs on this slide; the paragraph is the first line of the column.

### 4.1 What a contributor reads

1. `docs/CONSOLE_UX.md` — 128 lines. The pipeline, the five device states, the six
   metrics the console is allowed to claim. Read first; it is the product.
2. `docs/DESIGN_2026.md` — 141 lines. Tokens, the six named motions, and §6, the list of
   things the redesign may not touch.
3. `docs/WAVE2_NATIVE_SMS.md` — 249 lines. The receive path as built, the 2026-10-29 gate
   log, and §7–§8: what is still not true.
4. `docs/design-review/` — read in the order **03** (tokens) → **04** (composition) →
   **02** (components) → **01** (rules and bans). Each file states which question it owns.

Plus the one orientation sentence, set at the top of the column: *two apps, one token
file, one pipeline; rules run in the Worker, flows run on the phone, and a phone with no
synced flows answers nothing until an operator injects once from the carrier panel
(`WAVE2` §7).*

### 4.2 What a contributor runs

Each block is copy-pasteable and exists in the repo today.

1. **Build the console, and prove it is still static.**
   `cd dashboard && npm run build` — output must land in `worker/public/admin` with no
   new runtime dependency (`DESIGN_2026.md` §6). Then `npm run check` in `dashboard/` and
   in `simulator/` (`svelte-check`; both packages define it).
2. **Prove the store's state contract did not move.**
   `cd simulator/core && cargo test` — the tests at `db.rs:968–1049` are the contract:
   `queued | sent | failed` accepted, `delivered` rejected.
3. **Prove the receive path on hardware.**
   `source ~/.config/dakflare/android-env.sh` then
   `simulator/scripts/inject-sms.sh '+8801…' 'DAKFLARE-GATE-1 hello'` — rooted debug
   build, broadcast to the manifest receiver, real reply to the radio. **Only from a
   number you own** (`inject-sms.sh:11–20`).

### 4.3 How a contributor knows it is done

Eleven boxes. All pass/fail, none a matter of taste.

**Console**

- [ ] Both greps in `03-design-system.md` §2.4 return nothing, and the third returns only
      the sanctioned dark-block and component overrides.
- [ ] `design/preview.html` rendered at 1280: four bands, one hero number in tabular mono
      at ≥28px, one tinted container, one coral element, and the alert full-bleed with a 0
      gap under the header (`04` §6.1, §6.3, §4.5).
- [ ] At 25% (320px wide) the render still shows: the answer, the peach stripe, the state
      column, and three horizontal seams (`04` §6.1).
- [ ] Greyscale screenshot: every device state still readable as a word (`02` §5, `01` §4).
- [ ] The 2px focus ring is visible on cream, on pastel and in dark (`DESIGN_2026` §6).

**Phone**

- [ ] Every interactive target ≥48×48 with ≥8px separation, measured at 360×800.
- [ ] 360dp and 320dp: four dock items, labels on one line, nothing truncated (`01` §2.1).
- [ ] Keyboard open: dock gone, composer above the IME, no double inset (`02` §3.1–§3.2).
- [ ] Airplane mode: send reaches `queued` then `failed` with a reason, a retry, and the
      draft still in the field (`02` §7).
- [ ] App killed (`am kill`), one injected PDU: stored, flow ran, reply sent, and the
      console shows **both** rows (`WAVE2` §8).
- [ ] Android back: sheet closes the sheet, thread closes the thread, Threads keeps the
      app open.

**And the closing line, which is not a checkbox:** M5.3–M5.5 (foreground service, the
permission screen, receipts) are open. The redesign may not claim `delivered`, and the
deck must not be the place someone first reads it.

---

## 5. Should this be slides at all

**No — the canonical artifact should be one markdown page, not six slides.** Every claim
here is a citation to a line in `03` or `04`, and a 1280×720 slide drops the citation to
fit the table, so the deck will inevitably be re-derived from the docs it summarises. A
single `docs/design-review/README.md` holding the four tables — frozen/changing, the
three token fixes, the state matrix, the checklist — is greppable, diffable, and survives
the next change, none of which a deck does.

So this file is the canonical artifact: §1–§4 are the deck, §5 is the argument for reading
it as a document, §6 is what falls out of it. If a room is booked, **slides 2 and 4 only**
are the deck — twelve minutes, two yes/no questions — and slides 1, 3, 5, 6 are read
beforehand as sections of this file, not shown. If a room is never booked, nothing is lost.

What the deck genuinely buys, and a page does not: **the argument for the argument.** The
phone's IA and the palette values are both cases where the repo currently contains more
than one defensible answer (§6). Those need a room and a decision, and a decision slide
with "must not be on it" is a better meeting artifact than a document with a comments
section.

---

## 6. Four conflicts the deck closes — and one edit each

The deck is only useful if it settles what the four lane files currently disagree about.
These are the four a contributor hits in their first afternoon.

**1. Accent correction — two different recipes.**
`01` §1.3: `--accent #B93F22`, one token for text and fill (5.14 on page, 5.53 for a
label). `03` §4.6: `--accent-text #B23B20` + `--accent-fill #C9482A` (5.51 / 4.65), two
roles. **Ship `03`'s**, because it is the token owner and it separates "the word on cream"
from "the thing you press" — the distinction slide 2 makes in one line. Then `01` §1.3
gets a one-line pointer to `03` §1.3 instead of a second value.

**2. Dock destinations — three answers.**
`01` §2: Threads · Device · Flows · Settings. `02` §2.1: Messages · Device · Settings
(three). `03` §1.5: Threads · Devices · Alerts · Settings. `04` §3: frames A–D, with the
fourth being Automation. **Ship Threads · Device · Flows · Settings** — four, because the
phone owns a run log; *Flows* and not *Automation* because rules do not run here
(`WAVE2` §7); no *Alerts* tab because an alert is a fact about a device and belongs on
every frame as a banner (`CONSOLE_UX` §3, `01` §2). `03` §1.5 and `02` §2.1 each need the
one-line edit before the route tree is cut.

**3. Thread row height — 72 or 76.**
`04` §3.1: 72, nine rows in the 648 scroll region. `02` §2.2: 76, described as "48dp of
target plus two lines at 1.4" — which arithmetically lands at 88, not 76. **Ship 72**,
because it divides the scroll region exactly and the 76 in `02` is a rounded guess.

**4. `delivered` on a bubble — three files, three positions.**
`03` §1.5 defines the token; `02` §2.2 says the store refuses the state and there is no
double tick; `04` §3.2 prints the word on frame B; and the mockup already ships it
(`design/preview.html:369`). **Keep the token, render three words** (`queued`, `sent`,
`failed`) until M5.5 receipts exist. The token is a reserved slot, not a shipping state.

None of these four is a design opinion. Each is a place where the repo would otherwise
produce two implementations, which is the defect `03` §0 counted 64 times.
