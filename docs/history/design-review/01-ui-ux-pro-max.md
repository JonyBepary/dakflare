# Review 01 — skills data against the warm direction and the phone app

Status: review + rules, 2026-10-29. Read-only on application code. Normative sources
untouched: `CONSOLE_UX.md`, `DESIGN_2026.md`, `WAVE2_NATIVE_SMS.md`.
Skill: `ui-ux-pro-max` (79 styles, 192 palettes, 74 pairings, 119 UX guidelines,
32 app-interface rules, 17 motion presets). Every record cited below was returned by
`search.py` or read from the skill's `data/*.csv`; nothing is invented. Contrast figures
are computed from the documented hex values with WCAG 2.1 relative luminance — they are
measurements, not opinions.

Read for this review: `docs/CONSOLE_UX.md`, `docs/WAVE2_NATIVE_SMS.md`,
`docs/DESIGN_2026.md`, `design/preview.html`, `dashboard/src/app.css` (1657 lines),
`simulator/src/app.css`, `simulator/src/routes/+page.svelte`,
`simulator/src-tauri/gen/android/.../MainActivity.kt`, `SendSmsForm.svelte`,
`routes/messages/+page.svelte`.

---

## 1. What the skill actually returned

### 1.1 The two requested queries

```
search.py "SMS gateway ops console warm" --design-system -p "DakFlare" -f markdown
search.py "mobile messaging app"       --design-system -p "DakFlare Phone" -f markdown
```

Both returned the **same** pattern, style, typography and effects, differing only in the palette:

| Field | Return | Fit |
|---|---|---|
| Pattern | `Hero + Features + CTA` — Hero (sticky) + Bottom, "Value prop > Key features (3–5) > CTA > Footer" | **Reject.** Landing-page funnel. There is no hero, no CTA band, no footer in an ops console or a gateway app. |
| Style | `Minimalism & Swiss Style` (`minimalism-and-swiss-style`, active) | **Keep as the chassis**, reject as the brand. Keywords: clean, spacious, grid-based, high contrast. |
| Colors (console) | `#2563EB` primary, `#EA580C` accent, `#F8FAFC` bg, `#1E293B` fg — "Trust blue + orange CTA" | **Reject.** Generic SaaS default; the product's own defect is that it looks like every dashboard. |
| Colors (phone) | `#2563EB` primary, `#6366F1` secondary, `#059669` accent, `#FFFFFF` bg — "Messenger blue + online green" | **Reject.** This is the literal WhatsApp/Telegram look for an app that is not a messenger. |
| Typography | `Outfit` heading + `Work Sans` body, mood "geometric, modern, clean" | **Reject.** See §1.3. |
| Effects | "Subtle hover (200-250ms), smooth transitions, sharp shadows if any, clear type hierarchy, fast loading" | Accept the timings; the rest is boilerplate. |
| Mode | Light supported, Dark supported | Accept. |
| Pre-delivery checklist | no emoji icons, cursor-pointer, hover 150–300ms, 4.5:1, visible focus, reduced motion, 375/768/1024/1440 | Accept, except the breakpoint list — this product needs 360, not 375, and the phone app is not a browser. |

**Retry per the skill's own contract** (`"ops console warm"` and `"messaging app mobile"`)
returned the same pattern, style and typography again, with only the colour hexes
changing. The `--design-system` mode is landing-page-shaped and cannot answer either
question. Verdict: **the design-system output is not usable for this product**; the domain
searches below are.

### 1.2 Domain records that did land

