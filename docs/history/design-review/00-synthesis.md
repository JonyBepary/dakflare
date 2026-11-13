# Redesign synthesis — what seven reviews agree on

Status: 2026-10-29. Inputs: `01-ui-ux-pro-max.md` … `07-slides.md` in this folder.
`docs/DESIGN_2026.md` is the visual contract; `docs/CONSOLE_UX.md` and
`docs/WAVE2_NATIVE_SMS.md` stay normative where they disagree with it.

This page resolves the contradictions the lanes found. Where a lane's number and
this page's number differ, this page wins and the reason is stated.

## 1. Settled

| Decision | Value | Why |
|---|---|---|
| Styling stack | Hand-written CSS in both apps. No Tailwind, no shadcn-svelte | `02`: 103 class selectors, 97 in use, 1,104 class attributes; the palette is the work and a utility layer would re-type it while leaving `color-mix` tints and 14 dynamic `tone` classes worse off |
| Token source | `design/tokens.css`, imported by relative path from both `app.css` files, inlined at build | `03`: the console stays prerendered and self-contained; one dev-server allowance line, no new build step |
| Token layers | `--df-p-*` primitive → `--df-*` semantic → `--df-c-*` component | `03`; the sort rule is greppable, so review can enforce it |
| Display type | Bundled Nunito (OFL, ~60 KB woff2), headings only; body system sans; mono unchanged | owner's choice; a rounded face is the cheapest warmth and costs no runtime dependency |
| Accent | Text `#B93F22` (5.14:1), fill `#C9482A` with white (4.73:1) | computed; the first draft failed its own rule |
| Metadata ink | `#6B6053` (5.37:1 on the well) | computed; `#857A6B` was 3.68:1 |
| Dock | Exactly four: **Threads · Device · Flows · Settings** | `01`: frequency, then consequence, then Android convention; "Flows" because the phone cannot execute rules |
| In a conversation | The dock is replaced by the composer | `02`: one bottom bar at a time; no floating dock over the keyboard |
| Send words | `queued · sent · failed` only | `db.rs::set_message_state_by_local_id` rejects anything else; `delivered` is M5.5 and must not appear in UI until a receipt exists |
| Answering | A second, separate axis: `answered by wf_gate v2` / `not answered · no flow matched` / `not answered · mask` | `01`: one chip cannot carry two facts without lying |
| Motion on the phone | No `mascot-idle`, no `pulse` | `01`: infinite animation on a receiver that runs from the battery; the beacon stays on the console Overview |
| Bento spans | 12 / 8 / 6 / 4 / 3 only; outer margin 2× the gutter (32/16, 24/12, 16/8) | `04` |
| Console stat row | Three cards, 6+3+3, hero figure in tabular mono | `04`: four equal 34px numerals gave no focal point, and butter on "replies sent" read as a warning |
| Icon set | 1.5px stroke on a 24px grid; faces only on Daki | `05` |
| Mascot | **Daki** — pairing success, the all-quiet panel, and the *no alerts* empty state only; never beside an error, a destructive dialog or a body, and never on "no messages yet" | `05` + `06`: a cheerful check beside an unproven thread list would claim health nobody measured |

## 2. The phone app, reimagined

The app stops being one scrolling configuration page. Four frames, one shell:

```
┌ Threads ────────────────────────┐   list → conversation
│ thread row · thread row · …     │   row: peer, last body, time,
│                                 │   send-state glyph, answered mark
└─────────────────────────────────┘
┌ Conversation ───────────────────┐   header: peer + "as this phone"
│ bubble  in                      │   bubbles: in = surface,
│ bubble  out · sent              │            out = mint tint
│ ⚠ not answered · mask           │   composer replaces the dock
└─────────────────────────────────┘
┌ Device ─────────────────────────┐   5 states, SIM, permissions,
│ live · +8801•••2829 · sim 2     │   battery-optimisation, pairing,
│ flows cached 2 · queued 0       │   revoke
└─────────────────────────────────┘
┌ Flows ──────────────────────────┐   cached graphs, versions,
│ wf_gate v2 · ran 4 min ago      │   last run, "sync now"
└─────────────────────────────────┘
```

What each frame must not do: Threads has no compose button in the dock (`01`); the
conversation never prints `delivered`; Device never shows a decorative sparkline;
Settings never hides the send-permission state behind a disclosure.

**This is not only a UI change.** Two backend gaps block it and are part of the
plan, not a later milestone:
- `Store::list_messages` has no cursor and clamps at 500, so a real thread cannot
  page. Keyset paging (50 rows, `before` on `created_at, id`) is a Rust change.
- The phone has no local send path: every outbound row today comes from a flow
  reply. A composer needs `SmsManager` send + a `queued` row + state marking from
  the Kotlin side, reusing `set_message_state_by_local_id`.

## 3. Phases

Each phase ends green on its own check; no phase starts before the previous one
passes.

| # | Phase | Files | Gate |
|---|---|---|---|
| 0 | `design/tokens.css` + Nunito, both apps point at it | `design/`, `dashboard/src/app.css`, `simulator/src/app.css` | `svelte-check` 0/0, `npm run build`, screenshots at 1360/390 unchanged in layout, only hue/radius/type |
| 1 | Console shell: sticky header in the layout, sidebar, bento overview | `routes/+layout.svelte`, `+page.svelte`, `lib/components/` | the five states still render from real API data; keyboard focus visible; no new runtime dep; prerender output self-contained |
| 2 | Console pages: devices, messages, rules, workflows | `routes/*/` | each page at 1360 and 390; tables keep mono and row density |
| 3 | Phone shell: four frames, dock, routing, Android back | `simulator/src/routes`, `+layout`/router, `app.css` | every existing panel reachable; dock 48dp targets; back returns Threads → exits |
| 4 | Threads + conversation over the local DB | `core/src/db.rs` (paging), `lib.rs` commands, phone routes | 500+ messages scroll without jank; a re-delivered broadcast never duplicates a row |
| 5 | Composer | Kotlin `SmsManager` + JNI, `core` queue | a send from the phone appears `queued → sent` locally and in the console; failure marks `failed` and offers retry |
| 6 | Daki, icons, empty states, deck | `design/`, app icon set, `docs/` | icon legible at 48px; 4 empty states; the two decision slides exist |

