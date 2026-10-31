// Two more landing assets, in the hero's world: the same oak plinth, dark case, cream
// deck and coral accent, so the page reads as one set.
//
//   ANATOMY_ASSET_KIT=~/.agents/skills/anatomy-asset/kit node design/landing/build-assets.mjs
//
// seal.svg   — a notary's seal press: the phone stamps every request it signs.
// sorter.svg — a mail sorter: a flow is the set of rules that routes each message.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = process.env.ANATOMY_ASSET_KIT ?? "/home/jony/.agents/skills/anatomy-asset/kit";
const k = await import(join(KIT, "iso-kit.mjs"));
const a = await import(join(KIT, "asset.mjs"));

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = "#f6efe3";
const CORAL = "#d9502c";
const CASE_INK = "#3a3129";
const OAK = "#8a6a45";
const BRASS = "#a8804a";
const ACCENTS = { brand: CORAL, case: CASE_INK, oak: OAK, brass: BRASS, ink: "#241f1a" };

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (pts, style) => k.dotsSvg(pts, style);
const accent = (svg) => `<g class="ac-brand">${svg}</g>`;
const mat = (name, svg) => `<g class="ac-${name}">${svg}</g>`;

// ---------------------------------------------------------------------------
// shared base: oak plinth on rubber feet, dark case, cream deck plate
// ---------------------------------------------------------------------------
function base({ plinth, plinthH, kase, caseZ, caseH, deckInset, deckH, P, floating = false }) {
  const at = (p) => k.iso(p, P);
  if (floating) {
    // a floating platform instead of a plinth: the same language as the hero figure
    const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(plinth, -3), -6, 7, P)}"/>`];
    out.push(S(k.slabOf(plinth, -6, 6, P, 12, 1.6), { tone: "hi", crease: "none" }));
    out.push(L(k.planOutline(k.insetPlan(plinth, 5), 0, P, 12), { tone: "faint" }));
    return { out, deck: plinth, top: 0 };
  }
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(plinth, -4), -7, 6, P)}"/>`];
  for (const [x, y] of k.corners(plinth, 22)) {
    out.push(mat("ink", S(k.cylinder(x, y, 7, -7, 1.6, P, 26), { tone: "lo" })));
    out.push(mat("ink", S(k.cylinder(x, y, 5.6, -5.4, 5.4, P, 26), { tone: "mid" })));
  }
  out.push(mat("oak", S(k.slabOf(plinth, 0, plinthH, P, 10, 2), { tone: "lo" })));
  out.push(mat("case", S(k.slabOf(kase, caseZ, caseH, P, 12, 1.8), { tone: "mid" })));
  const deck = k.insetPlan(kase, deckInset);
  out.push(S(k.slabOf(deck, caseZ + caseH, deckH, P, 12, 0.8), { tone: "hi", crease: "none" }));
  const screws = k.corners(deck, 8);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2, caseZ + caseH + deckH, P, 16)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, caseZ + caseH + deckH])), { size: 0.5, tone: "lo" }));
  return { out, deck, top: caseZ + caseH + deckH };
}

