// The landing hero, as a scene rather than an object: one operator's relay room. A server
// cabinet, a desk with handsets standing in their docks, two people, and the cable that
// joins them. No plinth — the room sits on a thin stage so it can run full-bleed.
//
//   ANATOMY_ASSET_KIT=~/.agents/skills/anatomy-asset/kit node design/landing/build-scene.mjs
//
// Writes design/landing/scene.svg and design/landing/scene.html (the check page).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = process.env.ANATOMY_ASSET_KIT ?? "/home/jony/.agents/skills/anatomy-asset/kit";
const k = await import(join(KIT, "iso-kit.mjs"));
const a = await import(join(KIT, "asset.mjs"));

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = "#f6efe3";
const CORAL = "#d9502c";
const CASE_INK = "#3a3129";
const BRASS = "#a8804a";
const ACCENTS = { brand: CORAL, case: CASE_INK, brass: BRASS, ink: "#241f1a", skin: "#c9a887", ground: "#efe6d6" };

const W = 1120;
const H = 520;
const REGION = { x: 30, y: 24, w: 1060, h: 472 };

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (pts, style) => k.dotsSvg(pts, style);
const accent = (svg) => `<g class="ac-brand">${svg}</g>`;
const mat = (name, svg) => `<g class="ac-${name}">${svg}</g>`;

// ---------- world ----------
// one unit is 10 mm: a person is 170, a desk 72 high, a handset 18
const GROUND = { x: -268, y: -126, w: 440, d: 252, r: 12 };
const RACK = { x: -248, y: -46, w: 86, d: 96, r: 5 };
const RACK_H = 200;
const DESK = { x: -132, y: -24, w: 176, d: 86, r: 5 };
const DESK_H = 72;

const P = a.fitInto([...k.boxCorners(GROUND, -4, 0), ...k.boxCorners(RACK, 0, RACK_H), ...k.boxCorners({ x: 130, y: 10, w: 30, d: 20, r: 4 }, 0, 170)], REGION, {
  pad: 10,
  azimuth: 60,
});
const at = (p) => k.iso(p, P);
const depth = ([x, y, z = 0]) => k.depthOf([x, y, z], P);
const byDepth = (items, key = (i) => i) => [...items].sort((p, q) => depth(key(p)) - depth(key(q)));

// ---------- stage ----------
function stage() {
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(GROUND, -10), -4, 8, P)}"/>`];
  out.push(mat("ground", S(k.slabOf(GROUND, -4, 4, P, 14, 1.6), { tone: "lo", crease: "none" })));
  out.push(mat("ground", L(k.planOutline(k.insetPlan(GROUND, 6), 0, P, 14), { tone: "faint" })));
  return out.join("");
}

// ---------- server cabinet ----------
function rack() {
  const out = [];
  out.push(mat("case", S(k.slabOf(RACK, 0, RACK_H, P, 8, 2), { tone: "mid" })));
  out.push(mat("case", S(k.slabOf(k.insetPlan(RACK, 6), RACK_H, 4, P, 8, 1), { tone: "hi" })));
  out.push(L(k.planOutline(k.insetPlan(RACK, 6), RACK_H + 4, P, 8), { tone: "faint" }));

  // the rack's face: rows of unit slots, a pair of LEDs, a vent
  const face = [];
  for (let i = 0; i < 8; i++) {
    const z = 22 + i * 20;
    face.push(k.lineOnTop([RACK.x + 14, RACK.y + RACK.d - 2], [RACK.x + RACK.w - 14, RACK.y + RACK.d - 2], z, P));
  }
  out.push(L(face.join(""), { tone: "lo" }));

  // a door seam and a handle on the right
  out.push(L(k.lineOnTop([RACK.x + RACK.w - 22, RACK.y + RACK.d], [RACK.x + RACK.w - 22, RACK.y + RACK.d], RACK_H - 6, P), { tone: "faint" }));
  out.push(mat("brass", S(k.slabOf({ x: RACK.x + RACK.w - 26, y: RACK.y + RACK.d - 5, w: 4, d: 6, r: 1.6 }, 96, 26, P, 4, 0.5), { tone: "hi" })));

  // LEDs: two coral, one breathing
  const leds = [RACK.x + 14, RACK.x + 22, RACK.x + 30];
  for (const [i, x] of leds.entries()) {
    out.push(S(k.cylinder(x, RACK.y + RACK.d - 7, 1.8, RACK_H + 4, 1, P, 12), { tone: "lo" }));
    const dot = accent(D([at([x, RACK.y + RACK.d - 7, RACK_H + 5])], { size: 1.1, tone: "hi" }));
    out.push(i === 1 ? a.amBlink(dot, { period: 4200, min: 0.2 }) : dot);
  }

  // feet
  for (const [x, y] of k.corners(RACK, 10)) {
    out.push(mat("ink", S(k.cylinder(x, y, 3.6, 0, 3.6, P, 18), { tone: "mid" })));
  }
  return out.join("");
}

// ---------- desk ----------
function desk() {
  const out = [];
  // a counter: one dark block, a cream worktop, a kick recess at the floor
  out.push(mat("case", S(k.slabOf(k.insetPlan(DESK, 4), 0, DESK_H - 6, P, 8, 1.2), { tone: "mid" })));
  out.push(S(k.slabOf(k.insetPlan(DESK, 1.5), DESK_H - 6, 6, P, 8, 1.2), { tone: "hi" }));
  out.push(L(k.planOutline(k.insetPlan(DESK, 1.5), DESK_H, P, 8), { tone: "faint" }));
  // a drawer seam and a brass pull on the front
  out.push(mat("case", L(k.planOutline(k.insetPlan(DESK, 4), 30, P, 8), { tone: "faint" })));
  out.push(mat("brass", S(k.slabOf({ x: DESK.x + DESK.w / 2 - 12, y: DESK.y + DESK.d - 7, w: 24, d: 4, r: 1.6 }, 44, 2.4, P, 4, 0.4), { tone: "hi" })));
  return out.join("");
}

