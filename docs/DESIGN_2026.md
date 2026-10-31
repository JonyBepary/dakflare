# DakFlare — the warm console

Status: proposed 2026-10-29, supersedes the visual language in `dashboard/src/app.css`
(not its structure). `docs/CONSOLE_UX.md` stays normative: the five device states,
the rules-vs-flows pipeline and one-reply-per-message are not style.

The console is used by one operator who watches phones that answer strangers' SMS.
Warmth buys attention — a dashboard nobody opens is a dashboard that hides a dead
gateway. It must not buy carelessness: every number an operator acts on stays mono,
high-contrast and still.

## 1. Tokens

Surfaces are cream paper, containers are pastel, ink is brown-black. Pastel is never
text: it is a container, a chip or a fill behind dark ink.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#FBF6EE` | page |
| `--surface` | `#FFFDF8` | cards, sheets |
| `--surface-2` | `#F6EFE3` | wells, table headers, sidebar |
| `--surface-3` | `#EDE3D3` | pressed, dividers in dense areas |
| `--ink` | `#241F1A` | body text, headings |
| `--ink-2` | `#5B5348` | secondary text |
| `--ink-3` | `#6B6053` | metadata, timestamps |
| `--line` | `#E7DCCB` | hairlines |
| `--line-strong` | `#D3C4AC` | input borders, focus ring base |
| `--accent` | `#B93F22` | accent **text** — 5.14:1 on `--bg` |
| `--accent-fill` | `#C9482A` | primary button fill, white text — 4.73:1 |
| `--accent-soft` | `#FBE3DA` | selected nav, tinted cards |

Pastel containers, each with a matching ink that clears 4.5:1:

| Token | Container | Ink | Used for |
|---|---|---|---|
| `--mint` / `--mint-ink` | `#DDF3E4` | `#1F6B45` | live, success, "answered" |
| `--sky` / `--sky-ink` | `#DDEBFB` | `#2A5488` | synced, informational |
| `--butter` / `--butter-ink` | `#FBEBC8` | `#7A5310` | stale, warnings |
| `--peach` / `--peach-ink` | `#FBE0D3` | `#A33218` | offline, errors |
| `--lilac` / `--lilac-ink` | `#E9E3FB` | `#4A3A8C` | workflow accent, filters |
| `--stone` / `--stone-ink` | `#EDE7DC` | `#5B5348` | unknown, disabled |

Contrast rule: operational text (state word, count, id, phone, timestamp, error) is
`--ink` or darker on a container, never pastel ink on pastel. Pastel ink is only for
chips whose text is a single word at 700 weight, where the pair above is already ≥4.5:1.

Every ratio in this document is computed with WCAG 2.1 relative luminance, not asserted.
The first draft of this section failed its own rule in three places and was corrected:
coral `#C9482A` as text was 4.39:1, white on `#D9502C` was 4.09:1, and `#857A6B`
metadata was 3.68:1 on the well. `docs/design-review/03-design-system.md` carries the
full measured table and the primitive/semantic/component naming that supersedes the flat
list below.

Radii: `--r-sm: 8px` (inputs, chips), `--r: 12px` (rows, small cards), `--r-lg: 20px`
(bento cards), `--r-xl: 28px` (page sheets), `--r-pill: 999px`.

Shadows, warm and low: `--shadow-1: 0 1px 2px rgba(74,52,26,.06)`,
`--shadow-2: 0 2px 4px rgba(74,52,26,.06), 0 12px 28px -18px rgba(74,52,26,.35)`,
`--shadow-3: 0 24px 60px -24px rgba(74,52,26,.45)` (dialogs only). Never stack two
shadows inside the same card.

Spacing stays the existing 4px scale (`--s-1..--s-8`). Nothing new.

Type: system sans for prose, mono for anything copyable (ids, numbers, counts in
tables). Sizes `--text-xs .6875rem`, `--text-s .8125rem`, `--text-m .9375rem`,
`--text-l 1.125rem`, `--text-xl 1.5rem`, `--text-display 2.125rem` (greeting and page
titles only). Display is 650 weight with `-0.02em` tracking; never used for a table cell.

## 2. Motion

One set, named, with places they are allowed. Every one is disabled wholesale by
`@media (prefers-reduced-motion: reduce)`; the reduced state is the final state, not a
0.01s animation.

