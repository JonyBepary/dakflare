# 03 — Token architecture for two surfaces

Status: proposed 2026-10-29. Review only: no application file was changed to produce
this document. It specifies the token layer that the warm-cream direction
(`docs/DESIGN_2026.md`) needs before the phone becomes a real SMS app and the console
keeps its density.

Read for this review: `dashboard/src/app.css` (1,657 lines), `simulator/src/app.css`
(155 lines), `docs/DESIGN_2026.md`, `docs/CONSOLE_UX.md`, `design/preview.html`,
`dashboard/src/routes/+layout.svelte`, `simulator/src/routes/+page.svelte`,
`dashboard/src/lib/presence.ts`, `dashboard/src/lib/components/{Badge,PresenceChip,ThemeToggle}.svelte`.

Normative neighbours: `CONSOLE_UX.md` owns the five device states, the
rules-vs-flows pipeline and one-reply-per-message. `DESIGN_2026.md` owns the visual
direction. This file owns **names and values**, and the arithmetic behind them.

---

## 0. What is actually there today

Three files each carry their own copy of the palette. Counted by scanning custom-property
declarations:

| File | Declarations | Unique names | Role |
|---|---|---|---|
| `dashboard/src/app.css` | 93 | 45 | console, light + two dark blocks (24 declarations duplicated verbatim in each) |
| `simulator/src/app.css` | 21 | 12 | phone, light + one 9-line dark override |
| `design/preview.html` | 32 | 32 | the approved direction, a third palette |

Union: **64 names. The two apps share 9, and those 9 already disagree in dark.**

| Token | Dashboard dark | Simulator dark |
|---|---|---|
| `--ink-2` | `#b0b2a8` | `#b9b8ae` |
| `--ink-3` | `#8f9389` | `#8d9089` |
| `--line` | `#272c29` | `#2a302e` |

That is the whole argument for this document. It is not a taste problem: the preview
cannot be built from either app's file, and the two apps cannot be themed together.

The console's density lives in three places, and all three survive this proposal:

- component text at 11–13px, tables at 11px cells with 9px header padding;
- the 4px spacing grid (`--s-1..--s-8`), unchanged in value;
- mono for anything an operator copies or compares.

Only *prose* moves 14 → 15px. `--text-md` has six consumers across the console — `body`,
`.empty h3`, two panel titles, a pair-state heading and `.msg-body` — and none of them is a
table cell. `--text-lg` gains 1px in three titles. Table cells stay at 13px, headers at
11px, chips at 10/11px, and every padding value on a row is unchanged.

---

## 1. Three layers

### 1.1 Naming scheme

One rule per layer, checkable by grep:

| Layer | Shape | Example | Rule |
|---|---|---|---|
| 1 primitive | `--df-p-<group>-<step>` | `--df-p-coral-600` | raw value, never used by a component directly |
| 2 semantic | `--df-<role>-<slot>[-<state>]` | `--df-surface-card` | what a theme swaps; never contains a `-p-` or `-c-` segment |
| 3 component | `--df-c-<component>-<part>[-<state>]` | `--df-c-bubble-status-failed-ink` | defaults for one piece; may point at layer 2 or at geometry primitives |

Three consequences worth stating, because they are the reason the names look like this:

- **The `--df-` prefix lets old and new names coexist during migration.** A screen can
  be converted one rule at a time; nothing has to land in one commit.
- **A name containing `-p-` is a primitive; `--df-c-` is a component; everything else is
  semantic.** `grep -o 'var(--df-[^)]*)'` sorts the codebase into layers without a parser.
- **Layer 3 may point at layer 2 for colour and at layer 1 for geometry.** Colour has to
  move with the theme; a 72px row height does not. That keeps the phone dark block to one
  place (`§1.4`) and keeps the console's density in component tokens, not in global ones.

Naming inside a family: colour steps are lightness bands, 50 lightest → 1000 darkest.
Pastel families carry four steps with fixed jobs — `100` light container, `300` dark-scheme
ink, `700` light-scheme ink, `900` dark-scheme container.

### 1.2 Layer 1 — primitives

