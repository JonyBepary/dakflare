# 02 · UI styling: the stack question and the phone shell

Status: review, 2026-10-29. Read-only on application code; this file is the only
change. Lane: styling and component behaviour. Tokens, colour and type values are
`docs/DESIGN_2026.md`; this document consumes them and does not restate them.

What this is based on: `dashboard/src/app.css` (1,657 lines), the 43 `.svelte`
files under `dashboard/src` (34 components / 6,870 lines, 7 route pages / 5,665
lines), `dashboard/src/routes/+layout.svelte`, `simulator/src/app.css` (155
lines), `simulator/src/routes/+page.svelte` (658 lines), `design/preview.html`,
`docs/CONSOLE_UX.md`, `docs/WAVE2_NATIVE_SMS.md`, `simulator/core/src/db.rs`,
`simulator/core/src/carrier.rs`, `simulator/src-tauri/src/lib.rs`,
`simulator/src-tauri/gen/android/`.

---

## 0. Verdict, in five lines

1. **No Tailwind, no shadcn-svelte.** Keep hand-written CSS. The console has 103
   global classes and six of them are dead — there is no sprawl to fix, so the
   tool would buy nothing and cost 43 files.
2. **Use bits-ui on the phone only**, where it already is (`bits-ui@2.20` in
   `simulator/package.json`). Its value is focus trapping and dismissal, not
   styling. Nothing new is installed.
3. The phone becomes a real SMS app with **three screens, one bottom bar at a
   time**, and a composer that never sits on top of the dock.
4. Send state is **three words, not four**: `queued · sent · failed`. The store
   refuses `delivered` (`StoreError::InvalidState`) and SMS has no receipt.
5. The console skin is a **token swap plus four structural changes** (shell
   header, page header, stat grid, banner placement). 26 of 34 components are
   touched by tokens only.

---

## 1. The stack question

### 1.1 What exists today

| | dashboard | simulator |
|---|---|---|
| Runtime deps | `@xyflow/svelte`, `qrcode-generator` | `bits-ui@2.20`, `@tauri-apps/api`, `plugin-opener` |
| Kit / Vite | Kit `^3.0.0`, Vite `^8.3` | Kit `^2.65`, Vite `^8.0` |
| Render | `ssr = false`, `prerender = true`, adapter-static | adapter-static, `fallback: index.html` (SPA) |
| CSS | `app.css` 1,657 lines + 4,143 lines scoped in 22 files | 155 lines, one global sheet |
| Classes in markup | 1,104 class attributes, 475 distinct names | ~40 |

`app.css` defines 103 class selectors; 97 are used somewhere, 6 are dead
(`.dot-pulse`, `.form-section`, `.notice-info`, `.notice-ok`, `.notice-warn`,
`.truncate`). So the global layer is ~100 classes and stable. The other ~378
distinct class names live inside component `<style>` blocks, which is where the
real 4,143 lines are.

That shape matters for the decision: **the console is not a styling problem, it
is a token problem.** The class surface is small, named and consistent
(`.panel`, `.btn`, `.field`, `.table`). What is wrong is the palette, the radii,
the density and two motion values. Replacing the authoring tool does not fix
any of those; it re-types 1,104 attributes and leaves the palette exactly as it
is until the tokens change.

### 1.2 Measured migration cost

| Option | Files touched | Class strings | New deps | Real risk |
|---|---|---|---|---|
| Tailwind only | 43 | 1,104 (plus 4,143 scoped lines re-expressed) | `tailwindcss`, `@tailwindcss/vite` | 14 dynamic class expressions and 34 `class:` directives become variant maps by hand; `color-mix()` derivations become arbitrary values |
| shadcn-svelte | 43 + ~9 generated components | same, plus Dialog/Select/Table/Tabs rewritten | above + `bits-ui@3`, `clsx`, `tailwind-merge`, `tailwind-variants`, `@lucide/svelte` | a second token vocabulary (`bg-background text-foreground`) beside `--bg / --surface / --ink`; `Icon.svelte` replaced by lucide |
| Hand-written + primitives | 4–6 | 0 | 0 (bits-ui already in the phone) | none structural; needs a discipline note, not a dependency |

The dynamic-class problem is concrete, not theoretical. These are live today:

- `Badge.svelte` → `class="badge badge-{tone}"`
- `Notice.svelte` → `class="notice notice-{tone}"`
- `ConfirmDialog.svelte` → `class="btn {tone === 'danger' ? 'btn-danger-solid' : 'btn-primary'}"`

Under Tailwind none of those strings exist in source for the scanner to find, so
each becomes an explicit `Record<tone, string>` map or a `safelist` entry. That
is 14 expressions to convert, each one a place to forget a tone. Under the
current CSS they are free, because `badge-ok` is a real selector in a real
stylesheet.

On `color-mix`: the design language derives most of its tints this way
(`.badge-ok`, `.btn-danger`, `.nav-link[aria-current]`, `--accent-soft` at 12% in
dark). Tailwind can express it —
`bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]` — but that is a class
name longer than the selector it replaces, repeated in 30 places. That is worse
than the CSS it deletes.

**Prerender is not a factor, and I will not pretend it is.** `@tailwindcss/vite`
runs in the Vite build; `ssr = false` with `prerender = true` produces an empty
shell either way, and CSS is a static asset in both cases. Anyone arguing
"Tailwind breaks prerender" is wrong. The case against is maintenance per unit of
visual change, at a repo where one person owns the whole UI.

### 1.3 Verdict

**Stay hand-written CSS. Do not add Tailwind. Do not add shadcn-svelte.**

Three reasons, in order of weight:

1. **The token layer is the work, and every option keeps it.** `DESIGN_2026.md`
   §1 replaces the palette, the radii and the type scale. That is a ~120-line
   diff in `:root` plus a handful of component fixes. Tailwind adds a second
   layer on top of the same diff; it does not remove it.
2. **shadcn-svelte imports a vocabulary that collides with ours.** Its components
   assume `bg-background`, `text-muted-foreground`, `border-border`. We have
   `--bg`, `--ink-3`, `--line`. Either every generated component is forked to our
   names (then it is no longer "copy-paste, upstream" and the update path is
   gone), or both vocabularies coexist and the codebase teaches two ways to grey
   out text. Both outcomes are worse than 100 hand-written classes.
