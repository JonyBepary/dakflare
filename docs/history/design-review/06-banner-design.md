# 06 — Banner design: the four assets this product actually needs

Status: review, 2026-10-29. Read-only on application code; this file is the only change.
Lane: brand assets and illustration. Tokens are `docs/DESIGN_2026.md`; this document
consumes them and does not restate them.

**No image-generation tooling is available in this session.** Everything below is art
direction plus SVG-ready specification: exact coordinates, stroke values, token colours
and the contrast arithmetic behind them, so each asset can be drawn or pasted as-is.
Where a value is a judgement call it is marked *optical*, not measured.

Read for this review: `docs/DESIGN_2026.md`, `docs/CONSOLE_UX.md`, `design/preview.html`
(the mascot at lines 378–387), `simulator/.../res/` (all four `drawable*` files, all five
`mipmap-*` sets, `AndroidManifest.xml`, `values/themes.xml`),
`dashboard/src/lib/assets/favicon.svg`, `dashboard/src/lib/components/Brand.svelte`,
`dashboard/src/lib/components/QrCode.svelte`, `dashboard/src/routes/devices/+page.svelte`
(the mint panel, lines 435–720), `README.md`.

---

## 0. Verdict, in five lines

1. **The brand mark is currently three different marks.** A navy analytics favicon
   (`#2f42c4`, three white bars), three white bars on `--accent-soft` in `Brand.svelte`,
   and a coral "flare" glyph in `design/preview.html` that nothing in the app renders.
   The icon work is not "draw an icon" — it is *retire two marks*.
2. **The Android icon in the tree is the Tauri robot** on `#3DDC84` with a template grid,
   and there is **no `mipmap-anydpi-v26/` adaptive descriptor**, so the 108/162/216/324/432
   foreground PNGs are never read. Every device shows the robot.
3. **The icon should not be the mascot.** A face is unreadable at 24px and cannot carry
   monochrome. The icon is an *object*: a phone slab with one coral broadcast arc.
4. **The console already has a functional QR pairing panel**; what it lacks is a thing to
   hand a stranger. One card at 1080×1350 (functional) and one at 1200×630 (reference
   only, never claimed to scan) — not a campaign.
5. **Four empty-state drawings, one mascot.** The mascot goes to "no alerts", because a
   cheerful character next to "no messages yet" would imply health that has not been
   proven — the failure `CONSOLE_UX.md` §3 exists to prevent.

---

## 1. What is actually in the tree

| Asset | What it is | Verdict |
|---|---|---|
| `res/drawable/ic_launcher_background.xml` | `#3DDC84` fill + 32 hairline grid paths from the Tauri template | Delete. It is another product's asset. |
| `res/drawable-v24/ic_launcher_foreground.xml` | White Android robot + a `aapt:attr` gradient shadow | Delete. Two deletions, no salvage. |
| `res/mipmap-*/ic_launcher{,_round}.png` | 48/72/96/144/192 robot bitmaps | Replace. These are what actually ships. |
| `res/mipmap-*/ic_launcher_foreground.png` | 108/162/216/324/432 transparent PNGs | Unreferenced. No `mipmap-anydpi-v26/` exists. |
| `AndroidManifest.xml` | `android:icon="@mipmap/ic_launcher"`, no `android:roundIcon` | Add `roundIcon` + the adaptive descriptor. |
| `values/themes.xml` | `Theme.Material3.DayNight.NoActionBar`, no `windowSplashScreen*` | Android 12+ shows the launcher icon on a system splash anyway — the icon *is* the splash. |
| `dashboard/src/lib/assets/favicon.svg` | `#2f42c4` rounded square, three white bars | Wrong hue family, wrong metaphor. Replace. |
| `Brand.svelte` | Same three bars, `currentColor`, 16px grid | Replace with the wordmark + glyph in §2. |

There is also no `values/colors.xml` entry for any DakFlare colour — the shipped palette
in that file is Material's `purple_200`/`teal_700` defaults, unreferenced. A launcher icon
built on `@color/...` should introduce exactly two: `dakflare_field` and `dakflare_ink`.

---

## 2. One mark, two elements

Before the icon: the mark it reduces. `design/preview.html` line 242 draws a stem, a
shallow arc and a dot on a 24 grid, rendered at 20px — a 1.67px stroke and a dot 2.5px
across. It survives in a sidebar; it does not survive a status bar.