```css
/* design/tokens.css — layer 1. Values only; no component may reference these directly
   except for geometry (space, radius, type, duration). */

:root {
	/* ---- neutrals: cream paper (light) ---- */
	--df-p-cream-50: #fffdf8;   /* card */
	--df-p-cream-100: #fbf6ee;  /* page */
	--df-p-cream-200: #f6efe3;  /* well, table head, sidebar */
	--df-p-cream-300: #ede3d3;  /* pressed, dense divider */
	--df-p-cream-400: #e7dccb;  /* hairline */
	--df-p-cream-500: #d3c4ac;  /* control border */

	/* ---- inks: warm brown-black, 50 → 1000 ---- */
	--df-p-umber-300: #857a6b;  /* icons and dots only — never text */
	--df-p-umber-400: #6b6153;  /* metadata, timestamps */
	--df-p-umber-500: #5b5348;  /* secondary text */
	--df-p-umber-900: #241f1a;  /* body, headings */
	--df-p-umber-1000: #1b0e08; /* ink printed on a bright coral fill (dark scheme) */

	/* ---- coral: the one action colour ---- */
	--df-p-coral-100: #fbe3da;  /* soft container, selected nav, outgoing bubble */
	--df-p-coral-300: #ff9b7a;  /* accent text, dark scheme */
	--df-p-coral-400: #e2603c;  /* primary hover fill, dark scheme */
	--df-p-coral-500: #d9502c;  /* primary fill, dark scheme; decor in light */
	--df-p-coral-600: #c9482a;  /* primary fill, light scheme */
	--df-p-coral-700: #b23b20;  /* accent text + link hover fill, light scheme */
	--df-p-coral-800: #983018;  /* link hover, pressed fill */

	/* ---- pastel containers and their inks ---- */
	--df-p-mint-100: #ddf3e4;  --df-p-mint-300: #8fe0b4;
	--df-p-mint-700: #1f6b45;  --df-p-mint-900: #22322a;
	--df-p-sky-100: #ddebfb;   --df-p-sky-300: #a9cbee;
	--df-p-sky-700: #2a5488;   --df-p-sky-900: #222c37;
	--df-p-butter-100: #fbebc8; --df-p-butter-300: #f0c67c;
	--df-p-butter-700: #7a5310; --df-p-butter-900: #352d1f;
	--df-p-peach-100: #fbe0d3;  --df-p-peach-300: #f5a98f;
	--df-p-peach-700: #a33218;  --df-p-peach-900: #382720;
	--df-p-lilac-100: #e9e3fb;  --df-p-lilac-300: #c2b6f2;
	--df-p-lilac-700: #4a3a8c;  --df-p-lilac-900: #2b2738;
	--df-p-stone-100: #ede7dc;  --df-p-stone-300: #cbc0b0;
	--df-p-stone-700: #5b5348;  --df-p-stone-900: #302b25;

	/* ---- night: phone dark scheme only ---- */
	--df-p-night-900: #14110e;  /* page */
	--df-p-night-800: #1c1814;  /* card, sheet, dock */
	--df-p-night-700: #262019;  /* well, field */
	--df-p-night-600: #332a22;  /* pressed */
	--df-p-night-500: #3a3128;  /* hairline */
	--df-p-mist-50: #f4ece2;    /* ink */
	--df-p-mist-300: #c9beaf;   /* secondary ink */
	--df-p-mist-500: #a0968a;   /* metadata ink */

	/* ---- type: 4px of air between sizes, one step per job ---- */
	--df-p-text-2xs: 0.625rem;  /* 10px — mono uppercase labels only */
	--df-p-text-xs: 0.6875rem;  /* 11px — chips, table heads, badge */
	--df-p-text-sm: 0.75rem;    /* 12px — labels, hints, secondary rows */
	--df-p-text-base: 0.8125rem;/* 13px — console body, table cells, inputs */
	--df-p-text-md: 0.9375rem;  /* 15px — phone body, prose, dialog copy */
	--df-p-text-lg: 1.0625rem;  /* 17px — card and dialog titles */
	--df-p-text-xl: 1.25rem;    /* 20px — section title, phone sheet title */
	--df-p-text-2xl: 1.625rem;  /* 26px — page title, thread name */
	--df-p-text-3xl: 2.125rem;  /* 34px — stat number, one per page */

	/* ---- space: 4px grid, unchanged from today ---- */
	--df-p-space-1: 4px;
	--df-p-space-2: 8px;
	--df-p-space-3: 12px;
	--df-p-space-4: 16px;
	--df-p-space-5: 24px;
	--df-p-space-6: 32px;
	--df-p-space-7: 48px;
	--df-p-space-8: 64px;

	/* ---- radius ---- */
	--df-p-radius-xs: 4px;      /* brand mark, tiny tag */
	--df-p-radius-sm: 8px;      /* input, chip */
	--df-p-radius-md: 12px;     /* row, small card, table shell */
	--df-p-radius-lg: 20px;     /* bento card, bubble, phone sheet */
	--df-p-radius-xl: 28px;     /* page sheet, dialog */
	--df-p-radius-pill: 999px;

	/* ---- elevation: warm, low, never stacked inside one card ---- */
	--df-p-shadow-1: 0 1px 2px rgba(74, 52, 26, 0.06);
	--df-p-shadow-2: 0 2px 4px rgba(74, 52, 26, 0.06), 0 12px 28px -18px rgba(74, 52, 26, 0.35);
	--df-p-shadow-3: 0 24px 60px -24px rgba(74, 52, 26, 0.45);

	/* ---- motion (DESIGN_2026 §2, named so a reviewer can cite one) ---- */
	--df-p-dur-press: 90ms;
	--df-p-dur-lift: 160ms;
	--df-p-dur-settle: 220ms;
	--df-p-dur-pop: 320ms;
	--df-p-ease-standard: cubic-bezier(0.2, 0.8, 0.2, 1);
	--df-p-ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);

	/* ---- focus ring: same in both schemes, 2px + 2px offset ---- */
	--df-p-focus-width: 2px;
	--df-p-focus-offset: 2px;

	/* ---- type stacks ---- */
	--df-p-font-sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
		'Helvetica Neue', Arial, sans-serif;
	--df-p-font-mono: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas,
		'Liberation Mono', monospace;

	/* ---- layout constants ---- */
	--df-p-layout-rail: 248px;   /* console sidebar, per DESIGN_2026 §4 */
	--df-p-layout-page-max: 1200px;
	--df-p-layout-reading: 62ch;
}
```

88 primitives: 5 cream, 5 umber, 7 coral, 24 pastel (6 families × 4), 8 night/mist,
9 type, 8 space, 6 radius, 3 shadow, 4 durations, 2 easings, 2 focus, 2 fonts,
3 layout.

Colour ladders are monotonic by construction; the numbers are lightness bands, so gaps
(`cream-100 → cream-200`, `umber-500 → umber-900`) mean "no value is needed here", not
"missing". The exact luminance of every step is in §4.

### 1.3 Layer 2 — semantic, light

```css
/* design/tokens.css — layer 2. Anything a theme may swap lives here. */

:root {
	/* surfaces */
	--df-surface-page: var(--df-p-cream-100);
	--df-surface-card: var(--df-p-cream-50);
	--df-surface-well: var(--df-p-cream-200);
	--df-surface-press: var(--df-p-cream-300);
	--df-surface-field: var(--df-p-cream-50);
	--df-surface-selected: var(--df-p-cream-50);

	/* strokes */
	--df-border-hairline: var(--df-p-cream-400);
	--df-border-control: var(--df-p-cream-500);
	--df-border-focus: var(--df-p-coral-700);

	/* text */
	--df-text-primary: var(--df-p-umber-900);
	--df-text-secondary: var(--df-p-umber-500);
	--df-text-meta: var(--df-p-umber-400);
	--df-text-on-accent: var(--df-p-cream-50);
	--df-text-on-danger: var(--df-p-cream-50);

	/* accent — text and fill are two roles, not one */
	--df-accent-text: var(--df-p-coral-700);
	--df-accent-text-hover: var(--df-p-coral-800);
	--df-accent-fill: var(--df-p-coral-600);
	--df-accent-fill-hover: var(--df-p-coral-700);
	--df-accent-fill-press: var(--df-p-coral-800);
	--df-accent-soft: var(--df-p-coral-100);
	--df-accent-decor: var(--df-p-coral-500); /* dots, rules, sparkline — never text */

	/* tones: the state vocabulary, in tones rather than device words */
	--df-state-ok-bg: var(--df-p-mint-100);
	--df-state-ok-ink: var(--df-p-mint-700);
	--df-state-info-bg: var(--df-p-sky-100);
	--df-state-info-ink: var(--df-p-sky-700);
	--df-state-warn-bg: var(--df-p-butter-100);
	--df-state-warn-ink: var(--df-p-butter-700);
	--df-state-danger-bg: var(--df-p-peach-100);
	--df-state-danger-ink: var(--df-p-peach-700);
	--df-state-danger-fill: var(--df-p-peach-700);
	--df-state-neutral-bg: var(--df-p-stone-100);
	--df-state-neutral-ink: var(--df-p-stone-700);
	--df-state-filter-bg: var(--df-p-lilac-100);
	--df-state-filter-ink: var(--df-p-lilac-700);

	/* elevation */
	--df-shadow-card: var(--df-p-shadow-1);
	--df-shadow-raised: var(--df-p-shadow-2);
	--df-shadow-dialog: var(--df-p-shadow-3);
}
```