3. **`DESIGN_2026.md` §6 forbids a new runtime dependency, and the prohibition is
   right for the reason it gives.** The prerendered console is a static asset
   bundle served from the Worker; it should stay one HTML file, one CSS file, one
   JS bundle. bits-ui in the dashboard would break that for dialogs we already
   implement correctly with native `<dialog>` (`ConfirmDialog.svelte` — focus
   return, `cancel` handling, backdrop, `$props.id()` for the label).

What I would add instead, and it is not a library: a **primitives block at the
top of `app.css`** — `.panel`, `.btn`, `.field`, `.chip`, `.table` — treated as
a public API with a rule that a new page composes them and does not invent a
fourth button style. That rule is the thing Tailwind would have enforced, and it
is enforceable in review with `grep`.

### 1.4 The one dependency, and where it is allowed

`bits-ui` is already a dependency of the phone app and is used for
`AlertDialog` and `Switch` (`simulator/src/routes/+page.svelte:4`). Keep it, and
use it for the one surface where re-implementing the behaviour is genuinely
error-prone:

- the **SIM picker sheet** — dismissal layer, focus trap, scroll lock, focus
  return. (A native `<dialog>` also does all four; see §2.6. Prefer `<dialog>`
  for consistency with the console and for the Android back-button story.)
- **nothing else.** Toasts, chips, dock, rows and composer are markup plus CSS.
  A toast library for eight lines of `$state` is a dependency tax with no
  accessibility gain over one correctly-built live region.

So: **no new package anywhere in this lane.** That is the entire budget.

### 1.5 If the owner overrules me

Rewrite in this order, and stop after step 3 if the budget runs out — the app is
still shippable at each step.

1. `app.css:1-149` → `@theme` with `--color-bg`, `--color-ink`, `--color-line`,
   `--color-accent*`, and the six pastel pairs mapped to `--color-mint` etc.
   Keep the CSS variables as the source of truth (`--color-ink: var(--ink)`) so
   dark mode via `[data-theme]` keeps working without `dark:` variants.
2. The five primitives only: `Button`, `Panel`, `Field/Input`, `Chip`, `Table`.
   Those are ~60 of the 103 global selectors and cover 80% of markup usage
   (`btn` 90 uses, `input` 40, `field` 39, `panel` 36, plus `mono`/`hint`).
3. `+layout.svelte` shell (rail + header).
4. **Stop.** Leave the 7 route pages and their scoped `<style>` blocks alone
   forever. A route page that mixes utilities and a scoped block is fine; a route
   page that is *half-converted* is the thing that makes the next change
   expensive. Convert whole files or not at all.

What stays in every scenario: `WorkflowEditor.svelte` and the other 14
`workflow/*` components (1,225 + ~2,200 lines — xyflow owns its own canvas
styling, and the node cards are the only part we style), `Icon.svelte`,
`QrCode.svelte`, and all prerender config.

### 1.6 Typography: no new face, and the reason is Bangla

The house rule is system sans plus mono (`app.css:12-16`). The styling instinct
is to pick a distinctive face. Do not, and the reason is in the data, not in
taste:

- SMS bodies here are frequently Bangla — `design/preview.html:442` shows
  `আপনার অফারটি আজই নিন…` in a thread. On Android, system sans resolves to
  Roboto + Noto Sans Bengali. A bundled Latin-only display face would render a
  Bangla body in a fallback with a different x-height and a different line
  height, mid-thread, on the one screen where the user reads the most.
- Any face that covers Bengali well is 400 KB+ per weight. That is a runtime
  asset in a Tauri APK and a prerendered console, to save nothing.

Where character is allowed to live instead: **weight, tracking and the mono**.
The display sizes (`--text-xl`, `--text-display`) at 650 weight with `-0.02em`
are already doing the work that a display face would, and the mono
(`ui-monospace` stack) is the identity of the console. The phone gets its warmth
from the pastel containers and the mascot, not from a typeface.

If someone still wants a face, the rule is: **`--font-sans` never changes; add
`--font-display` used only on numerals and page titles, self-hosted, Latin
subset, `font-display: swap`, and never on an SMS body or a Bangla string.**

---

## 2. The phone app

### 2.1 The shell, and the one rule about bottom bars

Today `simulator/src/routes/+page.svelte` is a 658-line diagnostics page: target
URL, pair code, identity, device list, carrier inject, raw thread. It is a lab
bench. The owner wants a real SMS app. Those two things can coexist, but not on
one scrolling page.

**Three screens, and the settings move behind the third:**

```
┌─────────────────────────────┐   ┌─────────────────────────────┐
│ Messages           ⚙ (opt)  │   │ ‹ Back   Alex              │
│ answering for +8801…2829    │   │ answering for +8801…2829    │
├─────────────────────────────┤   ├─────────────────────────────┤
│ ● Alex            18:42  2  │   │  ┌──────────────┐           │
│   DAKFLARE-GATE-1 hello…    │   │  │ 2 messages   │           │
│ ─────────────────────────── │   │  │ from Alex    │  (in)     │
│   GP Info        17:10      │   ├──┴──────────────┴───────────┤
│   <Bangla body: Bangla>     │   │  DAKFLARE-GATE-1 second run │
│ ─────────────────────────── │   │           18:42 ✓ sent  (out)│
│   Unknown        16:03  1   │   │                             │
│   (no reply — quiet hours)  │   ├─────────────────────────────┤
│                             │   │ [Message Alex…        ] SIM2│
│                             │   │ [                     ][→]  │
├─────────────────────────────┤   └─────────────────────────────┘
│  ✉ Messages  ▢ Device  ⚙ …  │        no dock in a thread
└─────────────────────────────┘
```

(The third thread's body is Bangla in the seed data — `design/preview.html:442`
— drawn here as a placeholder so the columns line up in a monospace block.)

The rule: **one bottom bar per screen. Inside a thread the dock is gone and the
composer is the bottom bar.** Stacking a 60px dock under a 64px composer costs
124px of a 640px viewport and puts the send button outside comfortable thumb
reach. Every native SMS app does this and it is the single most common mistake
in "chat UI" mockups.

Dock items: **Messages · Device · Settings** (three; four is the ceiling). No
dock before pairing — a dock with one working tab is a lie, and the pairing
screen is the onboarding (`WAVE2_NATIVE_SMS.md` §3: the permissions screen must
explain the gateway before the system dialog). Pairing → dock.