**Decision: the mark is a stem and an arc. The dot is retired** — from the sidebar glyph,
from the icon, from the splash, everywhere. One mark, drawn twice:

| Rendering | Where | Geometry |
|---|---|---|
| Glyph, 20px | sidebar `Brand.svelte`, favicon at 32, card corners | Stroke 2 on a 24 grid: dome `M7.5 8.5a4.5 4.5 0 0 1 9 0`, stem `M12 8.5V20` — a bar under a dome, no dot |
| Icon, 108dp | launcher, F-Droid 512, README | §3, concept **Torch** |

The glyph and the icon share the *dome over a stem* idea; the icon adds the phone because
an icon needs a subject, not a sigil. The three-bars mark in `favicon.svg` and
`Brand.svelte` is retired in the same change; keeping it would mean the tab, the sidebar
and the launcher all disagree, which is today's state.

---

## 3. App icon: three concepts

All three use the 108×108 adaptive canvas, field full-bleed, mark inside a **60dp circle
(r = 30) around (54,54)** — with a 3dp tolerance, because a phone slab's lower corners
reach 30.9 while the mask guarantees 33. That is stricter than the documented safe zone
(the inner 72dp box, and the ~66dp circle that every mask shape encloses) by enough to
absorb launcher parallax, which shifts the foreground a few dp. The three concepts differ
in *idea*, not in styling.

### 3.1 Concept A — **Torch** (recommended)