Why tones and not device words: `live`/`synced`/`stale`/`offline`/`unknown` are a UX
vocabulary that `CONSOLE_UX.md` owns and the phone will not use. The semantic layer holds
`ok / info / warn / danger / neutral / filter`; the five console chips are component
tokens that point at a tone (`§1.5`). Adding a sixth state later is one component token,
not six semantic ones.

Why accent is split: the approved preview uses *one* coral for the button fill and for
links. That does not hold up — the fill needs a light label, the text needs to sit on
cream (§4.2). Two roles, two steps, one family.

### 1.4 Layer 2 — dark, phone only

The console's dark theme stays where it is and is **out of scope here** except for a
rename (see §2.3). This block lives in `simulator/src/app.css`, after the shared import,
and changes nothing but layer 2 — every component token keeps working untouched, which is
the point of the layering.

```css
/* simulator/src/app.css — phone dark. Same names, new values. */
@media (prefers-color-scheme: dark) {
	:root {
		--df-surface-page: var(--df-p-night-900);
		--df-surface-card: var(--df-p-night-800);
		--df-surface-well: var(--df-p-night-700);
		--df-surface-press: var(--df-p-night-600);
		--df-surface-field: var(--df-p-night-900);
		--df-surface-selected: var(--df-p-night-600);

		--df-border-hairline: var(--df-p-night-500);
		--df-border-control: #4d4136;
		--df-border-focus: var(--df-p-coral-300);

		--df-text-primary: var(--df-p-mist-50);
		--df-text-secondary: var(--df-p-mist-300);
		--df-text-meta: var(--df-p-mist-500);
		--df-text-on-accent: var(--df-p-umber-1000);
		--df-text-on-danger: var(--df-p-cream-50);

		--df-accent-text: var(--df-p-coral-300);
		--df-accent-text-hover: var(--df-p-coral-400);
		--df-accent-fill: var(--df-p-coral-500);
		--df-accent-fill-hover: var(--df-p-coral-400);
		--df-accent-fill-press: var(--df-p-coral-600);
		--df-accent-soft: #3a241c; /* coral at 12% over night-800, baked */
		--df-accent-decor: var(--df-p-coral-400);

		--df-state-ok-bg: var(--df-p-mint-900);
		--df-state-ok-ink: var(--df-p-mint-300);
		--df-state-info-bg: var(--df-p-sky-900);
		--df-state-info-ink: var(--df-p-sky-300);
		--df-state-warn-bg: var(--df-p-butter-900);
		--df-state-warn-ink: var(--df-p-butter-300);
		--df-state-danger-bg: var(--df-p-peach-900);
		--df-state-danger-ink: var(--df-p-peach-300);
		--df-state-danger-fill: #8a3a28;
		--df-state-neutral-bg: var(--df-p-stone-900);
		--df-state-neutral-ink: var(--df-p-stone-300);
		--df-state-filter-bg: var(--df-p-lilac-900);
		--df-state-filter-ink: var(--df-p-lilac-300);

		--df-shadow-card: none;
		--df-shadow-raised: none;
		--df-shadow-dialog: 0 30px 80px -24px rgba(0, 0, 0, 0.8);
	}
}
```

Three things to notice:

- **Dark containers are opaque primitives, not `color-mix`.** A chip whose contrast
  depends on what is behind it cannot be verified; `#22322A` can.
- **Dark inverts which side of the pair carries the ink.** The fill gets *lighter* than the
  surroundings, so the label is near-black (`--df-p-umber-1000`), not cream. Same token
  names, opposite values.
- **Three values are hand-picked rather than primitive-derived**: `--df-accent-soft`
  (`#3a241c`), `--df-state-danger-fill` (`#8a3a28`) and `--df-border-control` (`#4d4136`).
  Each is a composite with no single-step primitive: two baked tints over `night-800`, and
  one border tuned between `night-500` and `night-600`. They are the candidates for
  promotion to new night steps (`-850`, `-550`) if this block survives review.

### 1.5 Layer 3 — component tokens

Defaults below are what both apps get from the shared file. Sanctioned per-app overrides
are listed under each block and are the only place an app may disagree.

#### Chip

```css
:root {
	/* the five device states, as component vocabulary */
	--df-c-chip-live-bg: var(--df-state-ok-bg);
	--df-c-chip-live-ink: var(--df-state-ok-ink);
	--df-c-chip-synced-bg: var(--df-state-info-bg);
	--df-c-chip-synced-ink: var(--df-state-info-ink);
	--df-c-chip-stale-bg: var(--df-state-warn-bg);
	--df-c-chip-stale-ink: var(--df-state-warn-ink);
	--df-c-chip-offline-bg: var(--df-state-danger-bg);
	--df-c-chip-offline-ink: var(--df-state-danger-ink);
	--df-c-chip-unknown-bg: var(--df-state-neutral-bg);
	--df-c-chip-unknown-ink: var(--df-state-neutral-ink);
	--df-c-chip-wake-bg: var(--df-state-filter-bg);
	--df-c-chip-wake-ink: var(--df-state-filter-ink);

	/* shape */
	--df-c-chip-bg: var(--df-state-neutral-bg);
	--df-c-chip-ink: var(--df-state-neutral-ink);
	--df-c-chip-border: transparent;
	--df-c-chip-radius: var(--df-p-radius-pill);
	--df-c-chip-height: 22px;
	--df-c-chip-padding-inline: 9px;
	--df-c-chip-gap: 6px;
	--df-c-chip-font-size: var(--df-p-text-xs);
	--df-c-chip-font-weight: 700;
	--df-c-chip-tracking: 0.02em;
	--df-c-chip-dot-size: 6px;
}
```

| State | Container | Ink | Ratio |
|---|---|---|---|
| live | mint-100 | mint-700 | 5.55 |
| synced | sky-100 | sky-700 | 6.37 |
| stale | butter-100 | butter-700 | 5.80 |
| offline | peach-100 | peach-700 | 5.52 |
| unknown | stone-100 | stone-700 | 6.15 |
| wake (`push` / `poll-only`) | lilac-100 | lilac-700 | 7.40 |

Console override (`dashboard/src/app.css`): `--df-c-chip-height: 20px;
--df-c-chip-font-size: var(--df-p-text-2xs); --df-c-chip-radius: var(--df-p-radius-xs);
--df-c-chip-tracking: 0.06em;` and the chip's `font-family` is mono. The console's chip is
a log tag; the phone's is a status pill. Same token names, different geometry — that is the
override mechanism doing its job.

Phone dark: `--df-c-chip-border: color-mix(in srgb, var(--df-c-chip-ink) 28%, transparent)`
so a 1.3:1 container still reads as a container.

#### Card (console panel / bento card / phone sheet)

