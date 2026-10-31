# 04 — Composition: the eleven principles applied

Status: proposed 2026-10-29. Review only. No application file was changed to produce
this document; every measurement below was read from source or taken from a headless
render of `design/preview.html` at 1280×2600, then downscaled to 25% and blurred for
the squint test.

Read for this review: `design/preview.html`, `docs/DESIGN_2026.md`,
`docs/CONSOLE_UX.md`, `dashboard/src/routes/+page.svelte`,
`simulator/src/routes/+page.svelte`, `simulator/src/app.css`.

Normative neighbours: `CONSOLE_UX.md` owns the pipeline, the five states and one reply
per message. `DESIGN_2026.md` owns tokens and the shell. `03-design-system.md` owns
token names and values. This file owns **composition only** — what goes where, at what
size, and why the eye lands where it lands.

---

## 0. The one-line finding

The direction has a voice, a palette and a vocabulary. It does not yet have a
**composition**: at the top of the page four equal cards carry four equal numbers in
the largest type on screen, two of them tinted for no operational reason, and the one
item that needs the operator — an open alert — is an 11px chip in the flattest card of
the row. Everything below that band is better than the band itself.

---

## 1. What already works

1. **The Phones list is the best region on the page.** 1px rules, 12px row padding, no
   zebra, mono under the name. It is the only region whose structure survives both the
   blur test and the 25% test, because its rhythm is repetition, not decoration.
2. **Mono is used functionally, not as costume.** Device ids, masked numbers, ports and
   timestamps are mono *because* an operator compares them character by character. This
   is the one place the mockup obeys "functional type choices" without argument.
3. **One chip shape, five words, a dot.** `live / synced / stale / offline / unknown`
   are the same geometry everywhere and carry a shape plus a word plus a colour — three
   cues for one meaning, which is exactly what a state needs. Do not redesign these.
4. **The 8/4 split for Phones + quiet is a real asymmetry.** It gives the list the width
   it needs instead of splitting the page in half. Keep the 8/4 idea; generalise it.
5. **Accent discipline is close to correct.** Coral appears on one button, one unread
   dot and one active nav item; the active nav uses `--accent-soft` rather than the
   fill. That restraint is why the phone's coral button still reads at 25%.

---

## 2. The eleven principles, one verdict each

Verdicts: **holds** · **partial** · **fails**. Every row names the region.