A phone, standing, with one coral broadcast arc leaving its top. No face, no check, no
notification dot (a dot on a phone reads as "you missed a call" — the opposite of this
product's promise).

| Element | Geometry (108 grid) | Token |
|---|---|---|
| Field | `rect 0 0 108 108` | `--bg` `#FBF6EE` |
| Slab | `rect x41 y40 w26 h42 rx9` | `--ink` `#241F1A` |
| Arc | `M46.5 34 a7.5 7.5 0 0 1 15 0`, stroke 5.5, round caps — a true semicircle, apex (54,26.5) | `--accent-fill` `#D9502C` |
| Gap | arc caps end at y36.75, slab starts y40 → 3.25 clear | — |

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108" role="img" aria-label="DakFlare">
  <rect width="108" height="108" fill="#FBF6EE"/>
  <rect x="41" y="40" width="26" height="42" rx="9" fill="#241F1A"/>
  <path d="M46.5 34a7.5 7.5 0 0 1 15 0" fill="none" stroke="#D9502C" stroke-width="5.5" stroke-linecap="round"/>
</svg>
```

Contrast inside the mark: ink on cream **15.2:1**; coral on cream **3.8:1** — over the 3:1
non-text threshold, and the arc is a 5.5dp graphic, not text. Cream on coral would be the
same 3.8:1; white on coral measures **4.1:1**, and `DESIGN_2026` §1 states 4.6:1 for that
pair. Worth correcting in the token table, because it is the number a future asset will
be built on.

**Why cream field, and the pair rule.** A cream field is unusual in a launcher and is the
honest reduction of the console. It needs something behind it: cream on paper, cream on a
white listing page, or cream on a white OG card is a shape with no edge (1.07:1). So there
are exactly **two variants**, and no third:

| Variant | Field | Mark | Use |
|---|---|---|---|
| Launcher | `--bg` cream | ink slab, coral arc | home screen, app drawer, dark surfaces, the Android 12 system splash |
| Ink | `--ink` | `--bg` slab, coral arc | paper, F-Droid's white listing page, README light hero, the pairing card |

The two are the same drawing with two fills swapped; a third tint (a mint field, a butter
field) is not a variant, it is a second brand.

### 3.2 Concept B — **Beacon** (the mark alone)

The house mark enlarged, no phone. Field `--surface-2` `#F6EFE3`; stem `rect 50.5 26 7 24
rx3.5` ink; shade = a downward semicircle centred (54,50) r16, stroke 6, ink (spans x38–70,
dips to y66); spark `circle cx54 cy76 r6.5` in `--accent-fill`.

- **192/108:** the most "brand" of the three, and the only one that needs no subject.
- **48:** every element survives the map — stem 4.7 wide, shade stroke 4.0, spark 8.7 dia.
  The failure is not rendering, it is meaning: a dome with a stem and a drop under it reads
  as an umbrella, a lamp, or a mushroom, and only the wordmark disambiguates.
- **Ink:** ~700 of 11,664 (6%) against Torch's ~1,180 (10%) — it sits lighter than its
  neighbours in a launcher grid.
- **Monochrome:** fine — three disjoint masses.
- **Loses on:** the silhouette. An icon whose meaning needs the wordmark underneath is a
  sigil, not an icon.

### 3.3 Concept C — **Relay** (the lane)

Two stations and a coral beam, on `--ink`. Station A `rect 34 52 20 20 rx6` cream (the
phone, near you); station B `rect 62 32 12 12 rx4` cream (the edge, far); beam a capsule
stroke 7 from (46,60) to (66,44) in `--accent-fill`, drawn *under* both stations so it
tucks beneath their edges.

- **192:** the most distinctive of the three and the best story — it is the name: station
  to station, and the architecture: device to edge.
- **48:** station A 13.3, station B 8.0, beam 4.7 thick and 8.9 long where it shows — three
  masses on a diagonal, and it is readable. What it loses is weight: ~620 of ink against
  Torch's ~1,180, so at 48 it is a sketch where its neighbours are solid, and the diagonal
  leaves two empty lobes (upper-left, lower-right) that a circular mask makes conspicuous.
- **Monochrome:** survives as three masses, but loses the coral that carried the meaning.
- **Loses on:** weight at 48 and mask balance — not on taste.

Relay is not thrown away: it becomes the **composition device** for wide assets (§4, §6) —
a lane that runs off the canvas edge. Rule: *the icon is an object, the lane is a
composition; never swap them.*

### 3.4 Recommendation

**Torch.** It is the only concept that (a) fills the circular mask with mass at the
centre, (b) has one object that survives 24 → 512 without a different drawing, (c) keeps
the mascot's slab and the preview's dome, so no fourth vocabulary enters the product, and
(d) says "a phone that transmits" without a face or a check.

*What would change this:* if the icon's main home ever becomes a listing grid (§6) rather
than a home screen, Relay's distinctiveness has more value than 48px legibility. It would
still need a horizontal lane and a bigger field, and it would still not solve the mask.

### 3.5 The size ladder, drawn — never scaled from a bitmap

**The mapping that is easy to get wrong.** A legacy icon shows the *visible* part of the
adaptive icon, so it maps the master's **central 72dp window (18 → 90) to the full icon**,
not the whole 108 canvas: `c′ = (c − 18) × size / 72`. Scaling the 108 canvas to 48 instead
draws the mark at 25% of the width and the icon looks a third smaller than its neighbours
in the launcher — a mistake worth writing down, because it looks plausible in a diff.

| Target | Use | Slab (x,y,w,h,r) | Arc ends | Stroke | Apex |
|---|---|---|---|---|---|
| 48 | mdpi legacy, favicon 48 | 15.5,14.5,17.5,28,6 | (19,10)–(29,10) | 3.5 | 5 |
| 72 | hdpi legacy | 23,22,26,42,9 | (28.5,16)–(43.5,16) | 5.5 | 8.5 |
| 96 | xhdpi legacy | 30.7,29.3,34.7,56,12 | (38,21.3)–(58,21.3) | 7.3 | 11.3 |
| 108 | design master, mdpi adaptive foreground | 41,40,26,42,9 | (46.5,34)–(61.5,34) | 5.5 | 26.5 |
| 144 | xxhdpi legacy | 46,44,52,84,18 | (57,32)–(87,32) | 11 | 17 |
| 192 | xxxhdpi legacy, README, F-Droid master | 61.3,58.7,69.3,112,24 | (76,42.7)–(116,42.7) | 14.7 | 22.7 |
| 162/216/324/432 | adaptive foreground (hdpi…xxxhdpi) | master × 1.5 / 2 / 3 / 4 | × density | × density | × density |

Verified against a render: at 48 the mark occupies 17×38 of 48 (35% × 79%), which is the
same proportion as the 108 master seen through a 72dp mask. The first draft of this table
read 12×26 (25% × 54%) — visually plausible, and wrong.

Rules that make the ladder survive:

- **Optical correction at ≤48:** the arc ends rise 0.5px rather than the arc shrinking; the
  3.25 gap of the master becomes 2.17 at 48, which antialiasing welds shut, so it is opened
  back to ~2.75. This is the one place the drawing intentionally deviates from the master.
- **Snap to the pixel grid at 48/72/96.** A 2.44px stroke becomes 2.5, never 2.4 — a
  fractional stroke on two edges is what makes a small icon look dirty.
- **No element below 2.2px at its target size.** If it would be, delete it. (The retired
  dot failed this at 48.)
- **Never re-export a 192 down to 48.** The 48 has its own numbers above.

### 3.6 Android adaptive split, and the layers nobody has built

```
mipmap-anydpi-v26/ic_launcher.xml
  <adaptive-icon>
    <background android:drawable="@drawable/ic_launcher_background"/>   full-bleed rect, #FBF6EE
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>   slab + arc, r ≤ 30
    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>   API 33+ themed icons
  </adaptive-icon>
```

- **Background:** a flat `rect 0 0 108 108`. No grid, no gradient, no pattern. It is
  cropped by the mask on every device and is not a design surface.
- **Foreground:** everything in §3.1 inside r = 30. The 18dp bleed on each side exists to
  be cropped, not to be used.
- **Monochrome:** a *separate drawing*, alpha only, tinted by the system. It is allowed to
  differ from the coloured layer — and must, because a 3.25 gap between arc and slab
  becomes a floating arc that reads as dust in a status bar. Close it:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" width="108" height="108">
  <rect x="41" y="40" width="26" height="42" rx="9" fill="#000"/>
  <path d="M46.5 38a7.5 7.5 0 0 1 15 0" fill="none" stroke="#000" stroke-width="6" stroke-linecap="round"/>
</svg>
```

- **Notification icon (24dp)** is a third drawing, same silhouette family: slab `rect 7.7 7.3
  8.5 14 rx3` plus a welded arc, stroke 2.2. It deviates from the ladder on purpose — at
  0.333 scale the master's 1.8 stroke would render as a grey smear. Minimum form 2.2px,
  never thinner.
- **`android:roundIcon`** must be added to the manifest, and the legacy PNGs regenerated
  from the ladder — today the round variant is a separate robot bitmap that will not match.
- **Themed icon check:** render the monochrome layer at 24px on a `--surface-2` plate and
  on `--ink`; if the arc separates from the slab on either, the gap is still open.

---

## 4. The pairing handoff card

The console already mints the right object — `minted.pairing_code`, a single-use
`dakflare://pair?u=…&c=…` deep link, `QrCode.svelte` at 184px with a 4-module quiet zone,
and a `pair-watch` that polls every 2s and expires. What is missing is the piece of paper
you put in someone's hand, or the full-screen view you show across a desk. Two formats,
two different jobs — this is the distinction that keeps it from becoming a poster.

### 4.1 1080×1350 — the functional card (4:5, on screen or printed)

| Zone | Content | Type |
|---|---|---|
| 0–72 | margin, all sides | — |
| top-left | Torch icon 96 in its **ink-field** variant (a cream icon would vanish on a cream card) + "DakFlare" 40/650, tracking −0.02em | sans |
| top-right | expiry chip: butter `#FBEBC8` fill, butter-ink `#7A5310` text, 26/700, r999 | — |
| y180 | Headline "Hand this phone a code." — 64/650, tracking −0.02em, max 2 lines | sans |
| y330 | "Open DakFlare on the phone → Pair with code → scan or type." 30/400, `--ink-2` | sans |
| y420–980 | QR plate 560×560, white `#FFFFFF`, radius 28, QR art 480×480 inside | — |
| y1010 | Code, mono 72/700, tracking .14em, grouped in fours (`A6C3 F079 1514`) | mono |
| y1100 | Worker host, mono 24, `--ink-3`, one line, ellipsis from the right | mono |
| y1160 | "Valid 15 minutes · single use · minted 18:42" mono 24 `--ink-2` | mono |
| y1250 | hairline rule 2px `--line` + write-in line, labelled "phone" in 22/600 `--ink-3` | — |
| left edge | a 6px coral lane entering from x=0 at y≈700, cropped by the margin, stopping at the QR plate | — |

The lane is the one flourish, and it is a *function*: it points at the QR. It also ties the
card to §3.3 without putting the icon concept on the card.

The write-in line is the difference between a print asset and a screenshot: the operator
writes "bench Redmi" on it, and the card stops being interchangeable.

Two print states, one design:

- **Live card** (screen, or printed inside the window): everything above.
- **Blank stock** (printed in advance, kept in a drawer): the QR plate is empty white with
  a 0.5pt hairline square and the words "mint a code at /admin/devices" at 24; the code
  line is a ruled blank; the expiry chip is blank. A pre-printed expired code is a lie
  printed on card stock.

### 4.2 1200×630 — the reference card, not a social post

Split 55/45: type block left, QR plate 300×300 right, top-aligned.

| Limit | Value | Why |
|---|---|---|
| Words | **≤ 22** on the whole card | At a 500px timeline render (0.42×) anything past the headline is 10px |
| Headline | ≥ 48/650, 2 lines max | Renders at 20px |
| Code | ≥ 40 mono/700 | Renders at 17px — the only element that must survive |
| Body | ≥ 24 | Renders at 10px; assume it is decoration |
| QR | 300×300, optional | **A QR in a 1200×630 that has been through platform recompression is not reliably scannable — the card is never captioned "scan me".** It is a shape that says "pairing", with the code beside it as the real payload. |

This is why the format exists at all: it is the OG image for the repo and the `/admin`
docs, where it renders at full width and the code is legible.

### 4.3 Contrast and text-size constraints (both formats)

Measured, sRGB, WCAG 2.1:

| Pair | Ratio | Allowed |
|---|---|---|
| `--ink` on `--bg` | 15.2:1 | anything |
| `--ink` on `--surface` | 16.1:1 | anything |
| `--ink-2` on `--bg` | 7.0:1 | body and up |
| `--ink-3` on `--bg` | **3.9:1** | **≥ 28px only** (large-text 3:1). Never the worker host, never the expiry |
| `--butter-ink` on `--butter` | 5.8:1 | the chip only |
| QR ink on `#FFFFFF` | 16.3:1 | QR only |
| coral on cream | 3.8:1 | graphics ≥ 3:1, **never text** |

Rules:

1. **Minimum type: 22px at 1080 wide (2.04% of width); 20px at 1200 wide.** Anything
   smaller is a print-only detail and this card has none.
2. **The code is the second-largest thing on the card** — after the headline, before
   everything else. It is what a human types when the camera fails.
3. **QR discipline:** ink on white, 4-module quiet zone with nothing printed inside it —
   no lane, no pattern, no corner mark, no logo, no rounded modules, no inverted (light
   modules on dark) variant, error correction M or higher, module ≥ 8px at 1080 and
   ≥ 0.4mm in print. The card's cream and radius stop at the white plate's edge.
4. **Print:** the 1080×1350 is the *screen and PNG* reference; it is 3.6×4.5in at 300dpi.
   Ship a vector master and print at A6/A5, matte uncoated — gloss plus a phone camera
   flash is a failed scan in a dim room, which is the only room this card is used in.
5. **Export the QR at the card's own size**, from the component's path (it is a single
   `path` in a `viewBox`, so it is resolution-independent); do not upscale the 184px
   preview.

---

## 5. Four empty-state drawings

One language, taken from the mascot at `design/preview.html` lines 378–387: a single ink
weight, round caps and joins, open forms, exactly one pastel fill, no gradients, no
shadows, no second hue, and no facial expression on anything that is not the mascot. All
four use the mascot's **120×96 viewBox** so they drop into the same slot.

| Value | Spec |
|---|---|
| Ink | `--ink` `#241F1A` |
| Primary stroke | **2.2 at 120 wide** (1.83% of width) — matches the mascot's 2.2 |
| Secondary stroke | 1.8 (detail only: hairlines, dashes) |
| Accent fill | one per drawing max, always with an ink stroke on top |
| Corner radius | ≥ stroke width, always |
| Parallel strokes | ≥ 4 apart at 120, or they merge at 96px |
| Render sizes | 140 (full-page), 120 (default), 96 (card). Never below 96. |
| Motion | `mascot-idle` only, one instance per page; reduced-motion turns it off entirely |

### 5.1 No alerts — *"Nothing is on fire"* (console all-quiet panel)

**The mascot, reused verbatim.** No redraw, no new pose: `rect 34,10,52,76,r14` body, mint
`#DDF3E4` badge `rect 26,34,26,34,r8` with a `#1F6B45` check at 2.6, two ink eyes r2.6 at
y34, smile `M52 44c3.4 4 12.6 4 16 0`, two signal arcs at x86/96. It reads as "checked and
alive", which is exactly the claim this state is allowed to make — and it is the one place
the check is true.

*Nothing else in this set may have a check.* A check beside "no messages yet" would assert
that zero traffic is healthy; the console's whole argument (`CONSOLE_UX.md` §3) is that a
friendly green mark never implies the fleet is reachable. Note the consequence for
`DESIGN_2026.md` §3, which lists "empty state" as a mascot home: the phone's empty state
now uses 5.2, so §3 needs one line amended in the same change that ships this set.

### 5.2 No messages yet — *the bubble that has not spoken*

| Element | Geometry | Ink |
|---|---|---|
| Bubble | `rect 22 14 58 40 rx13`, stroke only | 2.2 |
| Tail | `M35 54 L30 66 L46 54`, round join on the bubble's stroke centreline | 2.2 |
| Inside | one dashed rule `M36 34h30`, dash 2/6 | 1.8, `--ink-3` |

Composition: bubble sits left of centre, tail down-left, and a single dashed rule inside
where text would be. No dots, no "…", no typing indicator — nothing that suggests a
message is arriving. At 96px: bubble 46×32, tail 13 tall, dash pattern still legible
because 6px gaps at 96 become 4.8.

### 5.3 No flow cached — *the lane that stops short*

| Element | Geometry | Ink |
|---|---|---|
| Phone | `rect 12 26 30 46 rx10`, stroke only | 2.2 |
| Lane (first half) | `M42 45h14`, round cap | 2.2 |
| Break marker | `circle 63,45 r5.5` — butter `#FBEBC8` fill, ink stroke 2.2 | 2.2 |
| Flow card | `rect 78 30 30 38 rx8`, dashed 3/6 | 1.8, `--ink-3` |

Composition: left to right, solid → hollow → dashed. The phone is present, the lane has
left, the hollow ring is where the packet should be, and the flow is a dashed outline
because it is not here. This is the icon's own vocabulary (station, beam) used as a
sequence, which is why the set feels like one family rather than four drawings.

The dashed card is already the console's "draft / absent" language (`.bcard` dashed in
`preview.html` line 408) — reuse it, do not invent a second absence style.