```css
:root {
	--df-c-card-bg: var(--df-surface-card);
	--df-c-card-border: var(--df-border-hairline);
	--df-c-card-radius: var(--df-p-radius-lg);
	--df-c-card-padding: var(--df-p-space-4);
	--df-c-card-shadow: var(--df-shadow-card);
	--df-c-card-shadow-hover: var(--df-shadow-raised);
	--df-c-card-title-ink: var(--df-text-primary);
	--df-c-card-meta-ink: var(--df-text-meta);
	--df-c-card-head-bg: color-mix(in srgb, var(--df-surface-well) 55%, var(--df-surface-card));
	--df-c-card-tint-mint: var(--df-state-ok-bg);
	--df-c-card-tint-butter: var(--df-state-warn-bg);
	--df-c-card-tint-peach: var(--df-state-danger-bg);
	--df-c-card-tint-sky: var(--df-state-info-bg);
	--df-c-card-tint-lilac: var(--df-state-filter-bg);
}
```

| | Default | Hover (`lift`) | Pressed |
|---|---|---|---|
| Background | card | card | card |
| Border | hairline; `transparent` on tinted cards | hairline | hairline |
| Shadow | `shadow-card` | `shadow-raised` | `shadow-card` |
| Transform | none | `translateY(-2px)`, 160ms | `scale(.99)`, 90ms |

Console override: `--df-c-card-radius: var(--df-p-radius-md)` — console cards stay at 12px
so a 4-up stat row and a 12-row table do not gain 20px corners they cannot afford. Phone
keeps 20px.

#### Table row

```css
:root {
	--df-c-table-head-bg: var(--df-surface-well);
	--df-c-table-head-ink: var(--df-text-meta);
	--df-c-table-head-size: var(--df-p-text-2xs);
	--df-c-table-head-tracking: 0.1em;
	--df-c-table-row-border: var(--df-border-hairline);
	--df-c-table-row-bg-hover: color-mix(in srgb, var(--df-surface-well) 55%, transparent);
	--df-c-table-row-bg-selected: var(--df-accent-soft);
	--df-c-table-cell-padding-block: 11px;
	--df-c-table-cell-padding-inline: 12px;
	--df-c-table-cell-ink: var(--df-text-primary);
	--df-c-table-cell-meta-ink: var(--df-text-meta);
	--df-c-table-num-tracking: -0.01em;
}
```

No zebra, no per-cell card, no shadow. Sticky head uses `--df-c-table-head-bg`; row rules
use `--df-c-table-row-border`; a selected row is `accent-soft`, never a pastel tone (pastel
means state, and a selected row is not a state).

#### Dialog

```css
:root {
	--df-c-dialog-bg: var(--df-surface-card);
	--df-c-dialog-ink: var(--df-text-primary);
	--df-c-dialog-border: var(--df-border-control);
	--df-c-dialog-radius: var(--df-p-radius-xl);
	--df-c-dialog-shadow: var(--df-shadow-dialog);
	--df-c-dialog-scrim: rgba(36, 31, 26, 0.45);
	--df-c-dialog-width: min(470px, calc(100vw - 32px));
	--df-c-dialog-head-ink: var(--df-text-primary);
	--df-c-dialog-body-ink: var(--df-text-secondary);
	--df-c-dialog-foot-bg: color-mix(in srgb, var(--df-surface-well) 55%, var(--df-surface-card));
	--df-c-dialog-foot-border: var(--df-border-hairline);
}
```

The confirm button inside a dialog never animates (`DESIGN_2026` §2). Destructive actions
use `--df-state-danger-fill` + `--df-text-on-danger`, not a coral variant — coral is
"the thing you press", danger is "the thing that cannot be undone". Phone override:
`--df-c-dialog-width: min(420px, calc(100vw - 32px))`, because a 470px sheet on a 390px
screen is a full screen with a header.

#### Toast

```css
:root {
	--df-c-toast-bg: var(--df-state-neutral-bg);
	--df-c-toast-ink: var(--df-state-neutral-ink);
	--df-c-toast-border: transparent;
	--df-c-toast-radius: var(--df-p-radius-lg);
	--df-c-toast-shadow: var(--df-shadow-raised);
	--df-c-toast-max-width: 360px;
	--df-c-toast-inset: var(--df-p-space-4);
	--df-c-toast-padding: 10px var(--df-p-space-3);
	--df-c-toast-font-size: var(--df-p-text-sm);
	--df-c-toast-dwell: 4000ms;
	--df-c-toast-ok-bg: var(--df-state-ok-bg);
	--df-c-toast-ok-ink: var(--df-state-ok-ink);
	--df-c-toast-danger-bg: var(--df-state-danger-bg);
	--df-c-toast-danger-ink: var(--df-state-danger-ink);
}
```