Phase 0 is the only one that touches both apps at once; 1–2 are console-only and
3–5 are phone-only, so they can run as parallel lanes once 0 lands.

## 3a. Found on the way (defects, not tastes)

- **The launcher icon has never shipped.** `simulator/src-tauri/gen/android/app/src/main/res/`
  has `ic_launcher_foreground.png` sets but no `mipmap-anydpi-v26/ic_launcher.xml`, so Android
  ignores them and every device shows the Tauri robot on `#3DDC84`. Fix in phase 6 with the
  "Torch" direction from `06`; the adaptive split and a per-size coordinate ladder are there.
- **Three marks, none agreed.** The favicon and `Brand.svelte` draw a navy three-bar glyph,
  the Android app shows the Tauri robot, and `design/preview.html` draws a coral flare that
  nothing renders. One mark wins in phase 6, and `--df-p-*` covers its colours.
- **`DESIGN_2026` §1's "white on `--accent-fill` 4.6:1" is 4.73:1 only after the correction
  in §1 of this page**; the original `#D9502C` measured 4.09:1. Any asset or slide copy that
  quotes a contrast number must quote it from here, not from the first draft.

## 4. Still open (owner's call)

1. **Threads vs Messages on the console**: the console has a Messages page and the
   phone has Threads. Same object, two names — pick one word for both.
2. **The phone's dark variant**: `01` asked whether a gateway phone needs it at all.
   If yes, it costs a second set of chip values and a second contrast table.
3. **Body previews in the thread list**: helpful for an operator, risky if the phone
   is ever handed to someone else. `05`'s copy assumes previews are on.
4. **Composer scope**: free-text to any number, or reply-only to existing threads?
   Reply-only is safer for a gateway and defers the send-path risk.

## 5. Phase 0 evidence (verified, not reported)

`design/tokens.css` landed with 89 primitives, 28 semantic roles and the component tokens
`03` specifies; both apps import it on line 1 of `app.css` and keep every old name as an
alias, so no component changed. Nunito (variable 400–800, latin subset, 39,128 B, OFL) is
bundled in `dashboard/static/fonts/` and `simulator/static/fonts/` and wired to
`--df-font-display`, applied to nothing yet.

Recomputed from the shipped file with WCAG 2.1 relative luminance:

| Pair | Ratio |
|---|---|
| `--df-accent-text` (`#b23b20`) on page (`#fbf6ee`) | 5.51:1 |
| `#fffdf8` on `--df-accent-fill` (`#c9482a`) | 4.65:1 |
| `--df-text-meta` (`#6b6153`) on well (`#f6efe3`) | 5.31:1 |
| `--df-text-meta` on page | 5.64:1 |

Checks run at this commit: dashboard `svelte-check` 0 errors / 0 warnings, `npm run build`
green and the primitives present in `worker/public/admin/_app/immutable/assets/0.*.css`
with `fonts/nunito-var.woff2` beside it; simulator `svelte-check` 0/0, `npm run build`
green, tokens and the font in `simulator/build/`.

Two deliberate deltas from the old console, both sanctioned by `03` §2.3: the 32px
graph-paper grid and the radial glow behind `body` are gone (cream paper replaces them),
and the primary button's white text now resolves through `--df-text-on-accent`.

## 6. Phase 3 verified on hardware (Mi A3, 2026-10-29)

The four frames run against the real database, not a stub. Threads group by peer and
open a conversation; paging is keyset 50 at a time; Device reads `+8801731382829`,
`SIM 2`, `Grameenphone`, all three permissions granted, battery not optimised, and
`no default SMS app` (a reported fact, not a missing one).

Three defects surfaced only on the phone and are fixed: the state had no stored
evidence (`updated_at` is now touched on every answered signed request, and the
pairing time is kept as `paired:<id>` and backfilled on the first poll after an
upgrade), and `sim_slot` was written 0-based while the rest of the product calls the
second tray SIM 2.

Dark mode measures clean against the tokens: body 16.07:1, the five state chips
7.41–8.66:1, the lowest pair in the phone palette 4.61:1.

## 7. Phase 5, and the thing it found

The composer is built and on the handset: reply-only, segment-accurate (160/153 GSM-7,
70/67 UCS-2, real part count), an optimistic `queued` bubble replaced by the stored row,
and the text restored with the exact reason when a send is refused. `send_sms` reaches
Kotlin through a Tauri mobile plugin; the row is written before the radio, and
`SendReceipt`/`SendStatusReceiver` now decide `sent` or `failed` from the radio's answer —
for flow replies too, which used to assume success.

The first real send exposed a hardware blocker rather than a bug: this SIM cannot send
SMS from any app (result 16 / 111; the stock messaging app says "Not sent"), so every
bubble in the thread is honestly `failed` and the console no longer mirrors replies that
never left. Receiving is unaffected.

Two design consequences that are not settled:

1. A `failed` reply is not mirrored at all (`WAVE2` §4), so the console shows an inbound
   message with no reply and no reason. Once `failed` can mean "the radio refused", the
   operator needs to see it; that needs a Worker-side decision, not a CSS one.
2. The composer's send is per-thread only. Sending to a number that never wrote first is
   still out of scope, and stays that way until the hardware can send at all.