### 5.4 Permission missing — *the locked inbox*

| Element | Geometry | Ink |
|---|---|---|
| Phone | `rect 30 18 34 58 rx11`, stroke only | 2.2 |
| Inbox lines | `M39 34h16` and `M39 41h10` | 1.8 |
| Padlock body | `rect 66 50 18 14 rx4`, butter fill | 2.2 |
| Shackle | `M70 50v-2a5 5 0 0 1 10 0v2`, no fill | 2.2 |
| Keyhole | `circle 75,57 r1.6` | filled ink |

The padlock sits *beside* the phone with a 2px gap, not overlapping — attached, not
stamped on. No slash, no exclamation, no red: butter is the warning token and the wording
carries the consequence ("SMS will not be read until you allow it"). At 96px the padlock
is 14×11 with a 1.8 shackle — the smallest form in the set, which is why it is the one
element that gets a dedicated size check.

---

## 6. Beyond the app: two surfaces, no campaign

### 6.1 F-Droid listing

| Metadata field | Size | Notes |
|---|---|---|
| `icon` | 512×512 PNG | Torch, **ink field** (F-Droid renders it on white and on near-black — a cream squircle would be invisible on the light theme), squircle baked at r=115 (22.5% of 512), transparent outside. The **72dp window maps to the 512**, not the 108 canvas (scale 7.11): slab 185×299, r64, arc stroke 39. |
| `featureGraphic` | 1024×500 | The only "banner" this product needs; see rules below |
| `promoGraphic` | 180×120 | Torch only. A wordmark at this size renders at 8px and is a smudge, not a brand. |
| `tvBanner` | 1280×720 | Omit until there is a TV build. An empty field is worse than a missing one. |
| screenshots | ≥ 2, 1080×1920 | Real states: a live device, the pair sheet, a flow run. Never a mocked "chat with a friend". |