| # | Principle | Verdict | Where it breaks | The fix |
|---|---|---|---|---|
| 1 | Few column patterns | partial | Four card spans (3/4/8/12), but **six** distinct content templates on Overview: bento 12-col, `.devrow` `22px 1fr auto auto`, `.msg` `56px 1fr auto`, `.board` 4×`1fr`, lane cards 1-col, `.quiet` centred. The automation board is a second page grid nested inside a 12-col card. | Three row templates, named once: **data row** (glyph · text · chip · meta), **text row** (glyph · body · meta), **split row** (1+3). Anything else is a bento cell, not a row. |
| 2 | Protect outer margins | fails | `.content` padding **24** vs `.bento` gap **16** is 1.5:1 — not visibly larger. At ≤900px it drops to 14 vs 14: **1.0**, so the margin stops existing exactly where the screen is most crowded. Phone: screen padding 20/18 vs sheet gap 14 → 1.3:1. | 32 / 16 desktop, 24 / 12 tablet, 16 / 8 compact. The ratio stays 2:1 at every breakpoint, so "outer margin" is a property of the system, not of one viewport. See §4.2. |
| 3 | Spacing in multiples of one base | fails | Nine off-scale values in the preview: card padding **18**, row/header gaps **14**, chip padding **3/9**, field padding **9/11**, brand padding **6 8 16**, board gap 12 (fine) but lane padding **10**, greeter margin **2**, stat gap **10**. `--s-1..--s-8` exists in the token doc and is not used here. | Base 4. Steps only 4/8/12/16/24/32/48. Card padding 20 (= gap + 4), row padding 12, chip 4/8, input 8/12. §4.2 is the whole scale. |
| 4 | Asymmetry directs attention | partial | The **stat row's four equal 3-col cards give no focal point** — the flattest possible arrangement, placed at the first fixation. The 8/4 split below proves the team can do it. Verified by blur: the eye lands on the mint card, then the butter card, then the mascot — three decorative objects, in that order. | Replace 3+3+3+3 with **6+3+3**: availability as a hero (6 cols, its own sentence), two supporting figures. Drop the fourth card entirely (see §5.1). |
| 5 | Hierarchy before decoration | fails | Largest type on the page = four equal numerals at **34px**. Page title = 26. The one actionable alert = an **11px chip**. The mascot occupies 120×96 in a card that also holds the page's only CTA; the "Needs you" card is the same size as "Replies sent". | One number per screen may be large (28–40), and it is the one that answers the screen's question. Alert state gets fill and position, not size — but it must be *first* in reading order. |
| 6 | Align related elements | fails | Three concrete misalignments: (a) the four stat **footnotes sit on different baselines** — card 3's note wraps to two lines, so its first line starts ~10px above card 1's single line; (b) each `.devrow` is its own grid, so the chip column is sized per row — it reads aligned today only because three state words happen to be similar widths, and breaks the moment a row carries `offline` **and** `poll-only`; (c) in "Latest message", the `18:42 · +8801•••6080` meta is flush to the card edge while the body starts 14px inside the well. | One shared grid for a list (`grid-template-columns` on the container, rows as `display: contents` or subgrid). Fixed internal slots in a stat card: label y=0, number y=24, note y=64 — a 3-slot card, not a flex stack. |
| 7 | Repeat a few visual cues | partial | Cues exist — chip, hairline, mono, eyebrow — but **eleven distinct fills** appear on one screen (bg, surface, surface-2, surface-3, mint, butter, sky, lilac, peach, accent-soft, accent-fill). When every container has its own tint, tint stops being a cue and becomes a spectrum. | Three planes (bg, surface, surface-2) plus **at most two** state tints per screen. A container is tinted only if a state an operator acts on lives inside it. |
| 8 | Contrast separates roles | fails | Page / group / row / chip are separated by `#E7DCCB` at 1px and a 6%-opacity shadow. In the 25% render the card edges disappear and only the pastel blocks survive — so the contrast budget is spent on the two blocks that mean the least. Meanwhile pastel sits only ~6% luminance from cream: strong enough to survive a thumbnail, too weak to encode a role. | Roles get **different treatments, not different values**: page = bg, no border; group = surface + hairline; row = hairline rule only; state = fill. Fill is reserved for state. §4.3. |
| 9 | Functional type choices | partial | Mono is right. But the stat numerals are **proportional sans at 34/650/−0.03em**: `18` → `118` reflows the card and the sparkline jumps. The greeting is an `h1` at 26 in a one-operator console — a person's name is the largest text in an ops surface. Eyebrows are 10px at .12em, below what anyone reads at arm's length. | Stat numerals become **tabular mono at 28/600**, so a value can change without moving. Page title 24/600 sans. Eyebrows 11px, max three per screen. |
| 10 | Intentional negative space | fails | Three accidental voids: ~140px empty under the quiet card's CTA at the height its neighbour sets; ~360px empty in the phone-strip's right column under three bullets; the "Live on the phone" lane holding one card in a lane sized by the tallest of four. Separately, the phone's four sheets are 14 apart inside a 18–20 inset, so the stack reads as one continuous block with seams rather than four objects. | Negative space is either a **gap step** (8/16/24/48) or a **centred statement** — never leftover height. Cards in a row share a top and a bottom, and their content is distributed by slot, not by `gap`. |
| 11 | Review at final size | fails | At 25% (thumb): four numerals, two pastel blocks, four lane fills, the phone's coral button read. The alert, the five device states, the pipeline and the "Needs you" number do not. The page is composed for a screenshot, not for a glance from across the room. | Budget: **3 numbers ≥20px**, **1 tinted container**, **1 accent element**, **4 bands** per console screen. §6. |

---

## 3. Four phone frames at 360 × 800

### 3.0 Shared chrome and grid

One grid for the whole app — **one column pattern**, which is the point:

```
content 312 = 4 × 72 + 3 × 8        (360 − 2 × 24)
side margin 24 · top inset 24 · dock 56 at y=728 · bottom inset 16
screen header 56 (y 24–80) · scrolling region y 80–728 (648) · dock y 728–784
```