| Query | Domain | Top record | What it says | Used for |
|---|---|---|---|---|
| `warm bento dashboard` | style | `bento-box-grid` | "Do Not Use For: **dense data tables, text-heavy content, real-time monitoring**"; radius 16–24, neutral base + accent, hover scale 1.02 | §1.3, §4 |
| `cream editorial dashboard` | style | `data-dense-dashboard` then `bento-box-grid` | 12-col, 8px gap, 12–14px type, sticky headers | console density |
| `paper ink print` | style | `e-ink-paper` | Off-White `#FDFBF7`, Paper White, Ink Black `#1A1A1A`; "grain/noise texture, **sharp transitions (no fade)**"; do-not: **dark mode dependent apps** | palette verdict |
| `minimal ops utility warm` | style | `minimalism-and-swiss-style` | "Avoid shadows and gradients. Focus on clarity" | chassis |
| `warm paper journal warm` | style | `nature-distilled` | Terracotta `#C67B5C`, Sand Beige `#D4C4A8`, Soft Cream `#F5F0E1` | warmth reference |
| `messaging chat` | product | `Chat & Messaging App` | Primary style Minimalism & Swiss + Micro-interactions; palette "brand primary + **bubble contrast** + typing grey"; rule `if_mobile: optimize-touch-targets`; **anti-pattern: "Excessive decoration"** | phone app |
| `device fleet monitoring` | product | #1 `Smart Home/IoT Dashboard` (Glassmorphism + Dark OLED) — **rejected**; #3 `Status Page / Incident Management` is the fit | Data-Dense + Real-Time; "status green + incident red + maintenance amber"; anti-pattern "Slow dashboards, decorative charts, **hidden error states**" | Device tab |
| `automation dashboard` | product | `RPA / Automation Dashboard` | "running green + failed red + queued amber + completed blue"; `if_dashboard: virtualize-lists` | Flows tab, queue states |
| `warm cream terracotta` | color | `Recipe & Cooking App` | `#9A3412` / `#C2410C` / bg `#FFFBEB` / border `#F2E6E2`, "warm terracotta + fresh green" | nearest warm-cream palette |
| `warm cream terracotta` | color | `Notes & Writing App` | `#78716C` + accent `#D97706` on `#FFFBEB`, "**warm ink + amber accent on cream**" | nearest warm-cream palette |
| `warm neutral dashboard` | color | *none warm* — dark finance, IoT, docs grey, generative art | — | proves the gap |
| `dense data mono dashboard` | typography | `Dashboard Data` — Fira Code + Fira Sans | "Code for data, Sans for labels" | mono role |
| `warm editorial sans serif` | typography | `SaaS Mobile Boutique` — Calistoga + Inter + JetBrains Mono | "tri-stack, human warmth, mono 12pt uppercase tracking 1.5 for data labels" | warmth reference |
| `button press feedback` | gsap | Hover Micro-interaction, Subtle | 150–200ms, `power1.out`, "**keep displacement under 2px so it reads as feedback not motion**", transform/opacity only | motion set |
| `button press feedback` | gsap | Hover Micro-interaction, Standard | 200–300ms, `power2.out`, y −4 + scale 1.02 + shadow | bento lift |
| `list stagger` | gsap | Stagger List, Subtle | 250–350ms, stagger 0.03, "keep 0.02–0.04s; never >0.1s"; "**for virtualized lists, animate only mounted items**" | `settle` |

Zero-result queries, recorded because a 0 must not be dressed up as data:
`"sms messaging utility"` (product), `"admin console"` (product), `"communication"`
(product), `"utility tool"` (product), `"conversation list preview"` (ux),
`"permission denied explanation"` (ux), `"send failure retry queue"` (ux).
**There is no SMS-gateway record in this skill.** The nearest neighbours are Status Page,
RPA/Automation and Chat & Messaging; everything specific to inbound strangers' SMS and
one-reply-per-message comes from `CONSOLE_UX.md` / `WAVE2_NATIVE_SMS.md`, and is marked
`product fact` in §3 rather than given a fake citation.

### 1.3 Verdict on the approved direction

**Keep the direction. Change three tokens, one dark-mode rule, and the scope of bento.**
The direction is the only one the data supports — `e-ink-paper`, `nature-distilled` and
the two warm-cream palettes all converge on cream surface + ink + one warm accent, which
is what the owner approved. But `DESIGN_2026.md` §1 as written **loses contrast the
current build already has**, and its §5 dark variant is unusable.

Computed from the documented hexes:

| Documented pair | Doc claims | Computed | Verdict |
|---|---|---|---|
| `--accent #C9482A` on `--bg #FBF6EE` | 5.1:1 | **4.39:1** | fails 4.5:1 as text |
| `#FFFFFF` on `--accent-fill #D9502C` | 4.6:1 | **4.09:1** | fails as a button label (13px/700 is not "large text") |
| `--ink-3 #857A6B` on `--bg` | implied pass | **3.91:1** | fails; this is the metadata/timestamp token |
| `--ink-3` on `--surface #FFFDF8` | — | **4.14:1** | fails |
| `--ink-3` on `--surface-2 #F6EFE3` | — | **3.68:1** | fails; sidebar, table headers |
| six pastel-ink-on-pastel pairs | ≥4.5 | **5.52 – 7.40** | pass, all six |
| pastel ink on cream surfaces (`bg`…`surface-3`) | "pastel ink is only for chips" | **5.09 – 9.08** | passes everywhere — the doc's restriction is semantic, not contrast |
| dark: pastel container at 12% over `#1C1814`, pastel ink kept | "pastel containers keep their ink" | **1.40 – 1.98** | unusable |