Two build-specific rules, because two builds ship from one codebase:

- The **F-Droid** listing must not show a push/FCM badge, a bell, or anything implying
  background wake. That build is WebSocket-reconnect only (README:97) and the icon set
  must not promise what the build does not do.
- The feature graphic names the build, in mono, at 20px: `websocket · no fcm`. One line of
  type that most projects would spend on a slogan.

**featureGraphic 1024×500 composition** (the anti-template brief):

- Cream field, no gradient. The coral lane enters at x=0, y≈250, runs right, and is
  **cropped by the frame edge** — the crop is the signature across every asset.
- Left 60%: wordmark 72/650, one sentence 26/400 `--ink-2`, and a 20px mono line with a
  *real* value (`dev29b9c2… · live · 18s`).
- Right 40%: a real console fragment — one device row, cropped by the right edge, at 1:1
  scale so the type is the product's actual 12–13px. Cropped UI is the credible move; a
  floating laptop mockup is the template one.
- No CTA button. There is nothing to buy and nowhere to click.
- Text-to-image: the actual copy is 14 words. That is under the 20% ad rule without trying.

### 6.2 README hero

- **1200×360 SVG, 3.3:1.** GitHub's column is 1012px wide, so this renders at 84% and still
  reads; a 4:1 or wider hero shrinks to a decorative strip in the same column.