Conversely, the thread must not read as a personal chat that the operator is
typing. This is where the owner's ask and the product collide, and I am calling
it explicitly:

- every thread header carries a second line, `answering for +8801…2829`, in
  `--ink-3` at `--text-s`. It is the phone's identity, not the operator's.
- the composer placeholder is `Message Alex as this phone`, not `Message Alex`.
- a bubble answered by a flow carries `auto · wf_gate v2` in its meta line, so a
  human override is visually distinguishable from the machine. That is a
  console guarantee (`CONSOLE_UX.md` §1, one reply per message) leaking into the
  phone, which is correct: the operator must be able to tell what the phone did
  on its own.

### 2.2 Component inventory

Rows are the contract. "Target" is the minimum interactive box; Android's floor
is 48dp, so 48 is the number, and 44 is only the fallback for a control that
lives inside text.

| # | Component | Root element | Role / name | Target | Focus order |
|---|---|---|---|---|---|
| 1 | Dock | `<nav aria-label="Sections">` | links, `aria-current="page"` | 48 × 64 | last, after content |
| 2 | Thread row | `<a>` in `<li>` | link; name = label + preview + time + unread | 76 tall | one stop per row |
| 3 | Message bubble | `<li>` in `<ol>` | list item; sr-only sender prefix | n/a (no controls) | not focusable |
| 4 | Composer | `<form>` | `textarea` + submit | 48 send | after the list |
| 5 | SIM sheet | `<dialog>` | `aria-labelledby` | 56 per row | radio group, roving |
| 6 | State chip | `<span>` | not a live region | n/a | not focusable |
| 7 | Toasts | `<div role="status">` | one polite, one assertive region | 48 close | n/a |
| 8 | Permission banner | `<section role="status">` | two buttons | 48 | before the list |
| 9 | Empty state | `<section aria-labelledby>` | heading + one action | 48 | after the banner |

#### 1. Dock

- `<nav aria-label="Sections">` — **not** `role="tablist"`. Tabs imply
  `aria-controls` and a panel that swaps in place; these are routes, and the page
  changes. A roving tabindex is wrong here too: links are naturally tabbable and
  Tab should move through them.
- Item: icon 24 + label at `--text-xs` **always visible**. Icon-only docks with
  tooltips fail recall for the two labels an operator uses least.
- Active: `aria-current="page"` plus an ink change *and* a 6px coral dot beneath
  the item. Not a pill background — a filled pill in a bottom bar reads as
  Material 2 and fights `--r-xl` sheets.
- Geometry: `height: 60px; padding-bottom: max(var(--inset-b), 8px)`;
  `background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(12px); border-top: 1px solid var(--line)`. `left: 0;
  right: 0` — never `width: 100vw` (overflows when a scrollbar or inset exists).
- Counts: a badge is text (`2`), not a dot, and it is inside the label's
  accessible name, not an `aria-label` on the link.

Svelte 5 pattern — one array, one derived, no component library:

```svelte
{#each DOCK as item (item.href)}
  <a href={item.href} aria-current={active === item.href ? 'page' : undefined}>
    <Icon name={item.icon} size={24} />
    <span>{item.label}</span>
  </a>
{/each}
```

Overflow (4 items at 320px) is handled by the pattern the console already
proved at `+layout.svelte:110-120`: an `$effect` that reads `page.url` and
scrolls the active item to the left edge. Reuse it rather than inventing one.

#### 2. Thread rows

- `<ul>` → `<li>` → `<a class="thread-row">`. The row is **one link**. No nested
  buttons: a mute/archive control inside the row is a 48px hole in a link, and
  the tap that was meant for the row lands on the wrong thing.
- Accessible name is built from real text, in reading order: label, then
  `<span class="sr-only">Last message: </span>` + preview, then
  `<time datetime>`, then `2 unread` as visible text (a pastel chip) rather than
  colour. Do not put the whole preview in `aria-label`: some screen readers read
  the label *instead of* the link text and the preview then cannot be
  re-read or selected.
- The preview is `-webkit-line-clamp: 1` with `overflow-wrap: anywhere`; the
  phone number in the meta line is mono and **never truncated** (`DESIGN_2026.md`
  §6).
- Unread is never a dot. `2 unread` or nothing.
- 76px row: 40px avatar, two text lines, one meta column. 76 is not a magic
  number — it is 48dp of target plus two lines of `--text-s` at 1.4.

Svelte 5: rows are plain `{#each threads as t (t.peer)}`. If the list ever
virtualizes (it will not at these volumes), add `aria-setsize` and
`aria-posinset` — removing rows from the DOM without them makes a screen reader
announce "1 of 12" for a list of 300.

#### 3. Message bubbles

- `<ol class="bubbles">` in **chronological DOM order**, each message an `<li>`.
  Not `flex-direction: column-reverse` to get stick-to-bottom: that reverses DOM
  order, and a screen reader then reads a conversation backwards. Scroll
  programmatically instead (§3.3).
- Direction is carried by alignment **and** text. Inside each bubble, a
  visually-hidden prefix: `You said` / `Alex said`. Colour and side alone fail
  every colour-blind and every screen-reader user.
- Meta line: sender (only on the first bubble of a run), `<time datetime>`, and
  the state chip. `user-select: text` on the body; `overflow-wrap: anywhere`;
  no fixed height.
- Bubbles contain **no buttons**. Native long-press selection plus the OS copy
  menu is the right interaction and it is free. A "more" button inside a 68px
  bubble is a 48px hole in a text block.
- Links in the body are linkified to `http(s)` and `tel:` only, with
  `rel="noopener noreferrer"`. **An SMS body is untrusted input** and this is a
  Tauri webview with `csp: null` (`tauri.conf.json`) — a `javascript:` href in a
  message is remote code execution in the app shell. This is the one place where
  a styling review outranks styling.

Line height and radius: body `--text-m` at 1.45, bubble `--r-lg` with the
sender-side corner at `--r-sm`:

```css
.bubble { border-radius: var(--r-lg) var(--r-lg) var(--r-lg) var(--r-sm); }
.bubble[data-dir='out'] { border-radius: var(--r-lg) var(--r-lg) var(--r-sm) var(--r-lg); }
.bubble[data-dir='in']  { background: var(--surface); border: 1px solid var(--line); }
.bubble[data-dir='out'] { background: var(--accent-soft); }   /* container, ink text */
```