Compare the build today: `--accent #2f42c4` on `#f4f3ee` = **7.01**, white on it = 7.79,
`--ink-3 #6a6e64` = **4.69**. The warm direction as drafted is a *contrast regression*
on three tokens, and the phone app's dark variant would render every one of the five
device states as a chip nobody can read.

Required changes (all measured):

| Change | From | To | Result |
|---|---|---|---|
| `--ink-3` | `#857A6B` | `#6B6053` | 5.70 / 6.03 / 5.37 / 4.83 on bg / surface / surface-2 / surface-3 |
| `--accent` | `#C9482A` | `#B93F22` | 5.14 on bg, 5.44 on surface |
| `--accent-fill` | `#D9502C` | `#B93F22` (same token) | white on it 5.53 — one token now serves both roles |
| dark pastel containers | 12% alpha | **100% opaque, as paper chips on `#1C1814`** | ink on chip stays 5.52–7.40, chip-vs-page 14.0–15.1:1 |

`#C9482A` may survive as a **graphic** accent (rules, focus ring, 3:1 non-text) — not as
text, not as a button fill. That is the only concession the numbers allow.

**Bento: keep, but only above the fold.** `bento-box-grid` explicitly says do not use it
for "dense data tables, text-heavy content, **real-time monitoring**". So bento is legal
for Overview, device stat cards and the automation board — it is **not** legal for the
message table, the live log, or any phone-app list. The console's own §4 already says
"dense lists stay lists"; the skill record turns that from taste into a rule.

**Typography: keep the system stack, do not adopt the returned pairing.** Two reasons,
both harder than taste:
1. `DESIGN_2026.md` §6 — "prerendered static build with no new runtime dependency".
   `Outfit`/`Work Sans`/`Calistoga` are webfont requests; in the phone app the webview is
   offline-first and loads from `tauri://` with no network.