// ---------------------------------------------------------------------------
// 1. seal press
// ---------------------------------------------------------------------------
function sealPress() {
  const W = 700;
  const H = 640;
  const REGION = { x: 26, y: 26, w: 648, h: 588 };
  const PLINTH = { x: -108, y: -78, w: 216, d: 156, r: 12 };
  const KASE = { x: -94, y: -66, w: 188, d: 132, r: 10 };
  const PRESS_TOP = 118;

  const P = a.fitInto(
    [...k.boxCorners(PLINTH, -7, PRESS_TOP + 8), ...k.boxCorners({ x: -62, y: -46, w: 130, d: 24, r: 5 }, -7, PRESS_TOP + 8)],
    REGION,
    { pad: 22, azimuth: 60 },
  );
  const at = (p) => k.iso(p, P);
  const { out, top } = base({
    plinth: PLINTH, plinthH: 12, kase: KASE, caseZ: 12, caseH: 18, deckInset: 8, deckH: 2.2, P,
  });

  // the press body: a C-frame on a plate
  const plate = { x: -62, y: -48, w: 128, d: 96, r: 7 };
  out.push(mat("case", S(k.slabOf(plate, top, 6, P, 8, 0.9), { tone: "mid" })));
  out.push(mat("case", L(k.planOutline(k.insetPlan(plate, 3.5), top + 6, P, 8), { tone: "faint" })));
  const post = { x: -56, y: -42, w: 26, d: 24, r: 5 };
  out.push(mat("case", S(k.slabOf(post, top + 6, 76, P, 6, 0.9), { tone: "mid" })));
  const arm = { x: -56, y: -42, w: 108, d: 24, r: 5 };
  out.push(mat("case", S(k.slabOf(arm, top + 82, 14, P, 6, 0.9), { tone: "mid" })));
  out.push(mat("case", L(k.planOutline(k.insetPlan(arm, 3), top + 96, P, 6), { tone: "faint" })));

  // screw: a knurled shaft through the arm, a collar, the die below it
  const sx = 18;
  const sy = -30;
  out.push(S(k.cylinder(sx, sy, 9, top + 92, 8, P, 28, 1), { tone: "hi" }));
  out.push(L(k.knurl(sx, sy, 9, top + 92.6, top + 99.4, 24, P), { tone: "lo" }));
  out.push(mat("case", S(k.cylinder(sx, sy, 6.4, top + 46, 46, P, 24), { tone: "mid" })));
  out.push(mat("brass", S(k.cylinder(sx, sy, 11, top + 40, 6, P, 30, 1), { tone: "hi" })));
  out.push(accent(L(k.ring(sx, sy, 6.4, top + 40, P, 24), { tone: "hi" })));
  out.push(accent(D([at([sx, sy, top + 40])], { size: 0.9, tone: "hi" })));

  // the lever, up and to the right of the screw head
  const lever = { x: sx, y: sy - 5, w: 62, d: 10, r: 5 };
  out.push(S(k.slabOf(lever, top + 100, 5, P, 6, 0.8), { tone: "hi" }));
  out.push(mat("brass", S(k.cylinder(sx + 62, sy, 8, top + 100, 9, P, 24, 1), { tone: "hi", lit: true })));
  out.push(L(k.ring(sx + 62, sy, 8, top + 109, P, 24), { tone: "faint" }));

  // paper on the plate, with the seal it just took
  const paper = { x: -46, y: -22, w: 82, d: 64, r: 3 };
  out.push(S(k.slabOf(paper, top + 6, 0.8, P, 4, 0), { tone: "hi", crease: "none", flat: true }));
  out.push(L(k.planOutline(paper, top + 6.8, P, 4), { tone: "faint" }));
  out.push(L([[paper.x + 9, 1], [paper.x + 9, 2], [paper.x + 9, 3]]
    .map(([x0, i]) => k.lineOnTop([x0, paper.y + 10 + i * 9], [paper.x + 62, paper.y + 10 + i * 9], top + 6.8, P)).join(""), { tone: "lo" }));
  out.push(accent(S(k.cylinder(sx - 12, sy + 24, 10, top + 6.8, 1.6, P, 28, 1.2), { tone: "hi", lit: true })));
  out.push(accent(L(k.ring(sx - 12, sy + 24, 6.6, top + 8.4, P, 24), { tone: "hi" })));

  return a.assetSvg({
    width: W,
    height: H,
    label:
      "An isometric seal press on an oak plinth: a dark C-frame with a brass die, a knurled screw and a lever, a sheet of paper on the plate carrying a coral wax seal.",
    body: out.join(""),
    paper: PAPER,
    accents: ACCENTS,
    weight: 0.85,
    id: "dakflare-seal",
  });
}