- **No field.** The hero sits on the page: transparent background, mark and type in the
  theme's ink, lane in coral. A cream block on GitHub white is a rectangle of nothing.
- GitHub honours `<picture>` with `prefers-color-scheme`, so ship **two files** in one
  block: `hero-light.svg` (ink type + glyph) and `hero-dark.svg` (cream type + glyph). A
  single ink hero on GitHub dark mode is invisible, and dark mode is the majority.
- Content, in order: the glyph at 32, `DakFlare` 44/650, one line of real positioning at
  18 ("Your own phone, answering strangers' SMS."), and the lane, cropped both ends.
- **Nothing else.** No badge row, no shields, no emoji, no "built with" logos, no
  architecture diagram — the diagram is a table in the README and it is better there.

### 6.3 The rules that keep these from looking like a template

1. **One cropped line in every asset.** The lane never fits inside the frame; it enters
   and leaves. Cropping is the cheapest signal that a human composed the frame, and it is
   the one thing a template generator will not do.
2. **Only real values.** `dev29b9c2…`, `live`, `18s`, `A6C3 F079 1514`. No "10k+ messages",
   no "99.9% uptime", no invented device names. If a number cannot be produced by the
   product, it does not appear.
3. **Two typefaces, and the mono is the console's mono.** `--font-sans` and `--font-mono`
   from `preview.html` lines 30–31. Never a display face — the product's character comes
   from the palette and the doodle, not from a typeface it does not ship.