The console has no toast today — `CopyButton` confirms in place and `Notice` carries
failures. The token exists because the phone needs one transient confirmation ("Message
queued") and one persistent failure surface, and I would rather define it once than let
the phone invent a sixth container colour.

#### Dock (phone only)

```css
:root {
	--df-c-dock-bg: var(--df-surface-card);
	--df-c-dock-border: var(--df-border-hairline);
	--df-c-dock-height: 56px;
	--df-c-dock-padding-bottom: env(safe-area-inset-bottom, 0px);
	--df-c-dock-item-ink: var(--df-text-meta);
	--df-c-dock-item-ink-active: var(--df-accent-text);
	--df-c-dock-item-size: 24px;
	--df-c-dock-label-size: var(--df-p-text-2xs);
	--df-c-dock-label-weight: 600;
	--df-c-dock-badge-bg: var(--df-accent-fill);
	--df-c-dock-badge-ink: var(--df-text-on-accent);
	--df-c-dock-badge-size: var(--df-p-text-2xs);
	--df-c-dock-tap-min: 48px;
}
```

Four destinations, not five: **Threads · Devices · Alerts · Settings**. Threads and
Devices are the two questions the operator actually asks ("what came in", "is the phone
alive"); Alerts carries the count badge; Settings holds target, pairing and the carrier
panel that `simulator/src/routes/+page.svelte` has today. `Messages` and `Automation` stay
console-only — a phone is not where a flow is authored.

| | Inactive | Active | With badge |
|---|---|---|---|
| Icon + label ink | `dock-item-ink` (5.97 on card) | `dock-item-ink-active` (5.84) | — |
| Badge | — | — | `dock-badge-bg` + `dock-badge-ink` (4.65) |
| Tap target | ≥48 × 48, label optional at 10px | same | same |

#### Thread row (phone only)

```css
:root {
	--df-c-thread-row-bg: transparent;
	--df-c-thread-row-bg-hover: var(--df-surface-well);
	--df-c-thread-row-bg-unread: var(--df-surface-card);
	--df-c-thread-row-border: var(--df-border-hairline);
	--df-c-thread-row-height: 72px;
	--df-c-thread-row-padding-inline: var(--df-p-space-4);
	--df-c-thread-name-ink: var(--df-text-primary);
	--df-c-thread-name-size: var(--df-p-text-md);
	--df-c-thread-preview-ink: var(--df-text-meta);
	--df-c-thread-preview-size: var(--df-p-text-sm);
	--df-c-thread-time-ink: var(--df-text-meta);
	--df-c-thread-time-size: var(--df-p-text-xs);
	--df-c-thread-unread-bg: var(--df-accent-fill);
	--df-c-thread-unread-ink: var(--df-text-on-accent);
	--df-c-thread-unread-size: var(--df-p-text-xs);
	--df-c-thread-avatar-size: 40px;
	--df-c-thread-avatar-bg: var(--df-state-neutral-bg);
	--df-c-thread-avatar-ink: var(--df-state-neutral-ink);
	--df-c-thread-state-ink: var(--df-state-warn-ink);
}
```

A phone number is never an avatar (`DESIGN_2026` §3): the avatar is initials of the
*carrier label*, and rows sort by `last_seen` so a dead thread sinks.

#### Bubble (phone only)

```css
:root {
	--df-c-bubble-max-width: 78%;
	--df-c-bubble-radius: var(--df-p-radius-lg);
	--df-c-bubble-radius-tail: 6px;
	--df-c-bubble-padding: 10px var(--df-p-space-3);
	--df-c-bubble-gap: 3px;
	--df-c-bubble-body-size: var(--df-p-text-md);
	--df-c-bubble-body-leading: 1.4;
	--df-c-bubble-meta-size: var(--df-p-text-xs);
	--df-c-bubble-in-bg: var(--df-surface-well);
	--df-c-bubble-in-ink: var(--df-text-primary);
	--df-c-bubble-out-bg: var(--df-accent-soft);
	--df-c-bubble-out-ink: var(--df-text-primary);
	--df-c-bubble-meta-ink: var(--df-text-meta);

	/* send states — the phone's most important five words */
	--df-c-bubble-status-queued-ink: var(--df-text-meta);
	--df-c-bubble-status-sending-ink: var(--df-text-meta);
	--df-c-bubble-status-sent-ink: var(--df-text-secondary);
	--df-c-bubble-status-delivered-ink: var(--df-state-ok-ink);
	--df-c-bubble-status-failed-ink: var(--df-state-danger-ink);
	--df-c-bubble-status-failed-bg: var(--df-state-danger-bg);
	--df-c-bubble-retry-ink: var(--df-accent-text);
}
```

| State | Word | Glyph | Ink | Where the failure reason goes |
|---|---|---|---|---|
| `queued` | queued | clock, hollow | `text-meta` | — |
| `sending` | sending | spinner, 700ms | `text-meta` | — |
| `sent` | sent | single check | `text-secondary` | — |
| `delivered` | delivered | double check | `state-ok-ink` | — |
| `failed` | not sent · tap to retry | triangle | `state-danger-ink` on `state-danger-bg` | one line under the bubble, `--df-text-meta`, never truncated |

`queued` and `sending` share an ink on purpose: the difference is the glyph and the fact
that `sending` can be cancelled. Two colours would imply two outcomes.

#### Composer (phone only)

```css
:root {
	--df-c-composer-bg: var(--df-surface-card);
	--df-c-composer-border: var(--df-border-hairline);
	--df-c-composer-padding: var(--df-p-space-2) var(--df-p-space-3);
	--df-c-composer-field-bg: var(--df-surface-well);
	--df-c-composer-field-ink: var(--df-text-primary);
	--df-c-composer-field-radius: var(--df-p-radius-lg);
	--df-c-composer-placeholder-ink: var(--df-text-meta);
	--df-c-composer-min-height: 44px;
	--df-c-composer-max-height: 132px;
	--df-c-composer-font-size: var(--df-p-text-md);
	--df-c-composer-send-bg: var(--df-accent-fill);
	--df-c-composer-send-ink: var(--df-text-on-accent);
	--df-c-composer-send-hover-bg: var(--df-accent-fill-hover);
	--df-c-composer-send-disabled-bg: var(--df-surface-press);
	--df-c-composer-send-disabled-ink: var(--df-text-meta);
	--df-c-composer-send-size: 40px;
	--df-c-composer-counter-ink: var(--df-text-meta);
	--df-c-composer-counter-warn-ink: var(--df-state-warn-ink);
	--df-c-composer-counter-over-ink: var(--df-state-danger-ink);
	--df-c-composer-hint-ink: var(--df-text-meta);
	--df-c-composer-hint-size: var(--df-p-text-xs);
}
```

| Composer state | Send button | Counter | Hint line |
|---|---|---|---|
| empty | disabled (`send-disabled-*`) | hidden | "Sends from this phone's SIM 1" |
| typing | enabled (`send-*`) | parts + characters, `counter-ink` | hidden |
| near limit | enabled | `counter-warn-ink` at 90% | "one part left" |
| over limit | disabled | `counter-over-ink` | "this will send as 3 parts" |
| sending | spinner, disabled, keeps width | frozen | "queued" |
| failed | retry, `retry-ink` | frozen | the reason, one line |

The composer is the only input in either app that is not `--df-surface-field` with a
`--df-border-control` border. A field inside a field reads as a form; a rounded well inside
the dock card reads as a message box. That difference is a token decision, not a rule in
component CSS.

---

## 2. Migration

### 2.1 Dashboard — every old name

`dashboard/src/app.css` → `design/tokens.css` + overrides. 45 names, 43 renamed, 2 deleted.

| Old | New | Value change |
|---|---|---|
| `--font-sans` | `--df-p-font-sans` | — |
| `--font-mono` | `--df-p-font-mono` | — |
| `--bg` | `--df-surface-page` | `#f4f3ee` → `#fbf6ee` |
| `--surface` | `--df-surface-card` | `#fbfaf6` → `#fffdf8` |
| `--surface-2` | `--df-surface-well` | `#efeee8` → `#f6efe3` |
| `--surface-3` | `--df-surface-press` | `#e6e4dc` → `#ede3d3` |
| `--field` | `--df-surface-field` | `#fdfcf9` → `#fffdf8` |
| `--seg-active` | `--df-surface-selected` | `#fdfcfa` → `#fffdf8` |
| `--ink` | `--df-text-primary` | `#161713` → `#241f1a` |
| `--ink-2` | `--df-text-secondary` | `#4b4e46` → `#5b5348` |
| `--ink-3` | `--df-text-meta` | `#6a6e64` → `#6b6153` |
| `--line` | `--df-border-hairline` | `#dcd9cf` → `#e7dccb` |
| `--line-strong` | `--df-border-control` | `#c2beb1` → `#d3c4ac` |
| `--accent` | `--df-accent-text` | `#2f42c4` → `#b23b20` |
| `--accent-hover` | `--df-accent-text-hover` **and** `--df-accent-fill-hover` | two roles: text hover `#983018`, fill hover `#b23b20` |
| `--accent-ink` | `--df-text-on-accent` | `#ffffff` → `#fffdf8` |
| `--accent-soft` | `--df-accent-soft` | `#e8eafb` → `#fbe3da` |
| `--ok` | `--df-state-ok-ink` | `#1c6b45` → `#1f6b45` |
| `--warn` | `--df-state-warn-ink` | `#8a5a00` → `#7a5310` |
| `--danger` | `--df-state-danger-ink` | `#a52f26` → `#a33218` |
| `--danger-ink` | `--df-text-on-danger` | `#ffffff` → `#fffdf8` |
| `--info` | `--df-state-info-ink` | `#2f5a86` → `#2a5488` |
| `--grid` | **deleted** | remove the 32px grid from `body`'s `background-image` |
| `--glow` | **deleted** | remove the radial glow |
| `--shadow` | `--df-shadow-card` | value → warm `shadow-1` |
| `--shadow-dialog` | `--df-shadow-dialog` | value → warm `shadow-3` |
| `--s-1` … `--s-8` | `--df-p-space-1` … `-8` | none — 4/8/12/16/24/32/48/64 |
| `--r-sm` | `--df-p-radius-sm` | 4 → 8 |
| `--r` | `--df-p-radius-md` | 6 → 12 |
| `--r-lg` | `--df-p-radius-lg` | 10 → 20 |
| `--text-xs` | `--df-p-text-xs` | 11 → 11 |
| `--text-sm` | `--df-p-text-sm` | 12 → 12 |
| `--text-base` | `--df-p-text-base` | 13 → 13 |
| `--text-md` | `--df-p-text-md` | **14 → 15** (6 consumers: `body`, `.empty h3`, two panel titles, `pair-state-body h3`, `.msg-body` — no table cell) |
| `--text-lg` | `--df-p-text-lg` | **16 → 17** (3 consumers: dialog title, two workflow panel titles) |
| `--text-xl` | `--df-p-text-xl` | 20 → 20 |
| `--text-2xl` | `--df-p-text-2xl` | 26 → 26 |
| `--rail` | `--df-p-layout-rail` | **232 → 248** (`DESIGN_2026` §4) |

The console's dark block (24 declarations, duplicated in the media query and
`[data-theme='dark']`) is renamed with its **current cool values untouched**: it is a known
inconsistency against a warm light theme, and fixing it is a separate review. The
duplication is removed by extending the inline script in `dashboard/src/app.html` to write
`data-theme` from `matchMedia` when nothing is stored, which makes the media-query block
unnecessary — 30 lines out, one behaviour.

### 2.2 Simulator — every old name

12 names, all renamed; the dark block is deleted rather than renamed.

| Old | New | Value change |
|---|---|---|
| `--bg` | `--df-surface-page` | `#f4f3ee` → `#fbf6ee` |
| `--surface` | `--df-surface-card` | `#fbfaf6` → `#fffdf8` |
| `--ink` | `--df-text-primary` | `#161713` → `#241f1a` |
| `--ink-2` | `--df-text-secondary` | `#4b4e46` → `#5b5348` |
| `--ink-3` | `--df-text-meta` | `#6a6e64` → `#6b6153` |
| `--line` | `--df-border-hairline` | `#dcd9cf` → `#e7dccb` |
| `--accent` | split: `--df-border-focus` (outline) + `--df-accent-fill` (`.primary`) | `#2f42c4` → `#b23b20` / `#c9482a` |
| `--danger` | `--df-state-danger-ink` | `#a52f26` → `#a33218` |
| `--ok` | `--df-state-ok-ink` | `#1c6b45` → `#1f6b45` |
| `--radius` | `--df-p-radius-sm` | 8 → 8 |
| `--mono` | `--df-p-font-mono` | — |
| `--sans` | `--df-p-font-sans` | — |

The 9-line dark override is deleted and replaced by §1.4. It is currently incomplete —
`--surface-2`, `--field`, `--seg-active`, `--accent-soft` and `--line-strong` do not exist
in the simulator at all, so any component that needs them would inherit a light value.

### 2.3 What gets deleted

| Deleted | Where | Why |
|---|---|---|
| `--grid`, `--glow` | dashboard `:root` + `body` | cream paper replaced the graph-paper atmosphere; nothing reads them after the `body` rule changes |
| 24-declaration dark block under `@media (prefers-color-scheme: dark)` | dashboard | replaced by one `[data-theme='dark']` block + the app.html script |
| 9-line dark override | simulator | replaced by §1.4 |
| `--radius` | simulator | duplicates `--df-p-radius-sm` |
| every hardcoded `font-size: 9.5px / 10.5px / 11.5px / 10px / 1.875rem / 1.5rem` | dashboard | → `--df-p-text-2xs/xs/sm/3xl` |
| `padding: 8px 10px`, `2px 6px`, `9px 12px`, `11px 12px` on `.nav-link`, `.badge`, `.table th/td` | dashboard | → `--df-p-space-*`, `--df-c-chip-padding-inline`, `--df-c-table-cell-*` |
| `border-radius: 2px / 3px / 10px` | dashboard | → `--df-p-radius-*` |
| `rgba(10, 12, 10, 0.45)` dialog scrim | dashboard | → `--df-c-dialog-scrim` (warm) |
| `rgba(0, 0, 0, 0.12)` segmented-control shadow | dashboard | → `--df-p-shadow-1` |
| `#fff` on `.primary` | simulator | → `--df-text-on-accent` |
| `rgba(0, 0, 0, 0.45)` overlay | simulator | → `--df-c-dialog-scrim` |
| `font-size: 14px` on `body`, `12px`/`11px` on labels | simulator | → `--df-p-text-md/sm/xs` |
| `color-mix(in srgb, var(--danger) 40%, var(--line))` borders | simulator | → `--df-border-control` (a control border is not a state) |

### 2.4 The mechanical check

After migration, each of these must return nothing:

```sh
grep -nE 'var\(--(bg|surface|surface-2|surface-3|field|seg-active|ink|ink-2|ink-3|line|line-strong|accent|accent-hover|accent-ink|accent-soft|ok|warn|danger|info|grid|glow|shadow|r|r-sm|r-lg|rail|text-[a-z0-9]+|s-[1-8]|sans|mono)\)' \
  dashboard/src simulator/src
grep -nE '#[0-9a-fA-F]{3,8}\b' dashboard/src/app.css simulator/src/app.css
```

The second is the stronger one: after the migration, the only hex values in either `app.css`
are inside `design/tokens.css`. `dashboard/src/lib/workflow/workflow.css` is exempt and must
keep mapping `--xy-*` onto `--df-*`.

---

## 3. Where the single source of truth lives

**One checked-in file, `design/tokens.css`, imported by relative path from both apps.**

```css
/* dashboard/src/app.css — first line, nothing above it */
@import '../../design/tokens.css';

/* simulator/src/app.css — first line, nothing above it */
@import '../../../design/tokens.css';
```

Why this needs no new build step: both apps are Vite builds, and Vite resolves and **inlines**
CSS `@import` at build time. The console's `vite.config.ts` already writes its output to
`worker/public/admin`, so the tokens are baked into the static assets the Worker serves —
nothing reads `design/` at runtime, and `worker/public/admin` stays self-contained. The phone
is a Tauri webview bundling the same way. The file is a build input, not a runtime one.

The one sharp edge: each app carries its own `package-lock.json`, so Vite treats
`dashboard/` and `simulator/` as the workspace roots and `../../design` sits outside
`fs.allow`. `npm run build` is unaffected (the import is inlined during the transform), but
`vite dev` can refuse the path. The fix is one dev-server line per app —
`server: { fs: { allow: ['..'] } }` — not a build step, and it changes nothing about what
ships.

The file contains layer 1, layer 2 (light) and layer 3 defaults. Each app owns exactly two
things after the import: its dark block (phone: §1.4; console: existing, renamed) and the
component overrides listed in §1.5.

**Trade-off.** The import escapes the app root, so both apps can only be built from a full
repository checkout — a tarball of `dashboard/` alone, or a copy of `worker/public/admin`
placed in another Worker, cannot rebuild, and there is no version boundary between tokens
and consumers: a rename lands in both apps in the same commit. That is the point (drift is
impossible) and the cost (no staged rollout, and any consumer outside this repo — a future
Kotlin screen, a status page — has no package to depend on). It also means the CSS import
order carries meaning: `@import` must be line 1 of each `app.css`, and no app may redeclare a
layer-1 or layer-2 name outside its dark block. Enforce that with the two greps in §2.4 plus
one more:

```sh
grep -nE '^\s*--df-(p-|[a-z]+-[a-z-]+):' dashboard/src/app.css simulator/src/app.css
# must list only dark-block entries and the overrides named in §1.5
```

Rejected alternatives, with the reason each fails:

| Option | Why not |
|---|---|
| npm workspace package `@dakflare/tokens` with a CSS export | needs `workspaces` in the root `package.json`, a `prepare` step to emit CSS, and an install in two lockfiles — a build step that does not exist today, for one 300-line file |
| Symlink `dashboard/src/tokens.css → ../../design/tokens.css` | Git stores symlinks, but a Windows checkout with `core.symlinks=false` (the Tauri dev machine) writes a text file containing the path; the app then fails to build with a confusing error |
| Copy in a `prebuild` script | two generated files, which is exactly the drift this review is fixing (64 names, 9 shared) |
| Reference the file over HTTP from the Worker | the phone is offline-first by design and must not need the network to paint; also a runtime dependency the console is not allowed to gain |
| A JS/TS token module | the console is prerendered static and the phone is a webview; both would pay a runtime import to produce values that belong in CSS |
| One stylesheet with component CSS for both apps | the console's density and the phone's touch sizes diverge in almost every component; only the layer above them is genuinely shared |

---

## 4. Contrast

### 4.1 Method

WCAG 2.1 relative luminance over sRGB, ratio = (L_light + 0.05) / (L_dark + 0.05). Every
number below was produced by the script in the appendix, run against the hex values in §1.
Nothing here is copied from `DESIGN_2026.md`; where the two disagree, §4.6 says which one
the arithmetic supports.

Threshold applied: **4.5:1** for text, **3:1** for non-text (borders, focus rings, icon
stroke), 1.4.11.

### 4.2 The five state chips (light)

| Chip | Ink on container | Ratio | |
|---|---|---|---|
| `live` | `#1F6B45` on `#DDF3E4` | **5.55:1** | pass |
| `synced` | `#2A5488` on `#DDEBFB` | **6.37:1** | pass |
| `stale` | `#7A5310` on `#FBEBC8` | **5.80:1** | pass |
| `offline` | `#A33218` on `#FBE0D3` | **5.52:1** | pass |
| `unknown` | `#5B5348` on `#EDE7DC` | **6.15:1** | pass |
| `wake` (sixth, `push`) | `#4A3A8C` on `#E9E3FB` | **7.40:1** | pass |

All six are single words at 700 weight, which is the only place `DESIGN_2026` allows pastel
ink on pastel. Any longer text on a pastel container uses `--df-text-primary`: 12.85–16.06:1
across every light surface and container (§4.4).

### 4.3 Primary button and accent text (light)

| Pair | Ratio | |
|---|---|---|
| `--df-text-on-accent` on `--df-accent-fill` (`#FFFDF8` on `#C9482A`) | **4.65:1** | pass, 0.15 margin |
| hover: `#FFFDF8` on `#B23B20` | **5.84:1** | pass |
| pressed: `#FFFDF8` on `#983018` | **7.45:1** | pass |
| `--df-accent-text` on page (`#B23B20` on `#FBF6EE`) | **5.51:1** | pass |
| … on card (`#FFFDF8`) | **5.84:1** | pass |
| … on well (`#F6EFE3`) | **5.19:1** | pass |
| … on pressed (`#EDE3D3`) | **4.67:1** | pass |
| … on soft chip (`#FBE3DA`) | **4.83:1** | pass |
| danger solid: `#FFFDF8` on `#A33218` | **6.83:1** | pass |
| focus ring vs page: `#B23B20` on `#FBF6EE` | **5.51:1** | pass (3:1 needed) |

The 4.65 on the primary button is the tightest text pair in the system. If a later review
wants more margin, darken `--df-p-coral-600` one step (`#C04626` → 5.07:1) — do not lighten
the label, `#FFFDF8` is already the lightest ink that is still cream.

### 4.4 The darkest pastel

By relative luminance, `--df-p-peach-100` `#FBE0D3` (L = 0.7852) is the darkest of the six:

| Pastel | Luminance |
|---|---|
| mint-100 `#DDF3E4` | 0.8507 |
| butter-100 `#FBEBC8` | 0.8410 |
| sky-100 `#DDEBFB` | 0.8175 |
| stone-100 `#EDE7DC` | 0.8032 |
| lilac-100 `#E9E3FB` | 0.7923 |
| **peach-100 `#FBE0D3`** | **0.7852** |

Peach is the worst case for every ink, so it is the pair to test:

| Ink on `#FBE0D3` | Ratio |
|---|---|
| `--df-text-primary` `#241F1A` | **12.99:1** |
| `--df-text-secondary` `#5B5348` | **6.02:1** |
| `--df-text-meta` `#6B6153` | **4.83:1** |
| `--df-state-danger-ink` `#A33218` | **5.52:1** |

### 4.5 Phone dark

| Pair | Ratio | |
|---|---|---|
| `live` `#8FE0B4` on `#22322A` | **8.66:1** | pass |
| `synced` `#A9CBEE` on `#222C37` | **8.40:1** | pass |
| `stale` `#F0C67C` on `#352D1F` | **8.45:1** | pass |
| `offline` `#F5A98F` on `#382720` | **7.41:1** | pass |
| `unknown` `#CBC0B0` on `#302B25` | **7.81:1** | pass |
| `wake` `#C2B6F2` on `#2B2738` | **7.77:1** | pass |
| primary label `#1B0E08` on `#D9502C` | **4.61:1** | pass |
| … hover on `#E2603C` | **5.37:1** | pass |
| accent text `#FF9B7A` on card `#1C1814` | **8.59:1** | pass |
| … on well `#262019` | **7.84:1** | pass |
| `--df-text-primary` `#F4ECE2` on page | **16.07:1** | pass |
| … on card | **15.08:1** | pass |
| `--df-text-secondary` `#C9BEAF` on card | **9.64:1** | pass |
| `--df-text-meta` `#A0968A` on card / well / pressed | **6.07 / 5.54 / 4.83:1** | pass |
| outgoing bubble `#F4ECE2` on `#3A241C` | **12.38:1** | pass |
| `delivered` `#8FE0B4` on the outgoing bubble | **9.31:1** | pass |
| `failed` `#F5A98F` on the outgoing bubble | **7.56:1** | pass |
| bubble meta `#A0968A` on the outgoing bubble | **4.99:1** | pass |
| danger solid `#FFFDF8` on `#8A3A28` | **7.60:1** | pass |
| focus ring `#FF9B7A` on page | **9.16:1** | pass |
| primary fill `#D9502C` vs page (non-text) | **4.60:1** | pass |

### 4.6 Where the approved document does not survive the arithmetic

Three claims in `DESIGN_2026.md` do not hold. The corrections are already in §1, so the
migration is where they land:

| Claim | Computed | Correction |
|---|---|---|
| `--accent #C9482A` is "5.1:1 on `--bg`" | **4.39:1** on `#FBF6EE`; 4.13 on the well, 3.72 on pressed | text accent is `#B23B20` (5.51 / 5.19 / 4.67) |
| `--accent-fill #D9502C` is "white text, 4.6:1" | **4.02:1** with `#FFFDF8`, 4.09:1 with pure white | fill is `#C9482A` (4.65:1) |
| `--ink-3 #857A6B` carries metadata | **4.14:1** on card, 3.91 on page, 3.68 on well, 3.31 on pressed | `#6B6153` (5.97 / 5.64 / 5.31 / 4.78) |

The third one matters most: it is the timestamp and table-header ink, used 25 times in
`dashboard/src/app.css`. It was the largest real accessibility defect in the shipped console,
and it is invisible in a screenshot because grey-on-cream always looks "fine".

### 4.7 Pairs I could not prove — owner's call

| Pair | Ratio | Issue | Options |
|---|---|---|---|
| `--df-border-control #D3C4AC` vs card | **1.68:1** | an input boundary is a UI component; 1.4.11 asks 3:1 | accept (the field is also distinguishable by fill), or introduce `--df-p-cream-600` ≈ `#9A8F7E` for control borders only |
| phone dark hairline `#3A3128` vs page | **1.48:1** | same, for every divider in dark | dividers are decorative here, not functional — document it, or accept |
| dark outgoing bubble `#3A241C` vs page | **1.30:1** | a bubble edge as the only cue would fail | bubbles also carry alignment and the status row; if that is not considered enough, add `--df-c-bubble-out-border: color-mix(… coral 30%)` |
| `--df-p-umber-300 #857A6B` | 4.14 / 3.68 | **not text** | it is the icon-stroke and dot colour only; 3:1 applies and holds at 4.14 on card, 3.68 on well |

I did not raise any of these into the token set, because each one is a look decision rather
than a correctness one, and the direction is the owner's.

---

## 5. The three decisions that will be hardest to reverse

### 1. Coral is two roles, and the button darkens

`--df-accent-fill` and `--df-accent-text` are separate steps of one family, and the fill is
`#C9482A`, not the `#D9502C` in the approved preview. This is forced by §4.6: one coral
cannot be both a 4.5:1 label background and 4.5:1 text on cream.

Why it is hard to undo: coral is in the brand mark, every primary button, every link, every
focus ring, the selected nav, the unread badge and the outgoing bubble — five of which are
component tokens pointing at `--df-accent-*`. Reverting to a single bright coral means
re-checking every one of those pairs and accepting a 3:1 button label (large-text only),
which fails for the 13px console buttons. The visible cost is that the brand reads a shade
deeper and more brick than the preview; the invisible cost of the alternative is a button
that no longer meets 4.5:1.

### 2. The five send states became tokens, and therefore a contract

`--df-c-bubble-status-{queued,sending,sent,delivered,failed}-ink` names five words in the
phone's UI. `CONSOLE_UX.md` §6 already promises "queued → acked → sent → delivered, with the
failure reason at the stage it failed"; the console has a second, unrelated five-word
vocabulary for devices (`live/synced/stale/offline/unknown`).

Once the send states are tokens, they are consumed by CSS, by the Rust core's status enum,
by the outbound queue and by whatever the Kotlin notification says. Adding `expired`,
merging `queued`/`sending`, or renaming `sent` to `accepted` is no longer a copy edit — it is
a migration across four languages, and the token names will be the thing that makes the
mismatch visible. Two five-word vocabularies in one product is already a documentation
hazard; this is the decision that either keeps them apart deliberately (as here, one is
"reachability", the other is "this message") or lets them blur.

### 3. One root-level token file, dark owned per app

`design/tokens.css` at the repo root, imported by relative path from two independently
built apps, with each app keeping its own dark block. Nothing enforces it: no package
version, no build guard, no schema. It works because both apps happen to sit one directory
below the file, and because Vite inlines the import.

Undoing it means introducing the build step this document avoided (a workspace package or a
generated copy) and rewriting two import lines plus every dark block's placement; more
importantly it re-opens the question of where a token is allowed to differ between the
console and the phone. The alternative — tokens per app with a documented diff — is worse
right now (that is the 64-names/9-shared state in §0) but it is the option a future
contributor is most likely to reach for, because it needs no explanation. If this decision
is not written into the repo as a rule with a check (§2.4), it will be undone by the first
person who needs one value and does not want to touch the other app.

A fourth, smaller trap worth noting while it is cheap: the console's dark theme is currently
cool-neutral and will look wrong beside the warm light theme. Renaming it (§2.1) keeps it
working but freezes the mismatch; deciding it later means touching 24 declarations and every
dark screenshot in the review set.

---

## Appendix — reproducing the numbers

```python
def lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def lum(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)
```

Run it against the hex values in §1.2. The table in §4.4 is `lum()` sorted; the chip rows
are `ratio(pastel_ink, pastel_container)`.

## Open questions for the owner

1. Dock: four destinations (Threads · Devices · Alerts · Settings) — is **Settings** the
   right fourth, or should `Alerts` fold into `Devices` and leave room for a fifth later?
2. Console dark: rename-and-freeze, or delete the theme until it is redesigned warm?
3. Toast on the phone: transient confirmation only (§1.5), or should a failed send also raise
   one when the thread is closed?