// ---------------------------------------------------------------------------
// 2. mail sorter
// ---------------------------------------------------------------------------
function mailSorter() {
  const W = 760;
  const H = 560;
  const REGION = { x: 24, y: 24, w: 712, h: 512 };
  const PLINTH = { x: -150, y: -92, w: 300, d: 184, r: 12 };
  const KASE = { x: -136, y: -80, w: 272, d: 160, r: 10 };

  const P = a.fitInto(
    [...k.boxCorners(PLINTH, -7, 150), ...k.boxCorners({ x: -120, y: -56, w: 240, d: 112, r: 6 }, -7, 150)],
    REGION,
    { pad: 22, azimuth: 60 },
  );
  const at = (p) => k.iso(p, P);
  const { out, top } = base({
    plinth: { x: -170, y: -104, w: 340, d: 208, r: 12 }, plinthH: 0, kase: KASE, caseZ: 0, caseH: 0, deckInset: 8, deckH: 0, P, floating: true,
  });

  // the tray: an oak carcass with two rows of four slots
  const TRAY = { x: -116, y: -54, w: 232, d: 108, r: 7 };
  out.push(mat("case", S(k.slabOf(TRAY, top, 24, P, 8, 1.2), { tone: "mid" })));
  out.push(mat("case", L(k.planOutline(k.insetPlan(TRAY, 3.2), top + 24, P, 8), { tone: "faint" })));

  const COLS = 4;
  const ROWS = 2;
  const cw = 46;
  const cd = 40;
  const gapX = 8;
  const gapY = 10;
  const x0 = -116 + (232 - (COLS * cw + (COLS - 1) * gapX)) / 2;
  const y0 = -54 + (108 - (ROWS * cd + (ROWS - 1) * gapY)) / 2;
  const slots = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      slots.push({ x: x0 + c * (cw + gapX), y: y0 + r * (cd + gapY), w: cw, d: cd, r: 3, filled: (r * COLS + c) % 3 !== 2 });
    }
  }

  const FLOAT_AT = { x: slots[1].x + 8, y: slots[1].y + 6 };
  for (const slot of slots) {
    out.push(S(k.slabOf(slot, top + 24, 1.2, P, 4), { tone: "lo", crease: "none", flat: true }));
    out.push(L(k.planOutline(slot, top + 25.2, P, 4), { tone: "lo" }));
    if (!slot.filled) continue;
    // a standing envelope in the slot: a thin upright slab, its flap a rule
    const env = { x: slot.x + 6, y: slot.y + 6, w: slot.w - 12, d: 2.4, r: 1.2 };
    out.push(S(k.slabOf(env, top + 25.2, 26, P, 4, 0.6), { tone: "hi" }));
    out.push(L(k.lineOnTop([env.x, env.y], [env.x + env.w, env.y], top + 51.2, P), { tone: "faint" }));
  }

  // the envelope that is being filed: lifted, drifting, in the accent
  const floatEnv = accent(
    S(k.slabOf({ x: FLOAT_AT.x, y: FLOAT_AT.y, w: 34, d: 3, r: 1.4 }, top + 58, 24, P, 4, 0.6), { tone: "hi", lit: true }) +
      L(k.lineOnTop([FLOAT_AT.x, FLOAT_AT.y], [FLOAT_AT.x + 34, FLOAT_AT.y], top + 82, P), { tone: "hi" }),
  );
  const halo = `<path class="iso-halo" d="${k.haloOf({ x: FLOAT_AT.x, y: FLOAT_AT.y - 2, w: 34, d: 7, r: 3 }, top + 27.2, 0.1, P)}" style="filter:blur(5px)"/>`;
  out.push(a.amFloat(floatEnv, P, { rise: 3, period: 7200, halo }));

  // a brass label holder on the tray's front edge, with three engraved rules
  const label = { x: -30, y: 56, w: 60, d: 2.6, r: 1 };
  out.push(mat("brass", S(k.slabOf(label, top + 16, 1, P, 4, 0), { tone: "lo", crease: "none" })));
  out.push(mat("brass", L(k.planOutline(label, top + 17, P, 4), { tone: "faint" })));

  return a.assetSvg({
    width: W,
    height: H,
    label:
      "An isometric mail sorter on an oak plinth: a tray of eight slots holding cream envelopes, one coral envelope lifted above the slot it is being filed into, and a brass label holder.",
    body: out.join(""),
    paper: PAPER,
    accents: ACCENTS,
    weight: 0.85,
    id: "dakflare-sorter",
  });
}

mkdirSync(HERE, { recursive: true });
for (const [name, build] of [["seal", sealPress], ["sorter", mailSorter]]) {
  const svg = build();
  writeFileSync(join(HERE, `${name}.svg`), svg);
  console.log(`${name}.svg ${(svg.length / 1024).toFixed(0)} KB`);
}