4. **One coral element per asset.** The lane, or the code, or the arc. Two corals is a
   poster.
5. **No device mockups, no perspective, no glass.** If a phone appears, it is the doodle
   in §3.1/§5, flat.
6. **No gradients, no glow, no 3D, no neon, no stock photography** — the five looks that
   make an infrastructure tool look like a 2019 SaaS landing page.
7. **Every asset must survive 50% downscale.** Check at half size before approval; if the
   headline disappears at 600px wide, it was never a banner, it was a document.
8. **Paper is not screen.** Print gets the ink field, the vector master, and no cream-on-
   cream.

---

## 7. What I refuse to produce for this product

| Refused | Why |
|---|---|
| A launch/social campaign (X header, Instagram set, LinkedIn cover) | There is no campaign. One operator, a GitHub repo and an F-Droid listing. Producing seven sizes would be the most visible sign that the brand is decorative. |
| "End-to-end encrypted" / "secure messaging" imagery — shields, padlocks as a hero, a "hacker-proof" banner | **SMS is not encrypted.** The ECDSA P-256 signature authenticates the device to the Worker; it says nothing about the air interface. A padlock hero would be a false claim about the product's riskiest property, in the one document a security reviewer reads first. |
| A padlock or shield as the *icon* | Same reason, compounded: it would survive for years after the banner is forgotten. (The padlock in §5.4 is a permission state on a phone, not a security claim, and it is inside an empty state, not the mark.) |
| A mascot in an error, destructive, alert or permission-blocked state | `DESIGN_2026` §3 already forbids it. Beyond the rule: a friendly face on an error surface trains the operator to skim errors. |
| Sadder / angrier / "worried" mascot variants, or a mascot with a speech bubble of copy | Emotional manipulation in an ops tool, and it converts a 3-element doodle into a licence to keep drawing. One character, one mood. |
| A QR with a logo in the centre, brand-coloured modules, rounded modules, or an inverted QR | It fails on cheap scanners and in low light, which is the only light this card is used in. The brand does not get to cost a pairing. |
| Any 1200×630 captioned "scan to pair" | Platform recompression. Specified in §4.2 as a shape, never as a scanner. |
| "Scan to download" with a Play/F-Droid badge before the F-Droid listing exists | A dead QR on a README is worse than no QR. |
| Stock photography of a hand holding a phone in a café, or a "person texting" | The product is a phone in a drawer. A lifestyle photo is a claim about who uses it, and the answer is "one operator, at a desk, at 2am". |
| A price table, "free forever", or a comparison against Twilio | `README.md` already makes the no-markup argument in one sentence. A table invites a fight the project does not need to have, and prices change. |
| An animated splash, a looping logo, a loading animation for the phone app | The app is opened in a pocket, on battery, sometimes to check whether the gateway is alive. `DESIGN_2026` §2 already bans the loop; a branded splash would be the first thing to break that rule. |
| Play-Store-style assets: a 5-star row, "featured in", award laurels, a fake review | Fabrication. Also useless on F-Droid, where none of it exists. |
| A dark "cyber" hero, a terminal-green variant, or a neon accent "for developers" | A second palette with one user is a second brand. The warm cream is the differentiator; a cyber variant deletes it to look like every other gateway. |
| The Tauri robot, the `#3DDC84` field, or the `#2f42c4` favicon kept "for compatibility" | They are another product's identity and a colour family that appears nowhere in `DESIGN_2026`. "Compatibility" for a launcher icon means "we did not decide". |