`--accent-soft` is a container, so `--ink` on it is legal under `DESIGN_2026.md`
§1. Pastel ink on pastel is not, and a bubble is not a chip.

#### 4. Composer

- `<form>` with a `<label class="sr-only" for="c">Message Alex as this phone</label>`
  and a `textarea` that autosizes to 5 lines (≈120px) then scrolls internally.
- Attributes that matter on this keyboard: `enterkeyhint="send"`,
  `autocapitalize="sentences"`, `autocomplete="off"`, `resize: none`,
  `maxlength` unset (the segment counter is the feedback, not a hard cap).
- **Enter does not send.** Enter inserts a newline; the send button sends;
  Cmd/Ctrl+Enter sends on a hardware keyboard. This removes the single most
  common SMS-app defect: a message sent mid-sentence because a thumb brushed
  Enter.
- Send: 48 × 48, `type="submit"`, `aria-label="Send"`, `disabled` only when the
  trimmed body is empty or a send is in flight, `aria-busy` while in flight.
  Focus stays in the textarea after submit — never jump to the new bubble.
- SIM chip, left of the send button: a 48-tall button, `aria-haspopup="dialog"`,
  label `Sending from SIM 2, Grameenphone. Change.` The composer must never
  leave the SIM implicit; on a dual-SIM phone a wrong-SIM send is unrecoverable.
- Segment counter, `aria-describedby` from the textarea and **not** `aria-live`:
  `2 SMS · 128/134`. Compute the encoding, do not count characters:

  | Charset | Single | Concatenated |
  |---|---|---|
  | GSM-7 | 160 | 153 |
  | UCS-2 | 70 | 67 |

  Bangla is UCS-2, so `আপনার অফারটি আজই নিন` is 70 per part, not 160. A counter
  that says `22/4096` (which is what `SendSmsForm.svelte:216` does today) is a
  counter that lies in the one market this product serves. Write it once as
  `lib/sms.ts → segments(body): { parts, used, perPart, charset }` and let the
  console's composer adopt it later.
- Draft survival: keep the body in `$state` and mirror to `sessionStorage` keyed
  by peer. A failed send must never eat the text.

```svelte
<script lang="ts">
  let body = $state('');
  let sending = $state(false);
  let el = $state<HTMLTextAreaElement | null>(null);
  const seg = $derived(segments(body));
  const canSend = $derived(body.trim().length > 0 && !sending);

  // Autosize: height resets before measuring, or scrollHeight never shrinks.
  $effect(() => {
    void body;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  });
</script>

<textarea bind:this={el} bind:value={body} aria-describedby={segId} />
```

No attachment for this one — an attachment wires DOM once and would not re-measure
on a keystroke. Attachments are the right tool for the scroll pin (§3.3), which
is exactly a one-time observer.

#### 5. SIM picker sheet

Native `<dialog>` + `showModal()`, the pattern already in
`ConfirmDialog.svelte` (104 lines, focus return included). A sheet is a dialog
with `margin: auto auto 0`:

```css
dialog.sheet {
  margin: auto auto 0;
  width: 100%;
  max-width: 560px;
  max-height: min(85dvh, 560px);
  border-radius: var(--r-xl) var(--r-xl) 0 0;
  padding-bottom: max(var(--inset-b), 16px);
}
```

- Contract: `aria-labelledby` on the heading; content is a real
  `<fieldset><legend class="sr-only">Send from</legend>` with native
  `<input type="radio">` rows at 56px. Native radios give arrow-key navigation
  inside the group and Tab out of it — a custom listbox does not, and a
  `<select>` cannot show carrier + number + "default" on three lines.
- Focus on open: the checked radio, explicitly, in `tick()` (mirror
  `ConfirmDialog.svelte:38-40`). On close, the platform returns focus to the
  trigger — that is spec behaviour, do not re-implement it.
- **Android back does not send Escape.** Push a history entry when the sheet
  opens and close on `popstate`:

  ```ts
  history.pushState({ sheet: 'sim' }, '');
  const onPop = () => (open = false);
  // add on open, remove on close
  ```

  Without this, the back gesture leaves the thread while the sheet is open.
  Verify early whether Tauri's Android back is routed to WebView history or to
  `finish()`; if it is the latter, the same handler hangs off Tauri's back
  event. Either way the acceptance test is: *sheet open → back → sheet closes,
  thread still visible.*
- Backdrop tap closes; a drag-handle is optional and must also be a 48px
  keyboard-reachable button labelled `Close`.

#### 6. State chips

The vocabulary is fixed by the store, not by the design:

| Direction | `state` column | Chip |
|---|---|---|
| out | `queued` | butter · `queued` |
| out | `sent` | mint · `sent` |
| out | `failed` | peach · `failed` |
| in | `received` | **no chip** |

`set_message_state_by_local_id` rejects anything but
`queued | sent | failed` (`simulator/core/src/db.rs:692`), and a device-sent
reply has no command at all, so **there is no `delivered` and no double tick on
a bubble.** The four-stage lifecycle (`queued → acked → sent → delivered`) lives
on the *command*, in the console's `CommandTracker`, and is already visually
distinct there (uppercase mono badge with a dot). Keep the two vocabularies
apart: uppercase for commands, lowercase word for message rows.

Rules:

- word always present, icon optional, colour never alone;
- the chip is **not** a live region. One `<p class="sr-only" aria-live="polite">`
  per thread announces transitions (`Message to Alex sent`). `aria-live` on 500
  chips is 500 announcements;
- `failed` carries the reason via `aria-describedby` to a
  `<p class="bubble-error">` and a 48px `Retry` under the bubble, wired to the
  store's existing retry path (`→ 'queued'`);
- `queued` that lasts longer than ~20s shows `queued · 20s` — a stuck queue is
  the failure this product exists to make visible.

```ts
const CHIP = {
  queued: { label: 'queued', tone: 'butter', icon: 'clock' },
  sent:   { label: 'sent',   tone: 'mint',   icon: 'check' },
  failed: { label: 'failed', tone: 'peach',  icon: 'alert' }
} as const satisfies Record<'queued' | 'sent' | 'failed', ChipSpec>;
```

