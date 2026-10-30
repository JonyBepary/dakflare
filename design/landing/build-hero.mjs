// DakFlare landing hero — a relay desk.
//
//   ANATOMY_ASSET_KIT=/home/jony/.agents/skills/anatomy-asset/kit node design/landing/build-hero.mjs
//
// Writes design/landing/hero.svg (the standalone drop) and design/landing/hero.html (the
// preview page the checks run on). The .svg is inlined into worker/public/index.html.
//
// The object: one operator's dispatch desk. A handset rests in a cradle, six keys sit along
// the front with one in coral, a tape roll feeds its printed strip down the right, a signal
// lamp marks the deck, and a brass plate is screwed down. Oak base, dark case, cream deck.

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

const W = 804;
const H = 538;
const REGION = { x: 22, y: 22, w: 760, h: 494 };

// ---------- world ----------
const FOOT_H = 7;
const PLINTH = { x: -170, y: -98, w: 340, d: 196, r: 14 };
const PLINTH_H = 14;
const CASE = { x: -152, y: -82, w: 304, d: 164, r: 12 };
const CASE_Z = PLINTH_H;
const CASE_H = 40;
const DECK_Z = CASE_Z + CASE_H;
const DECK = k.insetPlan(CASE, 9);
const DECK_TOP = DECK_Z + 2.4;

const CRADLE_BAR = { x: -134, y: -62, w: 208, d: 46, r: 9 };
const CRADLE_TOP = DECK_TOP + 8;
const POST_TOP = CRADLE_TOP + 3;

const HAND = { x: -126, y: -54, w: 188, d: 36, r: 18 };
const HAND_Z = CRADLE_TOP + 0.8;
const HAND_H = 18;
const EAR = [-100, -36];
const MOUTH = [58, -36];

const KEYS = Array.from({ length: 6 }, (_, i) => ({ x: -136 + i * 24, y: 36, w: 20, d: 26, r: 3 }));

const ROLL = { x: 104, y: -38, r: 26 };
const SLOT = { x: 76, y: -12, w: 52, d: 9, r: 3 };
const TAPE = { x: 80, y: -3, w: 44, d: 48, r: 2 };
const LAMP = { x: 8, y: 4, r: 7 };
const PLATE = { x: -120, y: -10, w: 92, d: 24, r: 3 };

const P = a.fitInto(
  [...k.boxCorners(PLINTH, -FOOT_H, HAND_Z + HAND_H + 8), ...k.boxCorners(CASE, -FOOT_H, HAND_Z + HAND_H + 8)],
  REGION,
  { pad: 10, azimuth: 60 },
);

const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (pts, style) => k.dotsSvg(pts, style);
const depth = ([x, y, z = 0]) => k.depthOf([x, y, z], P);
const byDepth = (items, key = (i) => i) => [...items].sort((p, q) => depth(key(p)) - depth(key(q)));
const accent = (svg) => `<g class="ac-brand">${svg}</g>`;
const mat = (name, svg) => `<g class="ac-${name}">${svg}</g>`;