2. **Bangla.** UCS-2 is a shipped case (`WAVE2 §5` M5.4: "Bangla UCS-2 3-part message
   arrives once"). Every returned pairing is Latin-only; a custom Latin face would fall
   back to Noto Sans Bengali mid-sentence and change metrics line by line. Android's
   system stack already has both.

Buy the character from **mono instead**: tabular numerals on every id, count, timestamp,
number and segment counter — that is what `Dashboard Data` and `SaaS Mobile Boutique`
are actually pointing at ("Code for data, Sans for labels"). Warmth comes from surface
and accent, not from a webfont. One concrete consequence: `--font-mono` must be a stack
with `font-variant-numeric: tabular-nums` set explicitly, because `ui-monospace` is not
consistent across Android builds.

**Motion: keep the named set, delete two of them, and fix the reduced-motion block.**
`gsap` gives press = 150–200ms `<2px` (the doc's `scale(.97)` at 90ms is *faster and
larger* than the record — acceptable, it is a press not a move; keep 90ms, it reads as
hardware). But:
- `e-ink-paper` says "sharp transitions (no fade)"; `gsap` allows 0.02–0.04s per item,
  never more than 0.1s, and says animate only items that are mounted. `settle` at 220ms
  + 40ms stagger sits at the top of that band and totals 420ms over 6 items — right for
  a console page, a third of a second too long for a phone list you scroll. On the phone:
  cap `settle` at 4 items, 160ms, 30ms stagger; below 400px width, drop the stagger.
- **`mascot-idle` (4s infinite) and `pulse` (2.4s infinite) must not ship in the phone
  app.** `ux/Continuous Animation` (Medium): "Use for loading indicators only / Don't use
  for decorative elements". A gateway phone lives on battery in a pocket; an infinite
  repaint in the empty state is the wrong trade. Keep both in the console, where a wall
  socket exists.
- `simulator/src/app.css` has **no** `prefers-reduced-motion` block at all (`grep -c` = 0);
  `dashboard/src/app.css` collapses everything to `0.01ms`. `app-interface/Respect
  Reduced Motion` (Critical) and `ux/Reduced Motion` (High) both want the final state, not
  a fast animation — and the global `0.01ms` trick breaks any element whose visible state
  only exists in an `animation-fill-mode` keyframe. Rule: reduced motion sets the final
  state in CSS, and the reduced path never depends on `animationend`
  (`ux/Cancellable State Transitions`, High).

---

## 2. The dock: four destinations

**Four: `Threads · Device · Flows · Settings`.** Not five, not "More".
`app-interface/Bottom Tabs` (Medium): "Use 3–5 tabs and move extras to More/Settings";
`ux/Sticky Navigation` (Medium) for the content offset; `SKILL.md` priority 9:
"Bottom nav ≤5".

| # | Destination | The one job | Lives here | Explicitly not here |
|---|---|---|---|---|
| 1 | **Threads** | Read and answer people's SMS | Thread list with search + 3 filter chips (`All · Unanswered · Failed`); thread view; composer; per-message answer line | Pairing, health numbers, flow editing, settings |
| 2 | **Device** | "Is this phone still a working gateway?" | Five-state chip + wake mode; identity (label, id); permission rows (SMS, notifications, battery); SIM/subscriptions + own number or "not reported"; flows synced (count, version, last fetch); outbox; unpair; collapsed diagnostics | Any message body, any thread content |
| 3 | **Flows** | What will answer automatically, and did it | Synced flows (name, version, trigger, last run, on/off); "Sync now"; device-side run log; the one pipeline sentence; deep link to the console for authoring | Canvas editing, rule authoring, a test send that spends a real SMS |
| 4 | **Settings** | Rarer, non-urgent choices | Pairing / re-pair; target URL; theme; notification content policy; clear local thread; about/version; sign out | Anything that changes gateway behaviour: that is Device |

**Order, defended on three axes.**
- *Frequency*: Threads first — opened many times a day; Settings last — touched occasionally.
  Nothing else is close.
- *Consequence*: Device before Flows. Inbound can arrive with zero flows synced
  (`WAVE2 §7`: a freshly paired phone has an empty `flows` table), so "is the phone
  receiving at all" outranks "what answers". It also mirrors `CONSOLE_UX §4`
  (Devices · Messages · Automation) instead of inventing a second mental model.
- *Convention*: primary leftmost, Settings rightmost is what every Android user's thumb
  already knows. Reordering for "reachability" would cost more than it buys at 360dp.

The left-to-right reading is the product: **messages arrive → the phone is why → flows
decide the answer → configuration.** That sentence is the dock.

**"Flows", not "Automation" — and this is deliberate.** The phone runs only flows
(`WAVE2 §7`: "Rules are gateway-side by decision; the device runs flows only"). A tab
called *Automation* on a device that cannot execute rules is a scope lie, and it is the
same defect `CONSOLE_UX §1` was written to kill. Seven characters is also the length that
still fits an 80dp slot at 1.3× font scale; "Automation" needs ~60dp at 11sp before
padding and stops fitting the moment the dock gets a fifth item at 320dp.

**Banned from the dock, with the reason.**
| Not a destination | Where it goes | Why |
|---|---|---|
| Compose / new message | Floating action inside Threads, and the in-thread composer | A mode is not a place; `app-interface/Back Behavior` (Critical) means every tab must be a place you can back out of. |
| A single conversation | Pushed from Threads | Same. |
| Alerts / "Inbox of problems" | Pinned banner on **every** frame + a section in Device | `CONSOLE_UX §3`: "an alert is a fact about a device". A tab would let an operator sit in Threads and not see it. |
| Pairing | Settings → This phone; gates first run | Happens once. A dock item you use once is a wasted 90dp forever. |
| Diagnostics / logcat | Device, collapsed `<details>` | Needs to exist for support; has no daily job. |
| Search | Field at the top of Threads | `ux/No Results` (Medium) already owns the empty-search state; a tab for it is an extra hop. |
| Queue / Outbox | Section in Device, with a **count badge on Device** | Splitting "failed send" from "the phone's state" creates two places to check and one lie each. |
| "More" | — | Everything above has a home. A More tab is an admission the IA failed. |
| Dashboard / console | Settings → "Open console" (external) | Workflow authoring is desktop (`CONSOLE_UX §7`). Never duplicate it. |

**Badges (only two are allowed).**
- Threads: unread count, announced as "3 unread messages" — `ux/Contextual Live Badge
  Updates` (High): "Use one appropriate atomic status message… Don't announce a bare
  number".
- Device: **one dot, no number**, only when action is required (SMS permission revoked,
  queue stuck, `offline && poll-only`). `aria-label="Device needs attention"`.
- Flows and Settings carry no badge. Nothing urgent may live only there.

### 2.1 Degradation at 360dp, keyboard open

Native figures: 360 × 800dp typical, 360 × 640dp on older devices. `MainActivity` already
pads the content view by `systemBars() | displayCutout()`, and `env(safe-area-inset-*)`
is **not** reliably exposed in this WebView. So the dock must add **no** inset of its own
and must not be `position: fixed; bottom: 0`.

| Condition | Behaviour | Backing |
|---|---|---|
| 360dp, 4 tabs | 90dp per item × 56dp — comfortable. Labels 11sp, one line, `nowrap`, max 7 characters by design | `ux/Compact Label Overflow` (High) |
| 320dp, 4 tabs | 80dp per item; still passes 48dp target | `app-interface/Touch Target Size` (Critical: 48dp Android) |
| 320dp, 5 tabs | 64dp per item; "Automation" + padding overflows → forces icon-only or truncation → **banned** | `ux/Essential Text Truncation` (Critical) |
| Font scale 1.3× | "Threads" at 11sp ≈ 7 characters → ≈55dp inside an 80–90dp slot (estimate, verify on device at 320dp). A label that no longer fits may neither wrap nor be dropped | `app-interface/Dynamic Type Support` (High) |
| **Keyboard open** | **The dock leaves.** It is not visible, not in the tab order, and not announced. The composer sits directly on the keyboard edge; the thread scrolls under it | `ux/Focus Not Obscured (Minimum)` (High) |
| Keyboard open, 640dp device | Keyboard ≈ 290dp → ≈ 350dp content. A 56dp dock there costs 16% of the screen to duplicate navigation you cannot use mid-sentence | `ux/Viewport Units` (Medium) |
| Layout mechanics | `.shell` is a `100%`-height grid `auto / 1fr / auto`; the scroll row gets `min-height: 0`; the composer is the third row, so it tracks the keyboard without JS | `ux/Sticky Navigation` (Medium): "Add padding-top to body equal to nav height" — the same compensation, inverted |
| Dock hidden | The viewport grows by exactly one dock height, once. Anchor the scroll position so the message being read stays where it was; never animate the resize | `ux/Content Jumping` (High) |
| Entering a thread | **No autofocus.** Keyboard opens only on an explicit tap in the composer | `ux/Content Jumping` (High) |
| Any transition on the dock | 120ms height/opacity max, and none under reduced motion | `ux/Reduced Motion` (High) |

Two mechanical traps worth naming because the code shows them:
`MainActivity`'s padding + `position: fixed` produce double insets; and
`adjustResize` + a fixed dock is the classic "dock floats above the keyboard" bug. Being
a grid row solves both without touching Kotlin.

---

## 3. Rules for the SMS surface

Every rule is one line, then its source. `product fact` means the skill has no record and
the requirement comes from `CONSOLE_UX.md` / `WAVE2_NATIVE_SMS.md`; no fake citation is
attached to those.

### 3.1 Thread list

| Rule | Backing |
|---|---|
| One row = one peer, sorted by last activity, newest first; opening it never reorders the list under your thumb. | `product fact` (dedupe on `(device_id, local_id)`, `WAVE2 §4`) |
| The row title is the **full peer address in mono** — no avatar, no initials, no invented name. Contacts are not readable: `READ_CONTACTS` is not in the manifest. | `DESIGN_2026 §3` "never for a phone number"; `product fact` (manifest, `WAVE2 §3`) |
| Unread is a number, not a dot; the row also carries the newest message's delivery state as **text or glyph**, never colour alone. | `ux/Color Only` (High); `ux/Compact Label Semantics` (High) |
| Filter chips are three (`All · Unanswered · Failed`), one row, wrap before clipping, and an overflow becomes an operable "+n" not a clip. | `ux/Chip Collection Reflow` (High) |
| The preview line is one line, `overflow-wrap: anywhere`, and an over-long body never breaks the row. | `ux/Long Token Wrapping` (High); `ux/Truncation` (Medium) |
| A thread whose peer is a mask or shortcode gets a persistent label (`mask · never auto-answered`) from the row's own data. | `product fact` (`WAVE2 §4` masks/shortcodes) |
| Pull-to-refresh is allowed only as a secondary path; there is always a visible refresh. | `ux/Hover vs Tap` (High); `ux/Pull to Refresh` (Low) |
| Rows are a plain list, not bento cards, not a table. | `bento-box-grid`: "Do Not Use For: dense data tables, real-time monitoring" |
| Long lists virtualise or paginate; nothing above ~50 rows is all-mounted. | `app-interface/Virtualize Long Lists` (High) |

### 3.2 Message states

The core correction: **delivery and answering are two axes, never one chip.**

| Axis | Values | Where it renders |
|---|---|---|
| Delivery | `queued → sent → delivered` / `failed` | One small line under the bubble, mono time, no badge |
| Answer | `answered by flow · wf_gate v2` / `answered by you` / `not answered · no flow matched` / `not answered · mask declined` | One line on the **inbound** message only, tappable for the reason |

| Rule | Backing |
|---|---|
| "Sent" means handed to the radio; never render a delivery tick until M5.5 receipts exist. | `product fact` (`WAVE2 §5`: "`sent` means 'handed to the radio', not 'delivered'"); `ux/Success Feedback` (Medium) |
| `queued` shows the reason it is waiting ("no signal", "gateway unreachable") at the stage it is waiting. | `ux/Loading States` (High); `product fact` (`CONSOLE_UX §6`) |
| `failed` is inline, permanent, next to the message, with the stage named and a Retry adjacent — never a toast. | `ux/Error Feedback` (High); `ux/Toast Notifications` (Medium) "auto-dismiss after 3-5 s" |
| "Not answered" is a sentence with a cause, not a grey pill — it is the invariant the whole product exists for. | `ux/Compact Label Semantics` (High); `product fact` (`CONSOLE_UX §1`, one reply per message) |
| A manual reply to an already-answered message is allowed and is labelled "you are adding a second reply"; automation is capped, the human is not. | `product fact` (`CONSOLE_UX §1`) |
| State never depends on a colour pair: every state has a word. | `ux/Color Only` (High) |
| No state change reflows the bubble — the status line reserves its height. | `ux/Content Jumping` (High) |
| A state change is announced once, atomically ("Message failed"), never per redraw. | `ux/Contextual Live Badge Updates` (High) |
| No animated counters, no shimmer, no pulsing chip on the failure path. | `ux/Excessive Motion` (High); `ux/Continuous Animation` (Medium) |

### 3.3 Composer

| Rule | Backing |
|---|---|
| Send is disabled while empty and the disabled state keeps ≥4.5:1 on a muted **surface** — do not fade ink to 55% opacity. | `ux/Disabled States` (Medium) conflicts with `ux/Color Contrast` (High); contrast wins |
| During send the button becomes a spinner and is disabled — a second tap cannot send twice. | `ux/Loading Buttons` (High) |
| A failed send keeps the draft and the text; nothing is cleared, nothing is retried silently. | `ux/Error Recovery` (Medium) |
| The segment counter appears with the first character: `1/160 GSM-7`, and switches to `UCS-2 · 1/70` the moment the body needs it (Bangla, emoji, curly quotes). | `product fact` (`WAVE2 §5` M5.4 Bangla UCS-2 3-part); `ux/Number Formatting` (Low) |
| Counter and recipient are mono, tabular; the body is prose. | `DESIGN_2026 §1` |
| The composer's field has an `aria-label` ("Message text") and no visible label — the thread is the label. A **bounded** deviation from `ux/Input Labels` (High): this is the only field in the app without a visible label. | `ux/Input Labels` (High), knowingly deviated |
| The composer is a third grid row that tracks the keyboard; it is never `position: fixed`. | `ux/Mobile Keyboards` (Medium); `ux/Viewport Units` (Medium) |
| Recipient keyboard is `inputmode="tel"`; the body is `enterkeyhint="send"` with multi-line allowed. | `ux/Mobile Keyboards` (Medium); `app-interface/Keyboard Type` (Medium) |
| Sending while offline is not an error: it queues, says so, and the bubble carries `queued`. | `product fact` (`WAVE2 §7`); `ux/Error Recovery` (Medium) |

### 3.4 SIM / subscription

| Rule | Backing |
|---|---|
| SIM choice is **on the composer**, sticky per thread, showing carrier + last four of that line — never buried in Settings, because the wrong SIM sends from the wrong number. | `app-interface/Form Control Labels` (Critical) |
| Single-SIM shows static text ("SIM 1 · Grameenphone · …82829"), not a disabled dropdown. | `ux/Disabled States` (Medium) — do not render a control that cannot act |
| An unreported subscription reads "SIM: not reported" and blocks send with a reason; it never defaults to slot 0. | `product fact` (`CONSOLE_UX §6`; `WAVE2 §4` self-number guard "fall back to unknown") |
| The number this phone receives on is the number it sends from; state it once in Device and reference it in the composer — never ask the user to reconcile two numbers. | `product fact` |

### 3.5 Permission denied

| Rule | Backing |
|---|---|
| The explanation is a **screen before** the system dialog, in the app's voice ("This phone answers strangers' SMS. That is the whole app."), and the request fires from a tap on it — today `MainActivity.onCreate` requests immediately, with the screen deferred to M5.4. | `product fact` (`WAVE2 §3`: "must explain that the app is an SMS gateway, not a messenger, before the system dialog") |
| After denial the app still opens: Threads reads, sending is replaced by one banner at the top ("SMS permission is off — this phone cannot receive or answer") with "Open settings". | `ux/Error Recovery` (Medium) |
| The permission wall is never a modal on every launch; a modal you cannot escape is a trap. | `app-interface/Modal Escape` (High) |
| Notification denial is a **warning on Device**, not an error: the FGS runs, Android may still stop it, and the notification is the only evidence it did. | `product fact` (`WAVE2 §3`) |
| Battery-optimisation exemption is offered with the cost stated ("may increase battery use"), not demanded. | `ux/User Freedom` (Medium) |
| Every permission row carries its current state as a word, and the fix is one tap. | `ux/Color Only` (High) |

### 3.6 Empty and error

| Rule | Backing |
|---|---|
| An empty Threads state explains the consequence, not the absence: "Inbound SMS is stored here. Nothing is answered until a flow is synced." — with the reason this phone is quiet, from the five states. | `ux/Empty States` (Medium); `product fact` (`CONSOLE_UX §6`) |
| Zero device states are ever shown as a happy default: `unknown` and `offline` each have their own empty rendering. | `product fact` (`CONSOLE_UX §2`) |
| Empty ≠ error, and error ≠ empty: "can't reach the gateway" (this phone) and "gateway is down" (the deployment) are different sentences. | `ux/Error Feedback` (High) |
| Every error names the next step, and the next step is a control on the same screen. | `ux/Error Recovery` (Medium) |
| An empty search says “No messages match 4663” and offers to clear the filter — never “0 results”. | `ux/No Results` (Medium) |
| No fake threads, no sample conversations, no lorem: a shipped gateway showing invented messages is a false state. (`ux/Placeholder Content` asks for realistic sample data — that record is for prototypes, and is **rejected** here.) | `ux/Placeholder Content` (Low), knowingly rejected |
| No unbounded skeleton; a skeleton holds the row's final height or it is not used. | `ux/Content Jumping` (High); `ux/Loading Indicators` (High) |
| The live log pauses when the frame is not visible, and says "paused". | `product fact` (`CONSOLE_UX §6`) |

---

## 4. AI slop, this product specifically

Quoted anti-patterns are verbatim from `ui-reasoning.csv` for the matched product record.

| The slop | How it would appear here | Ban |
|---|---|---|
| **"Excessive decoration"** (`Chat & Messaging App`) | Gradient bubbles, a mascot in the thread list, glass panels, confetti on send | Bubble = one solid pastel-ink-on-surface pair; mascot only on pairing success (`DESIGN_2026 §3`); no gradient in a message surface |
| **"Complex shadows + 3D effects"** (`Email Client`, `Inventory`, `File Manager`) | A bento card with a lift-hover shadow used for a message row | `--shadow-1` only; no lift on any row that represents a message |
| **"Slow dashboards + decorative charts + hidden error states"** (`Status Page`, `RPA / Automation Dashboard`) | A "messages per hour" sparkline on Device; a failed send that exists only as a red dot | Only the six claimable metrics (`CONSOLE_UX §5`); `Delivery rate` not shown before M5.5; failures are always text |
| **"Color-only indicators"** (`Password Manager`, `Public Transit`, `Medication`) | The five device states as five pastel dots — the single most likely failure of this palette | Every state has its word; the dot is redundant at best |
| **Pastel chips with no label inside them** (`Password Manager`, "Color-only indicators") | `live/synced/stale/offline/unknown` as five pastel pills, plus a sixth for wake mode | One chip per surface, with the word inside it |
| **"Ambiguous toggle states"** (`Feature Flag / Config Management`) | An "Auto-reply" master switch that does not say rules-vs-flows — and on a phone cannot be true at all | No master switch. Per-flow on/off only, with "this phone runs flows; rules run in the gateway" |
| **"Ornate design + low contrast + motion effects + AI purple/pink gradients"** (`Government Portal`) | Aurora gradients behind the pairing screen; a lilac→pink hero on Device | No gradient anywhere except a 2px focus ring; accent is one warm red |
| **"No moderation cues + cluttered threads + hidden post state"** (`Forum / Discussion Board`) | A thread list where you cannot tell answered from unanswered | The answer line is mandatory, not optional |
| **"Decorative visuals + ambiguous toggle states + slow performance"** (`Feature Flag`) | An animated device-health ring that repaints constantly | No ring. Status is a word + a mono timestamp |
| **"Buried endpoints + … missing rate-limit state"** (`API Developer Portal`) | A rule's cooldown/hourly cap invisible in the console, or a flow that is silently not running because none are synced | Surface the cap and the sync state where the operator acts (`CONSOLE_UX §1`) |
| **"Marketing fluff"** (`Open Source Project Landing`) | "Your messages, beautifully automated" at the top of a config page | No marketing copy in-app. Empty states explain consequences |
| **"Pure white backgrounds"** (`Alarm & World Clock`, `Sleep Tracker`) | The phone app at night flashing `#FFFFFF` | Cream `#FBF6EE` in light, `#1C1814` in dark |
| **Infinite decorative motion** (`ux/Continuous Animation`, Medium) | `mascot-idle` 4s and `pulse` 2.4s on a battery-powered gateway | Allowed in the console, banned in the app |
| **Emoji as icons** (`SKILL.md` checklist) | 📶 🔋 ✅ in the Device fact grid | `Icon.svelte` set only, 1.5px stroke |
| **A dashboard that looks like the product it monitors** | "Messenger blue + online green" from the returned phone palette | The app must look like an instrument, not like WhatsApp |

---

## 5. Five decisions I am least sure about

1. **Four tabs versus five.** I dropped a Queue/Outbox tab and put the queue inside
   Device with a dot badge. That is cleaner by `ux/Compact Label Semantics` and by the
   "one place per fact" rule, but a stuck queue is the most operationally urgent thing on
   this phone and it now costs one tap to see the number. If M5.5 retry proves noisy, the
   fifth tab is the right answer and the dock's 360dp budget (90 → 72dp) is still legal.
2. **"Flows" instead of "Automation".** It is honest to the runtime and it is the only
   label that survives 1.3× font scale in an 80dp slot, but it contradicts the owner's
   stated label and forks the vocabulary between console (*Automation*) and phone
   (*Flows*). The alternative — keep *Automation* and put a one-line "rules run in the
   gateway" note in the header — keeps the word and risks the operator believing rules
   execute here.
3. **Body previews in the thread list.** The hard rule is "no message body in decorative
   UI". I read a preview as content, not decoration, so it stays — and the app is a
   messaging app first. But a gateway phone receives strangers' SMS, and the thread list
   is the highest-leak surface in the product. The defensible middle is a Settings switch
   defaulting on, which is a setting nobody flips.
4. **Hiding the dock while the keyboard is open.** It wins on space, focus and
   `Focus Not Obscured (Minimum)`, and it is the only option that does not fight the
   existing `adjustResize` + activity-padding setup. It may read as "the app lost its
   navigation" the first time. The alternative — dock floating above the keyboard — is a
   bug I would then have to design around forever.
5. **A dark variant for the phone at all.** `DESIGN_2026 §5` wants it for a pocket at
   night, but `e-ink-paper` says "do not use for dark mode dependent apps", the pastel
   chips at 12% alpha measure 1.4–2.0:1, and a gateway phone is on a charger, not in a
   bedtime reading pose. My recommendation (opaque pastel chips on `#1C1814`) is measured
   but visually untested — it may read as bright stickers on a dark page. Dropping the
   dark variant entirely for the app, and keeping it for the console, is a real option.

---

## Handoff

- Token changes in §1.3 are edits to `--ink-3`, `--accent`, the `--accent-fill` alias, and
  one rule in the dark block; they do not depend on any layout work.
- §2.1 assumes `MainActivity` keeps its inset listener. If a dock is built as
  `position: fixed`, both the double-inset and the keyboard bug return.
- Nothing in §3 requires a new permission or a protocol change. §3.5 does require moving
  the permission request behind a screen (`WAVE2 §3` already assigns this to M5.4).
- The skill's own design-system mode is not a source for this product. Future queries
  should stay at `--domain style|product|color|ux|web`, or they will keep returning
  landing-page patterns.