- **Type ramp (six sizes, two weights).** 28/34 600 (the screen's answer, ≤1 per screen);
  20/26 600 (screen title, ≤1); 15/20 600 (row title, peer name); 14/20 400 (body);
  12/16 400 (meta); 11/14 600 (label, ≤3 per screen). Weights 400 and 600 only — 700 is
  reserved for a chip's single word at 11. Mono 12/16 for ids, numbers, times.
- **Spacing.** 4 / 8 / 12 / 16 / 24 / 32. Row height 72. Nothing else.
- **Colour budget.** One tinted container per frame. One coral element per frame, and
  for two of the four frames that element is *absent* — stated per frame.
- **Dark mode.** Tints become the same hue at 12% alpha, ink stays, coral stays, mono
  stays. No frame changes its geometry in dark; if one did, the spec would be wrong.
- **Dock.** 4 items, centres at x = 63 / 141 / 219 / 297. Icon 20, label 11/14 at +8.
  Active = ink + 600 + a 24×3 coral rule at the dock's top edge over that item. That is
  two cues plus a shape cue, so the state is not colour-only.

---

### 3.1 Frame A — Threads

**Focal:** the one unread thread — a 4px coral rule at x=20 (it reaches 4px into the
margin, the only element allowed to) plus the only mint fill on screen.

| Zone | y | Height | Grid / x | Type |
|---|---|---|---|---|
| Header | 24–80 | 56 | title x24, meta right-aligned x336 | `Threads` 20/26 600; `live 2/4` 12 mono |
| List | 80–728 | 648 | 9 rows × 72 | — |
| Row | — | 72 | avatar 40 at x24–64, gap 12, text x76–288, time col x288–336 | name 15/20 600; preview 14/20 400 `--ink-2`, one line, ellipsis; time 11 mono `--ink-3` top-right; unread count 20×18 mono 11 in mint, bottom-right |
| Separator | — | 1 | x76 → x336 | `--line` |

Separators start where names start and run to the right margin — the left inset is the
alignment cue, used once and everywhere. No per-row cards, no avatar ring, no chevron.

**Reading order:** newest-first, so the operator answers "who is waiting on me" before
"who wrote" — the unread row is first because it is newest, and marked because it is
unanswered.

---

### 3.2 Frame B — Conversation + composer

**Focal:** the most recent outbound bubble and its single status word. If a send failed,
that bubble is the only peach fill and the only place coral appears.

| Zone | y | Height | Grid / x | Type |
|---|---|---|---|---|
| Header | 24–80 | 56 | chevron 20 at x24, name x56, icon 20 at x316 | name 15/20 600; sub 11 mono `Mi A3 · +8801•••2829` |
| Thread | 80–664 | 584 | bubbles max 248 | body 14/20; meta 11 mono under the last bubble of a run |
| Day divider | 80–120 | 40 | centred | `Today 18:42` 11 mono `--ink-3`, 16 above and below |
| Composer | 664–728 | 64 | input x24–288 (40 tall), gap 8, send 40 at x296–336 | input 14; top hairline at 664 |

- Inbound bubbles: left edge x=24, max width 248 → they never pass x=272, leaving a
  64px clearance on the right. Outbound: right edge x=336, minimum left x=88. The 64px
  clearance is what makes the side legible at a glance; it is not padding.
- Bubble: padding 12/10, radius 16 with the corner nearest its speaker at 6. One
  asymmetry per bubble, and it is semantic (it points at who spoke), not decorative.
- Runs: 4 between bubbles of one speaker, 16 between speakers, 24 around a day divider.
- Composer sends coral only when the field has content; empty state is a 40px circle
  with a `--line-strong` ring and an `--ink-3` glyph, so coral always means "there is
  something to send".

**Reading order:** who I am talking to → what they last said → what this phone did with
my reply → where I type. The status word sits closer to the bubble than the timestamp,
because "delivered" is the fact and "18:42" is the record.

---

### 3.3 Frame C — Device / status

**Focal:** the tinted state block. This is the one frame with **no coral at all** — its
accent budget is spent on the state fill, because the screen's question is a state, not
an action.

| Zone | y | Height | Grid / x | Type |
|---|---|---|---|---|
| Header | 24–80 | 56 | name x24, mono sub | `Pixel 8` 15/20 600; `devaed94…` 11 mono |
| State block | 80–248 | 168 | spans 4, radius 20, padding 20 | state word 28/34 600 + 10px beacon; sentence 13/18, ≤2 lines; `last seen 16 h ago` 12 mono |
| Rows | 264–600 | 6 × 56 | label col 1 (72), value cols 2–4 (232), rules x24→336 | label 11/14 600 uppercase `--ink-3`; value 14 (mono for phone, id, version) |
| Wake note | 616–664 | 48 | spans 4 | 13/18 `--ink-2`, 2 lines |
| Actions | 664–728 | 64 | button 44 full width, text button below | `Mint a code` 14/600 on surface + hairline; `Forget device` 13 `--ink-3` |

Fill maps to state and only to state: mint (live/synced), butter (stale), peach
(offline), stone (unknown). `offline` **and** `poll-only` is the one combination that
adds a second line of prose inside the block — the combination, not the word, is the
alert. Rows are label/value pairs, not cards: six cards would be six focal points.

**Reading order:** is this phone answering → on what carrier and number → can it be
woken → when did we last speak → what I can do about it.

---

### 3.4 Frame D — Automation

**Focal:** the pipeline statement — the only tinted block, 88px tall, three lines at
13/18. It is the screen's answer, so it gets the fill and the top of the content.

| Zone | y | Height | Grid / x | Type |
|---|---|---|---|---|
| Header | 24–80 | 56 | title x24, meta right | `Automation` 20/26 600; `2 rules · 3 flows` 12 mono |
| Statement | 80–168 | 88 | spans 4, butter, radius 12, padding 16/20 | 13/18: rules answer first, flows are skipped if a rule replied, one reply per message |
| Label `Rules` | 184–208 | 24 | x24 | 11/14 600 uppercase |
| Rule rows | 208–352 | 2 × 72 | name x24, limits right x336 | name 15/20 600; matcher 12 mono; `prio 10` / `5 / 60 min` 12 mono |
| Gap + label `Flows` | 376–400 | 24 | — | 11/14 600 |
| Flow rows | 400–616 | 3 × 72 | name x24, chip right x336 | name 15/20 600; `keyword → reply` 12; chip `on phone` 11/700 lilac |
| Add | 632–680 | 48 | spans 4 | `New rule` 14/600, coral text, no fill |
| Tail | 680–728 | 48 | — | deliberate: the dock must not crowd the last row |

Rules and flows are the same row shape with different right-hand content — that is the
whole distinction on screen, and it matches `CONSOLE_UX.md` §1: same pipeline, two
authored forms. No lanes. A lane board would have to invent a fifth column for "draft",
which is a stage, not a form, and the mockup already does exactly that (§5.3).

**Reading order:** what will answer a stranger → in what order it is tried → then the
list of what exists, rules before flows because that is the order they run in.

---

## 4. The bento, as numbers

### 4.1 Column patterns — five, and no others

`12 · 8 · 6 · 4 · 3`. A document column of 5, 7, 9 or 10 is not a pattern, it is a
one-off; if a screen needs one, the screen is wrong.

At 1280 frame width: 1280 − 248 sidebar = 1032; − 2×32 margin = **968 content**; 12
columns of 66 with 11 gutters of 16. Span widths: 3 = **230**, 4 = **312**, 6 = **476**,
8 = **640**, 12 = **968**. Every legal row sums to 968: 476+16+230+16+230,
640+16+312, 230×4+16×3.

### 4.2 Margin, gap and padding — one ratio, three breakpoints

| Breakpoint | Outer margin | Gutter (within group) | Group gap | Card padding | Ratio |
|---|---|---|---|---|---|
| ≥ 1100 | 32 | 16 | 24 | 20 | 2.0 |
| 720–1099 | 24 | 12 | 20 | 16 | 2.0 |
| < 720 | 16 | 8 | 12 | 12 | 2.0 |

Outer margin is always exactly twice the smallest internal gap, and always larger than
card padding. Steps are 4/8/12/16/20/24/32/48 — one base, eight steps, nothing between.

### 4.3 Roles get treatments, not values

| Role | Treatment | Never |
|---|---|---|
| Page | `--bg`, no border | tinted |
| Group (card) | `--surface` + 1px `--line` + radius 20 | shadow |
| Well (in-card) | `--surface-2`, no border, radius 12 | border + shadow |
| Row | hairline bottom only, inset to the text edge | card, zebra |
| State | fill (mint/butter/peach/lilac/stone) + dark ink | pastel ink on pastel for a number |
| Floating layer (composer, popover, dock) | `--shadow-2` + hairline | on a static card |

Radius ladder: 20 card → 12 well → 8 input. One step of 4 between each, so nesting is
visible without a border. `--shadow-1` is retired from static cards; a 3% shadow on a
cream page is a fifth way to say "card" when the hairline already said it.

### 4.4 Span map

| Screen | Row | Spans |
|---|---|---|
| Overview | alert banner | 12, full-bleed (§4.5) |
| | band | 6 + 3 + 3 |
| | fleet | 8 + 4 |
| | automation | 12 |
| | thread | 8 + 4 (empty/quiet) |
| Devices | alert row | 12 |
| | fleet table | 12 (rows, not cards) |
| | device detail / facts | 8 + 4 |
| Messages | filter rail | 4 + 8 (log) |
| | thread preview | 12 |
| Automation | statement | 12 |
| | tabs | 12 |
| | authored list | 8 + 4 (test panel) |
| Alerts | open | 8 + 4 (history) |

Three numbers in the whole map are not a span: 230, 312, 640, 968. A screen that needs a
fourth is a screen that needs a different row.

### 4.5 The one place to break the grid

**The alert banner, and only the alert banner.** It takes the full bleed: left and right
to the frame edge, text still inset 32, no top gap under the 64px header, radius 0,
`--peach` fill. It is the only element in the console that touches three edges, which is
why it reads at 25% and why the operator cannot walk past it. `DESIGN_2026.md` §4 already
grants one full-bleed moment per page; this is the number for it: **bleed 32, gap 0.**

Every other asymmetry is a span, not an overlap. No negative margins, no cards over
cards, no diagonal flow: this is a surface someone checks at 7am before coffee.

---

## 5. The three places this reads as generated

### 5.1 Colour as decoration: the pastel rainbow

**The tell.** Overview carries eleven fills, and the four stat cards are tinted in a
pattern with no rule: mint (healthy — correct), butter (**"Replies sent", which is not a
warning**), white, white. The one card that is a warning, "Needs you", is the plainest
in the row. Directly below, the automation board tints four lanes lilac / butter / sky /
mint, so a board of *stages* is colour-coded like a board of *states*. A reader learns
in ten seconds that colour means nothing, and never unlearns it.

**The fix.** Two rules, checkable in review: (1) a container is tinted only if a state an
operator acts on lives inside it — otherwise `--surface`; (2) at most two tinted
containers per screen. Under those rules Overview keeps exactly one (the alert, when
`open_alerts > 0`) and the automation board loses all four lanes. The mute of a
deliberately grey console is what makes one peach block read as an alarm.

### 5.2 The uniform card grid

**The tell.** Every region is the same rounded rectangle: 20px radius, 1px border, 18px
padding, 6% shadow, a 10px uppercase eyebrow, a 15px 650 title. Four bands of identical
boxes with identical headers is the default layout of every generated dashboard, and it
is why the page looks calm at 100% and shapeless at 25%. The "Motion & colour" card makes
it explicit: a full 12-column band of colour swatches is a palette *demo*, not a console
screen, and in the mockup it is the second-largest block on the page.

**The fix.** Two container types, not one repeated: **plane** (surface-2, 12 radius, no
border, no shadow — for anything that is a group of rows) and **sheet** (surface, hairline,
20 radius — for anything that is a single statement). Dense lists stop being cards
entirely and become rows on the page with rules, which `CONSOLE_UX.md` §4 already asks
for and the preview does not do. Delete the swatch card; delete the eyebrow from every
card but one per screen.

### 5.3 Warmth standing in for hierarchy

**The tell.** "Good evening, Jony" as the `h1` at 26px, a 120×96 mascot at the top of the
fold, "Nothing is on fire", "Alerts land here, not in your sleep", and sidebar groups
named "Console" and "Bench". The voice is doing the work the composition has not done:
the largest words are a greeting and a joke, and the operator's actual question — *are
the phones answering?* — is a 34px sans **2** in a mint box beside a 34px **18** in a
white box. `CONSOLE_UX.md` §3 then forbids this mascot from ever appearing beside an
error, so the one frame where a friendly face would be earned is the one it cannot enter.

**The fix.** Three substitutions, no new assets: the page `h1` becomes the operational
sentence — *2 of 4 phones answering* — at 24/600 with the count in tabular mono; the
greeting moves to a 12px `--ink-3` line in the header's second row; the mascot stays (it
is good) but at **72px**, in the empty state only, with literal copy: *No open alerts.
Last checked 18s ago.* Warmth survives as a 12% tint and one doodle; it stops being the
thing the eye lands on first.