// ---------- base ----------
function base() {
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(PLINTH, -4), -FOOT_H, 6, P)}"/>`];
  for (const [x, y] of byDepth(k.corners(PLINTH, 24))) {
    out.push(mat("ink", S(k.cylinder(x, y, 7.5, -FOOT_H, 1.6, P, 28), { tone: "lo" })));
    out.push(mat("ink", S(k.cylinder(x, y, 6, -FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" })));
  }
  out.push(
    mat("oak", S(k.slabOf(PLINTH, 0, PLINTH_H, P, 10, 2), { tone: "lo" })),
  );
  return out.join("");
}

// ---------- case ----------
function body() {
  const out = [];
  out.push(
    mat("case", S(k.slabOf(CASE, CASE_Z, CASE_H, P, 12, 1.8), { tone: "mid" })),
  );
  out.push(S(k.slabOf(DECK, DECK_Z, 2.4, P, 12, 0.8), { tone: "hi", crease: "none" }));
  const screws = k.corners(DECK, 9);
  out.push(L(screws.map(([x, y]) => k.ring(x, y, 2.2, DECK_TOP, P, 18)).join(""), { tone: "lo" }));
  out.push(D(screws.map(([x, y]) => at([x, y, DECK_TOP])), { size: 0.55, tone: "lo" }));
  return out.join("");
}

// ---------- cradle ----------
function cradle() {
  const out = [];
  out.push(mat("case", S(k.slabOf(CRADLE_BAR, DECK_TOP, CRADLE_TOP - DECK_TOP, P, 8, 0.9), { tone: "mid" })));
  out.push(mat("case", L(k.planOutline(k.insetPlan(CRADLE_BAR, 3), CRADLE_TOP, P, 8), { tone: "faint" })));
  for (const x of [-140, 54]) {
    const plan = { x, y: -58, w: 20, d: 20, r: 5 };
    out.push(mat("case", S(k.slabOf(plan, DECK_TOP, POST_TOP - DECK_TOP, P, 6, 0.8), { tone: "mid" })));
    out.push(mat("case", L(k.planOutline(k.insetPlan(plan, 3.5), POST_TOP, P, 6), { tone: "lo" })));
  }
  return out.join("");
}

// ---------- handset ----------
function handset() {
  const out = [];
  const top = HAND_Z + HAND_H;
  out.push(
    S(k.slabOf(HAND, HAND_Z, HAND_H, P, 16, 2.2), {
      tone: "hi",
      lit: true,
      inner: L(k.sideSeam(HAND, 6, P, 16), { tone: "faint" }),
    }),
  );
  out.push(L(k.planOutline(k.insetPlan(HAND, 3.4), top, P, 16), { tone: "faint" }));

  // earpiece cup: a raised disc with a ring of holes
  out.push(S(k.cylinder(EAR[0], EAR[1], 20, top, 1.2, P, 40), { tone: "lo" }));
  out.push(S(k.cylinder(EAR[0], EAR[1], 18, top + 1.2, 5.4, P, 40, 1), { tone: "hi", lit: true }));
  out.push(L(k.ring(EAR[0], EAR[1], 14.6, top + 6.6, P, 36), { tone: "faint" }));
  const holes = [];
  for (let i = 0; i < 14; i++) {
    const t = (i / 14) * Math.PI * 2;
    holes.push(at([EAR[0] + Math.cos(t) * 10.4, EAR[1] + Math.sin(t) * 10.4, top + 6.6]));
  }
  out.push(D(holes, { size: 0.6, tone: "lo" }));
  out.push(D([at([EAR[0], EAR[1], top + 6.6])], { size: 0.7, tone: "lo" }));

  // mouthpiece cup with its grille
  out.push(S(k.cylinder(MOUTH[0], MOUTH[1], 18, top, 1.2, P, 40), { tone: "lo" }));
  out.push(S(k.cylinder(MOUTH[0], MOUTH[1], 16, top + 1.2, 4.4, P, 40, 1), { tone: "hi" }));
  out.push(D(k.dotGrid(MOUTH[0] - 9, MOUTH[1] - 7, 4, 3, 5.6, top + 5.6, P), { size: 0.62, tone: "lo" }));

  // the bar key on the grip
  out.push(S(k.slabOf({ x: -20, y: -44, w: 32, d: 12, r: 4 }, top, 2.4, P, 6, 0.5), { tone: "mid" }));
  out.push(L(k.planOutline({ x: -20, y: -44, w: 32, d: 12, r: 4 }, top + 2.4, P, 6), { tone: "lo" }));
  return out.join("");
}

// ---------- keys ----------
function keys() {
  const out = [];
  for (const [i, key] of byDepth(KEYS, (kk) => [kk.x + kk.w / 2, kk.y + kk.d / 2]).entries()) {
    const well = k.insetPlan(key, -3);
    out.push(S(k.slabOf(well, DECK_TOP, 1.2, P, 6), { tone: "lo", crease: "none", flat: true }));
    const cap = k.slabOf(key, DECK_TOP + 1.2, 6.4, P, 6, 1);
    const solid = S(cap, { tone: "hi", lit: i === 2 });
    const rule = L(k.lineOnTop([key.x, key.y + key.d - 7], [key.x + key.w, key.y + key.d - 7], DECK_TOP + 7.6, P), {
      tone: "faint",
    });
    out.push(i === 2 ? accent(solid + rule) : mat("case", solid + rule));
  }
  return out.join("");
}

// ---------- tape ----------
function tape() {
  const out = [];
  out.push(S(k.slabOf(SLOT, DECK_TOP - 0.3, 0.8, P, 4, 0), { tone: "lo", crease: "none", flat: true }));
  out.push(L(k.planOutline(SLOT, DECK_TOP + 0.5, P, 4), { tone: "faint" }));

  out.push(S(k.cylinder(ROLL.x, ROLL.y, ROLL.r, DECK_TOP, 24, P, 44, 1.4), { tone: "hi" }));
  out.push(L(k.knurl(ROLL.x, ROLL.y, ROLL.r, DECK_TOP, DECK_TOP + 23.5, 44, P), { tone: "lo" }));
  // the two rings the knurl ends land on, so no line floats
  out.push(L(k.ring(ROLL.x, ROLL.y, ROLL.r, DECK_TOP, P, 44), { tone: "faint" }));
  out.push(L(k.ring(ROLL.x, ROLL.y, ROLL.r, DECK_TOP + 23.5, P, 44), { tone: "faint" }));
  out.push(L(k.ring(ROLL.x, ROLL.y, ROLL.r - 2.4, DECK_TOP + 24, P, 44), { tone: "faint" }));
  out.push(mat("case", S(k.cylinder(ROLL.x, ROLL.y, 8, DECK_TOP + 24, 1.2, P, 24), { tone: "lo" })));
  out.push(mat("case", L(k.ring(ROLL.x, ROLL.y, 5, DECK_TOP + 25.2, P, 20), { tone: "faint" })));

  const strip = [];
  strip.push(S(k.slabOf(TAPE, DECK_TOP, 0.8, P, 4, 0), { tone: "hi", crease: "none", flat: true }));
  strip.push(L(k.planOutline(TAPE, DECK_TOP + 0.8, P, 4), { tone: "faint" }));
  strip.push(L(k.planOutline(k.insetPlan(TAPE, 4), DECK_TOP + 0.8, P, 4), { tone: "faint" }));
  const rules = [];
  for (let i = 0; i < 5; i++) {
    const y = TAPE.y + 10 + i * 8;
    rules.push(k.lineOnTop([TAPE.x + 4, y], [TAPE.x + TAPE.w - 4, y], DECK_TOP + 0.8, P));
  }
  strip.push(L(rules.join(""), { tone: "lo" }));
  strip.push(
    accent(L(k.lineOnTop([TAPE.x + 4, TAPE.y + 10], [TAPE.x + TAPE.w - 4, TAPE.y + 10], DECK_TOP + 0.8, P), { tone: "hi" })),
  );
  out.push(a.amSlide(strip.join(""), [0, 2.4, 0], P, { period: 11000 }));
  return out.join("");
}

// ---------- lamp, plate ----------
function lamp() {
  const out = [];
  out.push(mat("case", S(k.cylinder(LAMP.x, LAMP.y, LAMP.r + 2.6, DECK_TOP, 2.4, P, 32), { tone: "lo" })));
  out.push(mat("case", S(k.cylinder(LAMP.x, LAMP.y, LAMP.r, DECK_TOP + 2.4, 3.4, P, 32, 0.8), { tone: "mid" })));
  out.push(a.amBlink(accent(S(k.cylinder(LAMP.x, LAMP.y, LAMP.r - 2.2, DECK_TOP + 5.8, 1.8, P, 28, 1.2), { tone: "hi", lit: true })), { period: 3600, min: 0.25 }));
  out.push(L(k.ring(LAMP.x, LAMP.y, LAMP.r - 1.2, DECK_TOP + 5.8, P, 28), { tone: "lo" }));
  return out.join("");
}

function nameplate() {
  const out = [];
  out.push(mat("brass", S(k.slabOf(PLATE, DECK_TOP, 1, P, 5, 0), { tone: "lo", crease: "none" })));
  out.push(mat("brass", L(k.planOutline(PLATE, DECK_TOP + 1, P, 5), { tone: "faint" })));
  out.push(mat("brass", L(k.planOutline(k.insetPlan(PLATE, 6), DECK_TOP + 1, P, 5), { tone: "lo" })));
  const rules = [];
  for (let i = 0; i < 3; i++) {
    const y = PLATE.y + 7 + i * 5.6;
    rules.push(k.lineOnTop([PLATE.x + 6, y], [PLATE.x + PLATE.w - 6, y], DECK_TOP + 1, P));
  }
  out.push(L(rules.join(""), { tone: "mid" }));
  out.push(D(k.corners(PLATE, 5).map(([x, y]) => at([x, y, DECK_TOP + 1])), { size: 0.5, tone: "lo" }));
  return out.join("");
}

// ---------- assemble ----------
const art = [base(), body(), cradle(), nameplate(), lamp(), keys(), tape(), handset()].join("");

const svg = a.assetSvg({
  width: W,
  height: H,
  label:
    "An isometric dispatch desk: a handset resting in a cradle, six keys along the front with one in coral, a paper tape roll feeding its printed strip down the right, a coral signal lamp and a screwed brass plate on a cream deck.",
  body: art,
  paper: PAPER,
  accents: { brand: CORAL, case: CASE_INK, oak: OAK, brass: BRASS, ink: "#241f1a" },
  weight: 0.85,
  id: "dakflare-hero",
});

mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, "hero.svg"), svg);
writeFileSync(join(HERE, "hero.html"), a.previewHtml({ title: "DakFlare relay desk", svg, paper: PAPER, width: W }));
console.log(`hero.svg ${(svg.length / 1024).toFixed(0)} KB`);