Typed `satisfies` means a fourth backend state fails `svelte-check` instead of
rendering an empty chip at runtime. Same trick for the dock and the toasts.

#### 7. Toasts

- Two regions, mounted once at the root:
  `<div role="status" aria-live="polite">` for success and
  `<div role="alert">` for failure. Two, because a failure must interrupt and a
  "Copied" must not.
- Max 2 visible, newest nearest the bottom bar; success auto-dismisses at 5s;
  failure stays until dismissed and carries one action plus a 48px close. Swipe
  is never the only dismissal.
- Container `pointer-events: none`, toast `pointer-events: auto` — otherwise a
  toast over the composer eats the tap.
- **No toast for anything that already has a home.** A failed message lives on
  its bubble. Toasts are for actions with no landing place: copied, SIM switched,
  "cleared 12 messages".
- Motion: `settle` in. On the error path, no animation at all — `DESIGN_2026.md`
  §2 forbids motion on the alert path, and a sliding error is the tell of a
  template.
- Svelte 5: a module-level `toasts.svelte.ts` with `$state<Toast[]>([])` and a
  `push()`; the repo already uses this pattern (`session.svelte.ts`,
  `live-clock.svelte.ts`).

#### 8. Permission banner

This is the highest-consequence surface in the app and it is currently a log line
(`MainActivity.kt`: `Log.w("DakFlareSms", "SMS permissions not granted; gateway
stays disabled")`).

- Persistent inline banner under the thread header while `SEND_SMS` or
  `RECEIVE_SMS` is missing. Not a toast (dismissible = ignorable), not a dialog
  (blocks reading history that is still useful).
- `<section role="status" aria-labelledby="perm-title">` on first appearance;
  `role="note"` on later launches so it is not re-announced every resume.
- Butter container, `--ink` text, no mascot (`DESIGN_2026.md` §3: never beside an
  error), two buttons at 48px: `Allow SMS` (primary) and `Not now` (ghost).
- Copy, literal, no euphemism: *"DakFlare cannot send or receive texts until you
  allow SMS."* Second line: *"It answers for you, even when the screen is off."*
- The second tap after a permanent denial must open app settings, not a dead
  button. **This needs a command that does not exist**: `invoke_handler` has 17
  commands and none queries or requests permissions. Required contract:
  `sms_permission_state() -> 'granted' | 'denied' | 'blocked'` and
  `open_app_settings()`. Until then the banner can only say "restart and allow" —
  which is a lie the design should not paper over.
- Never re-request on every resume. Android stops showing the dialog after two
  denials and the button becomes decorative.

#### 9. Empty state

Four of them, and they are not the same component instance:

| Where | Copy | Action |
|---|---|---|
| No threads, paired | "No texts yet." + mascot | none |
| No threads, unpaired | "Pair this phone to answer for you." + mascot | Pair |
| Thread with no messages | "Nothing here yet." | none |
| Search, no match | "No text contains that." | Clear search |

- `<section aria-labelledby>` + `aria-hidden="true"` mascot + one action. Not a
  live region; an empty state that announces itself on every navigation is noise.
- Mascot: once per screen, idle bob 4s, off under `prefers-reduced-motion`
  (final state, not 0.01s — `DESIGN_2026.md` §2).
- The unpaired variant is the onboarding, so it is the one place the dock is
  absent and the only decoration allowed is the mascot.

---

## 3. One-handed, keyboard, scroll, and 5,000 messages

### 3.1 Insets: the double-padding trap

`MainActivity.kt` already pads `android.R.id.content` by
`systemBars() or displayCutout()` and explains why:

> `env(safe-area-inset-top)` is not reliably exposed inside Android WebView, and
> a hard-coded margin would be wrong on cutouts, landscape and tablets.

Consequence: **do not add `env(safe-area-inset-bottom)` to the dock.** The
webview viewport is already inset, `position: fixed; bottom: 0` already lands
above the navigation bar, and adding the env value double-counts by ~48px on a
gesture-nav phone.

Contract:

```css
:root { --inset-b: 0px; }        /* Android: MainActivity pads. Do not add env(). */
```

One variable, one place to change, and a comment pointing at `MainActivity.kt`.
If a future build stops padding the content view, `--inset-b` becomes
`env(safe-area-inset-bottom)` in that single line and nothing else moves.

Also: `height: 100dvh`, not `100vh`, on the app root, and `min-height: 0` on the
scrolling child. The current `simulator/src/app.css:32` does
`html, body { height: 100% }` — the exact pattern that breaks when the viewport
changes height under the keyboard.

### 3.2 Keyboard

The activity pads for system bars but **not for the IME** — `Type.ime()` is absent
from the listener — and `windowSoftInputMode` is not set in the manifest
(defaulting to unspecified). So today the composer is *covered* by the keyboard,
or the whole webview pans and the header leaves the screen. Neither is acceptable
and neither is fixable from CSS alone.

Preferred fix, native, ~4 lines, in the listener that already exists:

```kotlin
val bars = insets.getInsets(
  WindowInsetsCompat.Type.systemBars() or
  WindowInsetsCompat.Type.displayCutout() or
  WindowInsetsCompat.Type.ime()
)
```

Once the webview is resized rather than covered, a composer with
`position: sticky; bottom: 0` inside a full-height column sits above the keyboard
with **zero JavaScript**. That is the whole feature.

Set `android:windowSoftInputMode="adjustResize"` explicitly so an OEM default
cannot turn the IME into a pan.

CSS-only fallback (desktop webview, and if the native change is rejected): a
`visualViewport.resize` listener writing
`--kb: calc(100dvh - ${vv.height}px)` and `bottom: var(--kb)` on the composer.
Do not ship that on Android alongside the native resize — the two fight and the
composer flickers during the IME animation.

### 3.3 Scroll anchoring

Three rules, and one bug to design out:

1. `overflow-anchor: none` on the list — we anchor ourselves.
2. Track the pin: `atBottom = scrollHeight - scrollTop - clientHeight < 24`,
   updated in a `requestAnimationFrame`-throttled scroll handler.
3. After every mutation: if pinned, jump to the bottom inside `tick()` (before
   paint); if not pinned, restore from a saved distance-from-bottom. Never use
   `scrollIntoView({ behavior: 'smooth' })` — it queues, lands late, and lands
   wrong when a font or image arrives after it.