Two smaller ones worth naming while here: the header shows four avatars for a fleet of
four that reads `M3 P8 A2 +2` — five; and `Flows` exists as a sidebar item, as a board
lane and as `flows 3` in one card, while `CONSOLE_UX.md` §4 calls the same object
*Workflows*. Both erode trust faster than any spacing value.

---

## 6. The thumbnail test

Method: the 1280-wide render downscaled to 25% (320px), then blurred at 6px for the
squint pass. A region passes only if it is still *identified*, not merely *visible*.

### 6.1 Must still read at 25% — console

1. **The answer**, once: `2 / 4` in tabular mono, at least 28px — a shape, not a word.
2. **The alert**, as a peach band touching three edges with 0 gap under the header.
3. **The fleet's state column**, as dot + word repeating down a single column. The
   repetition is what reads; the individual rows are not required to.
4. **The band structure**: 6+3+3, then 8+4, then 12 — three horizontal seams, so the page
   has a shape before it has text.
5. **The active nav item**, as the only `--accent-soft` rectangle in the rail.

### 6.2 Must still read at 25% — phone (90px wide)

1. The dock, as four marks with one coral rule over the active one.
2. One tinted block per frame: the unread row (frame A), the failed bubble (B), the state
   block (C), the pipeline statement (D).