// ---------- a handset in its dock ----------
function handset(x, y, z, { accentPhone = false } = {}) {
  const out = [];
  const dock = { x: x - 7, y: y - 5, w: 14, d: 10, r: 2 };
  out.push(mat("case", S(k.slabOf(dock, z, 2.4, P, 4, 0.5), { tone: "mid" })));
  const body = { x: x - 4.6, y: y - 2.6, w: 9.2, d: 5.2, r: 1.6 };
  const phone = S(k.slabOf(body, z + 2.4, 34, P, 6, 0.9), { tone: "hi", lit: true });
  out.push(accentPhone ? accent(phone) : phone);
  const screen = { x: x - 3.4, y: y - 3.0, w: 6.8, d: 0.5, r: 0.4 };
  out.push(S(k.slabOf(screen, z + 8, 25, P, 3, 0), { tone: "lo", crease: "none", flat: true }));
  out.push(L(k.lineOnTop([x - 2.2, y - 3.0], [x + 1.4, y - 3.0], z + 26, P), { tone: "faint" }));
  return out.join("");
}

// ---------- a person, built from solids ----------
function person(x, y, { seated = false, face = 1 } = {}) {
  const out = [];
  const HIP = seated ? 46 : 86;
  const z0 = 0;
  if (seated) {
    // legs forward to the floor, thighs flat
    out.push(mat("case", S(k.slabOf({ x: x - 11, y: y - 2, w: 22, d: 34, r: 4 }, 42, 8, P, 4, 0.6), { tone: "mid" })));
    out.push(mat("case", S(k.slabOf({ x: x - 11, y: y + 30, w: 20, d: 8, r: 4 }, 4, 38, P, 4, 0.6), { tone: "mid" })));
  } else {
    for (const dx of [-11, 3]) {
      out.push(mat("case", S(k.slabOf({ x: x + dx, y: y - 5, w: 9, d: 12, r: 3 }, z0, HIP - 10, P, 4, 0.8), { tone: "mid" })));
      out.push(mat("ink", S(k.slabOf({ x: x + dx - 2, y: y - 7, w: 13, d: 18, r: 3 }, z0, 6, P, 4, 0.6), { tone: "mid" })));
    }
  }
  // torso, slightly tapered: two stacked slabs
  out.push(mat("case", S(k.slabOf({ x: x - 12, y: y - 8, w: 24, d: 16, r: 6 }, HIP, 32, P, 6, 1), { tone: "mid" })));
  out.push(mat("case", S(k.slabOf({ x: x - 15, y: y - 9, w: 30, d: 18, r: 8 }, HIP + 32, 13, P, 6, 1.2), { tone: "hi" })));
  // arms, hanging at the shoulder line
  for (const dx of [-19, 13]) {
    out.push(mat("case", S(k.slabOf({ x: x + dx, y: y - 6, w: 6.5, d: 12, r: 3 }, HIP + 10, 30, P, 4, 0.7), { tone: "mid" })));
    out.push(mat("skin", S(k.cylinder(x + dx + 3.2, y, 3.2, HIP + 2, 9, P, 12), { tone: "mid" })));
  }
  // neck, head, hair
  out.push(mat("skin", S(k.cylinder(x, y, 4.6, HIP + 45, 6, P, 14), { tone: "mid" })));
  out.push(mat("skin", S(k.cylinder(x, y, 8.6, HIP + 51, 14, P, 20, 1.6), { tone: "hi", lit: true })));
  out.push(mat("ink", S(k.cylinder(x, y, 8.7, HIP + 61, 4.5, P, 20, 1.2), { tone: "mid" })));
  // a phone in the standing person's hand
  if (!seated) {
      out.push(S(k.slabOf({ x: x + 20 * face, y: y - 2, w: 4.5, d: 8, r: 1.4 }, HIP + 16, 12, P, 4, 0.4), { tone: "hi" }));
  }
  return out.join("");
}

// ---------- cable ----------
function cable(from, to, centre, radius, turns, axis) {
  const coil = k.coil(from, to, centre, radius, turns, axis, P);
  return L(coil.back, { tone: "lo" }) + L(coil.front, { tone: "mid" });
}

// ---------- assemble ----------
const art = [
  stage(),
  rack(),
  desk(),
  handset(-104, 40, DESK_H),
  handset(-78, 40, DESK_H, { accentPhone: true }),
  handset(-52, 40, DESK_H),
  person(-96, -46),
  person(84, 26),
  cable(-46, 44, [-176, 26], 5, 3, "y"),
].join("");

const svg = a.assetSvg({
  width: W,
  height: H,
  label:
    "An isometric relay room: a server cabinet with lit status lamps, a desk with three handsets standing in their docks, an operator seated at it and a second person standing with a phone, joined by a coiled cable.",
  body: art,
  paper: PAPER,
  accents: ACCENTS,
  weight: 0.8,
  id: "dakflare-scene",
});

writeFileSync(join(HERE, "scene.svg"), svg);
writeFileSync(join(HERE, "scene.html"), a.previewHtml({ title: "DakFlare relay room", svg, paper: PAPER, width: W }));
console.log(`scene.svg ${(svg.length / 1024).toFixed(0)} KB`);