| Motion | Spec | Where |
|---|---|---|
| `press` | `scale(.97)`, 90ms, `ease-out` | every button, card menu, chip |
| `lift` | `translateY(-2px)` + `--shadow-1`→`--shadow-2`, 160ms | bento cards, board cards, device rows |
| `settle` | `opacity 0→1`, `translateY(6px)→0`, 220ms `cubic-bezier(.2,.8,.2,1)`, 40ms stagger, max 6 items | first paint of a page section, list rows on navigation |
| `pop` | `scale(.8)→1.06→1`, 320ms `cubic-bezier(.34,1.56,.64,1)` | avatar entering a stack, success check, mascot reaction |
| `mascot-idle` | `translateY(0→-3px)` + blink, 4s `ease-in-out` infinite | empty state only, one instance per page |
| `pulse` | `opacity .55→1`, 2.4s infinite | the deployment beacon on Overview, and nav presence — never a row chip |

Forbidden: motion on the alert/error path, motion that delays a reading (no animated
counters, no skeleton shimmer over 1.2s, no marquee), infinite animation inside a table
or board, and any motion on a destructive confirm button.

## 3. Icons, avatars, mascot

Icons: 1.5px stroke, round caps and joins, 24px grid. Sizes 16 (dense rows), 20
(buttons, cards), 24 (nav). Existing `Icon.svelte` names stay; the set is redrawn on the
same grid rather than replaced.

Avatars: 28px circles, 2px `--surface` ring, initials at 700 in a pastel ink chosen by
stable hash of the label; stack overlap `-8px`, show three then `+N` in `--stone`. Used
for device groups and the operator, never for a phone number (a number is never
decorative and never truncated into an avatar).

Mascot: one line-drawn doodle, ink stroke 2px, appears in exactly three places — pairing
success, the "all quiet" panel, and the *no alerts* empty state. It never appears beside an
error, a destructive dialog or a message body, and never on "no messages yet": a cheerful
mark beside an empty thread list would claim health nobody has measured.

Dopamine moments (allowed, once each, never in a loop): pairing success (`pop` +
mint sheet + mascot), first message received on a device (`pop` on the row avatar), reply
confirmed by the device (`check` draws in once). Forbidden everywhere else, and
absolutely on error, destructive and alert surfaces.

## 4. Layout

12-column bento inside a fixed outer margin of 32px (24px below 720px). Internal gaps
are 16px within a group and 24px between groups. Cards may span 3, 4, 6, 8 or 12 columns
— five patterns, reused; a new width needs a reason in the PR.

- The shell: 248px sidebar (`--surface-2`, no shadow, hairline right rule), a 64px
  sticky header, content in a single scroll.
- Overview: status banner (12) → four stat cards (3 each) → devices (8) + alert/quiet
  (4) → automation board (12).
- Dense lists stay lists. A table is allowed to be a table: sticky `--surface-2` header,
  1px `--line` row rules, no per-cell cards, no zebra pastel.
- Board lanes are for automation (rules and flows), not for messages.
- One full-bleed moment per page at most, and only for the banner.

## 5. The device app

The phone app uses the same tokens and the same motion, in one column at 100% width with
24px side padding, `--r-xl` sheets, and no sidebar. It keeps its dark variant for use in a
pocket at night: dark surfaces are `#1C1814` / `#262019`, and state chips switch to a
light ink on an opaque dark tint of the same hue. A 12% alpha pastel keeps the pastel ink
at 1.4–2.0:1, which is unreadable; the dark chip values come from
`docs/design-review/03-design-system.md` and are not restated here. Pairing success is the
one dopamine moment; the carrier panel keeps mono for the injected number and body.

## 6. What must not change

- The five device states and their chips (`CONSOLE_UX.md` §2), and `push` / `poll-only`.
- Rules vs workflows, one reply per message, and `reply_source` on the row.
- Mono for ids, phone numbers, versions, counts in tables. A phone number is never
  abbreviated in a data row — it may be masked only where the protocol already masks it.
- Focus rings: 2px `--accent` offset 2px on every interactive element, visible on cream,
  pastel and dark.
- The dashboard remains a prerendered static build with no new runtime dependency.