3. The composer's coral send button — the only saturated dot in the lower third.
4. The row rhythm of a list: nine 72px rows is a texture; seven 60px rows is a different
   texture. Row height is a design decision, not a byproduct.

### 6.3 What to remove to keep it readable

| Remove | Because | Saves |
|---|---|---|
| The "Motion & colour" swatch card | it is a palette demo, not a screen | a full 12-col band |
| The 70×34 sparkline | at 25% it is a 17×8 smudge; at 100% it is 18 points of noise beside a number that already says 18 | the least legible object in the stat band |
| The fourth stat card ("Replies sent") | it restates "Messages · 24 h" and it is the card wearing butter for no reason | one equal card; makes 6+3+3 possible |
| The per-row device avatar | it duplicates the device id one line below it and breaks the chip column (principle 6) | a 28px column |
| The eyebrow on 6 of 7 cards | a label above a title above a number is three lines to say one thing | ~120px of vertical rhythm |
| The second nav group ("Bench") | `Activity` and `Flows` are pages, not a second information architecture; `Flows` already exists inside Automation | 88px of rail |
| The 120px mascot | at 25% it is a blob; at 100% it is the strongest object in the upper half and it is not information | 120×96 |
| Four lane fills | four tints on a board of stages | the entire "colour means nothing" problem |

After removal, Overview has **four bands, three numbers ≥20px, one tinted container and
one coral element** — and the 25% view is: a peach stripe, a big `2/4`, a list with a
state column, a board. That is a page.

---

## 7. Handoff

Nothing here requires a new token, a new icon or a new component. It requires:
`--s-*` to be used instead of hand-written values (§4.2), one row template per list
(§2.1), the stat band to become 6+3+3 with one hero number in tabular mono (§5.1), one
tinted container per screen (§5.1), and the phone built on the single 4-column grid in
§3.0. `03-design-system.md` already carries the names for all of it.