---

## 8. Production list

| File | From | Notes |
|---|---|---|
| `drawable/ic_launcher_background.xml` | §3.6 | flat `#FBF6EE`, 108 viewport, no grid |
| `drawable/ic_launcher_foreground.xml` | §3.1 | r ≤ 30; drop the `aapt:attr` gradient |
| `drawable/ic_launcher_monochrome.xml` | §3.6 | alpha, gap closed |
| `mipmap-anydpi-v26/ic_launcher{,_round}.xml` | §3.6 | **new file — this is why the robot ships today** |
| `mipmap-{m,h,x,xx,xxx}dpi/ic_launcher{,_round}.png` | §3.5 | 48/72/96/144/192, drawn per row, not scaled |
| `mipmap-*/ic_launcher_foreground.png` | master × density | 108/162/216/324/432 |
| `values/colors.xml` | — | add `dakflare_field`, `dakflare_ink`; leave the Material defaults alone or delete them with the theme work |
| `AndroidManifest.xml` | — | add `android:roundIcon`; check `windowSplashScreenAnimatedIcon` is not set to something else |
| `dashboard/src/lib/assets/favicon.svg` | §2 | 32×32, ink squircle r8, cream stem, coral dome — the glyph, not the icon |
| `Brand.svelte` | §2 | 20px glyph in the existing `--accent-soft` plate, `--accent` stroke, + the wordmark that already exists |
| `pair-card-1080x1350.{svg,png}` | §4.1 | vector master + PNG at 2× for screen |
| `pair-card-1200x630.{svg,png}` | §4.2 | OG/reference |
| `empty-*.svg` ×4 | §5 | 120×96, inline-able, `aria-hidden` |
| `fdroid/icon-512.png`, `fdroid/feature-1024x500.png` | §6.1 | squircle baked on the icon |
| `hero-{light,dark}.svg` | §6.2 | 1200×360, `<picture>` pair |

Naming: `{surface}-{variant}-{w}x{h}.{ext}`, kebab-case, no dates — none of these are
campaign assets and a date in the filename would imply they are.