```svelte
{#each messages as m (m.id)}…{/each}
{@attach (node) => {
  const pin = () => { if (atBottom) node.scrollTop = node.scrollHeight; };
  const ro = new ResizeObserver(pin);
  ro.observe(node.firstElementChild ?? node);
  return () => ro.disconnect();
}}
```

A `ResizeObserver` on the content beats a `$effect` on `messages.length`,
because a bubble can grow after the fact (font load, long-press selection,
keyboard dismiss).

When not pinned and a new message arrives: a 48px `2 new messages ↓` pill,
`aria-live="polite"` on the count only. Also `overscroll-behavior: contain` so
the thread does not rubber-band the page, and
`scroll-padding-bottom: calc(var(--composer-h, 72px) + 8px)` — measured from the
composer, not the dock, because inside a thread the composer *is* the bottom bar
(§2.1). Set `--composer-h` from a `ResizeObserver` on the composer, or Tab will
land on a bubble hidden behind it as soon as the textarea grows to five lines.

### 3.4 Virtualization for a 5,000-message thread

The hard constraint is not in the browser, it is in the store:

- `list_messages` takes `limit` only and clamps it to `1..500`
  (`simulator/src-tauri/src/lib.rs:386-396`).
- `Store::list_messages` is `ORDER BY created_at DESC, id DESC LIMIT ?`
  (`simulator/core/src/db.rs:501-530`) — **no cursor, no offset**.
- The index `idx_messages_device(device_id, created_at DESC)` already exists
  (`core/src/db.rs:65`).

So today the phone can never hold more than 500 rows and can never see older
ones. Any 5,000-message design is fiction until keyset paging exists. The change
is small and belongs to the core lane:

```sql
SELECT … FROM messages
 WHERE device_id = ?1 AND (created_at, id) < (?2, ?3)
 ORDER BY created_at DESC, id DESC LIMIT ?4
```

with a `before_created_at` / `before_id` pair on the command. `(created_at, id)`
is a row-value comparison SQLite handles; the existing index covers the leading
column and the tiebreak is rare.

Recommended approach, in order:

1. **Keyset pages of 50**, triggered by an `IntersectionObserver` on a top
   sentinel with `rootMargin: '800px'`. Keep ≤400 rows in memory. Zero
   dependencies.
2. **`content-visibility: auto` + `contain-intrinsic-size: auto 64px`** on each
   bubble. Chrome/Android WebView skips layout and paint for offscreen rows and
   remembers their real heights after first render, which is exactly the
   variable-height problem that makes windowing chat bubbles painful. This is the
   highest-value line of CSS in this document.
3. `$state.raw<Message[]>` for the array. Deep-proxying a few thousand message
   objects to render plain text is pure overhead; replace the array on change.
4. **Only if "jump to a date" or in-thread search ships**: `@tanstack/svelte-virtual`
   with measured rows and a height cache. That is ~40% more code in the list
   component and a second source of truth for scroll position. Do not pay it
   early.
5. In-thread search is a SQL query (`LIKE`, indexed on peer), not a client-side
   filter over loaded rows. Filtering only what is loaded is the bug where search
   "finds nothing" on a thread that has the text.

Never render 5,000 nodes: on a mid-range phone every insert forces a full
re-anchor and layout of the list, which is a 60–120ms hitch on the screen the
user is looking at while waiting for a send state.

The thread *list* needs none of this. Hundreds of rows, plain list, same
`content-visibility` trick.

### 3.5 Thumb and focus order, per screen

- Bottom 25% of the screen owns dock, composer, send, and the retry on a failed
  bubble. Nothing destructive in the top-right: the header holds back, title and
  one overflow menu, all ≥48px.
- Reach test at 360 × 800 with one thumb: no primary action requires a hand
  shift.
- Tab order is DOM order: banner → thread header → list (`tabindex="-1"` so
  navigation can focus the messages, not the back button) → composer →
  SIM → send. On the thread list, the dock comes last.
- Hardware keyboard: Esc closes the sheet, Ctrl/Cmd+Enter sends, arrows move
  within the SIM radio group. Nothing else needs a shortcut.

---

## 4. The console under the new skin

### 4.1 Carries untouched (tokens reach them or nothing does)

29 of the 34 components need a token pass at most; 5 need real work. Nothing in
this list is deleted.

| Component | Why |
|---|---|
| `Icon.svelte` (148) | 1.5px stroke set redrawn on the same 24 grid; names unchanged. Needs 5 new names for the phone: `settings`, `search`, `chevron-left`, `contact`, `more`. |
| `Spinner.svelte`, `RelativeTime.svelte`, `CopyButton.svelte` (67) | behaviour only |
| `QrCode.svelte` (153) | library render, one container colour |
| `ThemeToggle.svelte` | one `.btn-icon`; inherits 48px on touch |
| `PresenceChip.svelte` (43) | composes `Badge`; the five device states are normative and unchanged |
| `Badge.svelte` (16) | internal class name changes to `.chip`; props and call sites unchanged |
| `Notice.svelte` (27) | tokens only; it already has `role="alert"` on danger |
| `ConfirmDialog.svelte` (104) | native `<dialog>` already correct; radius + shadow tokens only |
| `SendSmsForm.svelte` (315) | tokens only, then swap its character counter for `segments()` |
| `CommandTracker.svelte` (523) | keep the uppercase command vocabulary; re-chip colours |
| `RuleTestPanel.svelte` (435), `AutomationHeader.svelte` (115) | scoped CSS, token-only |
| `workflow/*` — 15 files, 3,439 lines, incl. `WorkflowEditor` (1,225) | xyflow owns the canvas; node cards, inspector and palette inherit tokens and keep their scoped CSS |

The 5 that need more than a token pass: `Brand` (19 — pastel mark, sans
wordmark), `PageHeader` (24 — splits in two), `AlertBanner` (335 — moves out of
`.main` so it can be full-bleed), `DeviceDetail` (1,010 — the drawer becomes an
`--r-xl` sheet), `EmptyState` (23 — mascot slot and four variants). Plus
`+layout.svelte` itself (§4.2a), which is not one of the 34.

Routes: **3 of 7 need structural work** — overview (stat grid, banner
placement), devices (table header offset, card variant), messages (log toolbar
inside the new header). `rules`, `workflows`, `workflows/edit` and `login` need
tokens only.

### 4.2 Structural changes — four, and they are not optional

**a. The shell (`+layout.svelte`, 226 lines).** `DESIGN_2026.md` §4 specifies a
248px sidebar *and a 64px sticky header*. Today there is a 232px rail with no
desktop header at all: `PageHeader.svelte` sits inside the scrolling `.main`,
and `.mobile-bar` only exists below 900px. The header has to be hoisted into the
layout so the greeting and the page actions stay put while the page scrolls.
Consequences:

- `--rail: 232px` → `248px`;
- `.rail` loses `background: color-mix(…surface 72%, transparent)` +
  `backdrop-filter` (a blurred sidebar over a cream page looks grey, and
  `DESIGN_2026.md` asks for flat `--surface-2` with a hairline);
- the mobile bar becomes a real app bar rather than a horizontally scrolling
  duplicate of the rail. Four labels at `--text-sm` in a 360px bar with a
  fade mask is the weakest thing in the current UI; a bottom dock on the console
  is out of scope, so use a title + menu button that opens a sheet, or keep the
  scroll but drop the labels to icons with `aria-label`;
- `AlertBanner` moves from inside `<main class="main">` (max-width 1200) to
  `.main-wrap` above it, so it can be the one full-bleed moment §4 allows.
  Today it is a 1200px bordered card (`AlertBanner.svelte:171-179`), and it
  animates in on the error path (`alert-in 220ms`, line 178) — which
  `DESIGN_2026.md` §2 forbids outright. That `animation:` line is deleted in the
  same commit as the move, not after it.

**b. `PageHeader.svelte` (5 call sites: overview, devices, messages, rules,
workflows).** Split it: the eyebrow + title + actions move into the layout
header; the description becomes a page intro block. The `border-bottom` goes
away (the preview has no rule under the title — the sticky header carries the
separation).

**c. The stat grid (`+page.svelte:299,383`).** `.stat-grid` is a 1px-gap grid
with `background: var(--line)` showing through as rules — a clever trick that is
fundamentally incompatible with `DESIGN_2026.md` §4, which wants four bento
cards spanning 3 columns each, with independent radii and pastel fills. **Retire
the component, keep `.stat` internals.** This is the one place where the new
skin is a genuine rewrite, ~40 lines of markup in one route.

**d. Devices table (`devices/+page.svelte:785`).** `<table class="table">` stays
a table (§4: "dense lists stay lists… a table is allowed to be a table"). What
changes: sticky `--surface-2` header — `position: sticky` already exists, but
once the app header is sticky too, two sticky siblings at `top: 0` overlap, so
`th` needs `top: 64px`; plus the `.status-*` grid classes and the row hover tint.

The real problem in this file is that the fleet is rendered **twice**:
`.fleet-table` at line 786 for desktop and `.device-cards` at line 870 for
narrow screens, 1,010 lines apart, with separate presence chips and action
buttons. They will drift the first time a column is added. The new skin should
collapse them to one `<ul>` of rows that becomes a table only above 1100px (or
keep the table and make the cards a CSS-only reflow of the same `<tr>`
markup). Do not restyle both copies.

### 4.3 Token-only rewrites, with the traps

Use `design/preview.html` as the reference implementation; it is the same
markup shapes with the new values.

- `.panel` — `--r` 6→12, `--shadow` → `--shadow-2`, drop the
  `color-mix(surface-2 55%, surface)` panel head in favour of flat `--surface-2`.
- `.btn` — 34px → 40px desktop, 44 mobile; `--r-sm` 4→8; primary fill becomes
  `--accent-fill` (`#D9502C`), **not** `--accent` (`#C9482A`, a text colour).
- `.input`, `.field`, `.label` — `--field` disappears into `--surface`; border
  `--line-strong`; focus ring stays 2px `--accent` offset 2.
- `.table` — header `--surface-2`, 11px mono tracking 0.1em, row padding 11→12.
- `.dialog` — `--r-lg` 10→20, `--shadow-3`.
- `.empty` — gets a mascot slot; `empty-mark` square becomes the mascot.
- `.badge` → `.chip` — the six pastel pairs replace the
  `color-mix(tone 9%, surface)` derivation, and the chip drops uppercase+mono
  for 11px/700 sentence case (a state *word*, not a code).

### 4.4 Classes to retire

| Retire | Reason | Replace with |
|---|---|---|
| `.stat-grid` | 1px-gap rule trick; incompatible with pastel cards + radii | `.bento` + `.card.span3` |
| `.badge`, `.badge-ok/-warn/-danger/-accent/-muted`, `.badge-dot` | CSS-derived tints; the new system has explicit pastel pairs | `.chip` + `data-tone` |
| `.notice`, `.notice-info/-ok/-warn/-danger` | `color-mix(tone 6%, surface)` + left border; three of five are already dead | `.callout` on a pastel container |
| `.dot-pulse` | dead, and an infinite animation in a table row (§2 forbids it) | nothing |
| `.truncate` | dead | inline where needed; not a global |
| `.page` → `page-in 340ms` | whole-page entrance on every navigation; §2 wants `settle` at 220ms with a 40ms stagger, max 6 items | `.settle` applied per section, not per page |
| the `prefers-reduced-motion` block (`app.css:1635-1643`) | `animation-duration: .01ms !important` is the pattern §2 explicitly rejects ("the reduced state is the final state, not a 0.01s animation") — it still fires `animationend`, still runs the compositor, and still moves a sprite by a hair | `animation: none; transition: none` on the named motions, and let the final state be the static one |
| `.skeleton` shimmer `1.4s` | §2 caps shimmer at 1.2s and forbids it on the alert path | static `--surface-2` block, or 1.0s and only in `.log-body` |
| `--grid`, `--glow` + body background gradients | graph paper + radial glow is not cream paper; it reads as a dev tool | flat `--bg`, optional 2% noise |
| `.brand-name` (mono, 0.17em tracking), `.brand-sub` (9.5px) | 9.5px is unreadable and the wordmark should be a wordmark | sans 700 15px + mono sub at 11px |
| `.page-head` border-bottom | the header now separates | none |
| `--r-sm: 4px / --r: 6px / --r-lg: 10px` | new scale 8/12/20/28 | keep names, new values |

### 4.5 Token migration hazards

1. **The type scale is renamed *and* re-valued.** `--text-base` (13px) becomes
   `--text-m` (15px); `--text-sm` (12px) becomes `--text-s` (13px). A blind
   find/replace shifts every font on every screen. Keep the old names as aliases
   for one release (`--text-sm: var(--text-s)`), migrate call sites, then delete
   the aliases. Same for `--r*` and `--shadow`.
2. **`--shadow` must not be deleted before `.panel` stops using it.** There is no
   `--shadow` in `DESIGN_2026.md`; there are `--shadow-1/2/3`. Define
   `--shadow: var(--shadow-2)` and delete it in a second commit.
3. **The dark palette is written twice** (`app.css:81-115` for
   `prefers-color-scheme`, `:root[data-theme='dark']` at 117-149). Adding the new
   pastels to both copies guarantees drift. `light-dark()` collapses them:

   ```css
   :root { color-scheme: light dark; --bg: light-dark(#FBF6EE, #1C1814); }
   :root[data-theme='light'] { color-scheme: light; }
   :root[data-theme='dark']  { color-scheme: dark; }
   ```

   `ThemeToggle.svelte` already writes `data-theme`, so this works without a
   second mechanism. If it is not adopted, add a comment at the top of each copy
   pointing at the other — that is the cheapest defence.
4. **`--accent-fill` has no dark value in `DESIGN_2026.md`.** §5 gives dark
   surfaces and says pastels are used at 12% alpha, but the coral is unspecified.
   White text on `#D9502C` is 4.6:1; in dark mode that fill must lift to about
   `#E8704A` with `--ink`-dark text, or the primary button becomes the
   lowest-contrast element on the screen. **This is a spec gap, not a bug** — see
   §6.

---

## 5. Three anti-patterns I would fail a PR for

**1. Colour as the only carrier of state.**
A green dot instead of `live`, an unread dot instead of `2 unread`, a chip that
changes hue from butter to mint with no word change, pastel ink used for a count
or a phone number.
*Test in review:* take a greyscale screenshot and read every status. Then check
each pastel-ink pair against its container. `DESIGN_2026.md` §1 already forbids
pastel ink for operational text; the failure happens because a chip is
convenient.
*Fix:* word first, colour second, dot never alone.

**2. A sheet or dialog that is not a `<dialog>` (or a bits-ui primitive).**
A `<div class="overlay">` with an `onclick` outside, no focus trap, no focus
return, background still scrollable, Esc unhandled, and Android back leaving the
thread while the sheet is open.
*Test in review:* keyboard only — open, Tab ten times, confirm focus never
leaves; Esc closes; focus lands back on the trigger. Then Android back with the
sheet open. Then rotate.
*Fix:* `<dialog>` + `showModal()` as `ConfirmDialog.svelte` already does, plus
the `pushState`/`popstate` pair for back.
*Sibling failure in the same family:* a 32px icon button inside a 76px row. If it
is under 48×48 with less than 8px of separation from the row's own link, it
fails, no matter how good it looks.

**3. A chat that lies about the send.**
An optimistic bubble that shows `delivered` (the store rejects that state), a
retry that fires silently, a success toast before the row is `sent`, a spinner
that replaces the message, or a "sent" that stays "sent" while the carrier never
saw it.
*Test in review:* airplane mode, send, watch the bubble for 30s, then retry. The
words must be `queued` → `failed`, with a reason and a 48px retry, and the text
must still be there.
*Related, same severity:* a thread list rendering hundreds of rows keyed by index
(a message re-keys on arrival and the scroll jumps), or a 5s poll that keeps
running while the app is backgrounded. The console already gates polling on
`document.visibilityState` (`AlertBanner.svelte:36`); the phone must too.

---

## 6. Gaps in `DESIGN_2026.md` that block implementation

Not style opinions — decisions missing before the phone can be built:

1. **Dark-mode accent.** `--accent-fill` and the coral's dark counterpart are
   unspecified (§4.5, item 4). Need `--accent-fill` + `--accent-fill-ink` per
   theme.
2. **The phone's dark mode is opt-in or follows the system?** §5 says "keeps its
   dark variant for use in a pocket at night" but not how it is selected. The
   console has `ThemeToggle` + `localStorage`; the phone should follow
   `prefers-color-scheme` with a manual override, because a gateway phone is
   often left on a shelf.
3. **Back-button ownership.** Confirm whether Tauri Android routes back to
   WebView history or to `finish()`. The thread-as-route design (system back
   closes the thread for free) depends on the answer.
4. **Permission commands.** `sms_permission_state` and `open_app_settings` do not
   exist; the banner cannot be honest without them (§2.8).
5. **Keyset paging.** `list_messages` has no cursor and clamps at 500. Without
   it, "5,000-message thread" means nothing (§3.4).
6. **Where the four-stage command lifecycle is shown on the phone.** The console
   has `CommandTracker`; the phone shows row state. If a flow reply's command
   also needs tracking on the phone, that is a second surface and a second
   vocabulary on one screen — decide, or the bubble will grow a second chip.

---

## 7. Acceptance checks

Cheap, mechanical, and they catch the three anti-patterns:

- [ ] Every interactive element in the phone app measures ≥48×48 with ≥8px gaps
      (`grep -c 'min-height: 48px'` is a poor proxy; measure in the webview at
      360×800).
- [ ] Greyscale pass on: dock, thread row, bubble, chip, banner, empty state.
- [ ] Keyboard-only pass on: dock, composer, SIM sheet, toast dismissal.
- [ ] Android back: sheet open → closes sheet; thread open → closes thread;
      threads → app stays.
- [ ] Airplane mode: send → `queued` → `failed` with reason + retry, text
      preserved.
- [ ] Rotate to landscape with the keyboard open: header, thread, composer all
      visible; no double padding; dock not under the cutout.
- [ ] `prefers-reduced-motion: reduce`: no bob, no settle, no pop, no spinner
      beyond a static indicator; final states identical to the animated ones.
- [ ] Render at 5,000 messages (seeded): scroll to top loads 50 at a time, the
      scroll position does not jump, and the frame budget on insert stays under
      16ms.
- [ ] Console: no `--shadow` reference left after the alias is removed; `--text-*`
      aliases deleted; `light-dark()` or the twin-palette comment present.
