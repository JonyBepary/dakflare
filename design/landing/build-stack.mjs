// The hero artifact: the four layers as one exploded stack, in a single projection — the
// same drawing as the four scroll cards, assembled so you can see the whole system at once.
//
//   ANATOMY_ASSET_KIT=~/.agents/skills/anatomy-asset/kit node design/landing/build-stack.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = process.env.ANATOMY_ASSET_KIT ?? "/home/jony/.agents/skills/anatomy-asset/kit";
const k = await import(join(KIT, "iso-kit.mjs"));
const a = await import(join(KIT, "asset.mjs"));

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = "#fffdf8";
const CORAL = "#d9502c";
const CASE_INK = "#3a3129";
const BRASS = "#a8804a";
const ACCENTS = { brand: CORAL, case: CASE_INK, brass: BRASS, ink: "#241f1a", ground: "#f6efe3" };

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (pts, style) => k.dotsSvg(pts, style);
const accent = (svg) => `<g class="ac-brand">${svg}</g>`;
const mat = (name, svg) => `<g class="ac-${name}">${svg}</g>`;

const W = 620;
const H = 720;
const REGION = { x: 26, y: 26, w: 568, h: 668 };

const PLATE = { x: -170, y: -92, w: 340, d: 184, r: 9 };
const Z = [0, 148, 296, 444]; // carrier at the bottom, operator at the top

const P = a.fitInto([...k.boxCorners(PLATE, 0, Z[3] + 120)], REGION, { pad: 10, azimuth: 58 });
const at = (p) => k.iso(p, P);

// one plate
function plate(z) {
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(PLATE, -6), z - 4, 5, P)}"/>`];
  out.push(mat("ground", S(k.slabOf(PLATE, z - 4, 4, P, 12, 1.2), { tone: "lo", crease: "none" })));
  out.push(mat("ground", L(k.planOutline(k.insetPlan(PLATE, 5), z, P, 12), { tone: "faint" })));
  return out.join("");
}

// a coral leader with a dot, pointing at the accent part of a layer
function leader(from, to, z) {
  return (
    accent(L(k.onTop([from, to], z, P), { tone: "hi" })) +
    accent(D([at([to[0], to[1], z])], { size: 1.5, tone: "hi" }))
  );
}

// ---------- L1 operator ----------
function operator(z) {
  const out = [];
  const win = { x: -150, y: -66, w: 148, d: 92, r: 5 };
  out.push(S(k.slabOf(win, z, 24, P, 8, 1.2), { tone: "hi", lit: true }));
  out.push(L(k.planOutline(win, z + 24, P, 8), { tone: "faint" }));
  out.push(L(k.lineOnTop([win.x, win.y + 14], [win.x + win.w, win.y + 14], z + 24, P), { tone: "lo" }));
  out.push(D([[win.x + 8, win.y + 7], [win.x + 15, win.y + 7], [win.x + 22, win.y + 7]].map(([x, y]) => at([x, y, z + 24])), { size: 1, tone: "lo" }));
  for (let i = 0; i < 3; i++) {
    out.push(L(k.lineOnTop([win.x + 12, win.y + 28 + i * 13], [win.x + win.w - 20 - i * 20, win.y + 28 + i * 13], z + 24, P), { tone: "faint" }));
  }
  const term = { x: 16, y: -56, w: 104, d: 76, r: 5 };
  out.push(mat("case", S(k.slabOf(term, z, 18, P, 8, 1.2), { tone: "mid" })));
  out.push(L(k.planOutline(term, z + 18, P, 8), { tone: "faint" }));
  out.push(L(k.lineOnTop([term.x + 10, term.y + 18], [term.x + 26, term.y + 18], z + 18, P), { tone: "lo" }));
  out.push(L(k.lineOnTop([term.x + 32, term.y + 18], [term.x + 84, term.y + 18], z + 18, P), { tone: "faint" }));
  out.push(L(k.lineOnTop([term.x + 10, term.y + 34], [term.x + 66, term.y + 34], z + 18, P), { tone: "faint" }));
  const chip = { x: -34, y: 42, w: 46, d: 28, r: 6 };
  out.push(accent(S(k.slabOf(chip, z, 10, P, 8, 1.2), { tone: "hi", lit: true })));
  out.push(accent(L(k.planOutline(chip, z + 10, P, 8), { tone: "hi" })));
  out.push(accent(L(k.ring(chip.x + 23, chip.y + 14, 7.5, z + 10, P, 22), { tone: "hi" })));
  return out.join("");
}

// ---------- L2 edge ----------
function edge(z) {
  const out = [];
  const chip = { x: -156, y: -62, w: 78, d: 58, r: 4 };
  out.push(mat("case", S(k.slabOf(chip, z, 13, P, 6, 1), { tone: "mid" })));
  out.push(D(k.dotGrid(chip.x + 12, chip.y + 10, 4, 4, 16, z + 13, P), { size: 0.8, tone: "lo" }));
  out.push(L(k.planOutline(chip, z + 13, P, 6), { tone: "faint" }));
  const lock = { x: -62, y: -70, w: 38, d: 32, r: 5 };
  out.push(mat("brass", S(k.slabOf(lock, z, 20, P, 8, 1.2), { tone: "hi", lit: true })));
  out.push(mat("case", L(k.ring(lock.x + 19, lock.y + 16, 10, z + 20, P, 24), { tone: "mid" })));
  out.push(mat("case", S(k.cylinder(lock.x + 19, lock.y + 16, 2.6, z + 20, 6, P, 12), { tone: "mid" })));
  for (let i = 0; i < 3; i++) {
    out.push(mat("case", S(k.cylinder(-4, -58, 23, z + i * 7, 6, P, 28, 0.7), { tone: i === 2 ? "hi" : "mid", lit: i === 2 })));
    out.push(mat("brass", L(k.ring(-4, -58, 23, z + i * 7 + 6, P, 28), { tone: "lo" })));
  }
  for (const dx of [0, 36]) {
    const drawer = { x: 40 + dx, y: -74, w: 30, d: 44, r: 3 };
    out.push(mat("case", S(k.slabOf(drawer, z, 16, P, 6, 0.9), { tone: "mid" })));
    out.push(L(k.planOutline(drawer, z + 16, P, 6), { tone: "faint" }));
    out.push(mat("brass", S(k.slabOf({ x: drawer.x + 9, y: drawer.y + 36, w: 12, d: 3, r: 1.5 }, z + 9, 3, P, 4, 0.3), { tone: "hi" })));
  }
  const queue = { x: 116, y: -56, w: 66, d: 108, r: 4 };
  out.push(mat("case", S(k.slabOf(queue, z, 11, P, 6, 0.9), { tone: "mid" })));
  out.push(L(k.planOutline(queue, z + 11, P, 6), { tone: "faint" }));
  for (let i = 0; i < 3; i++) {
    const slot = { x: queue.x + 8, y: queue.y + 8 + i * 32, w: queue.w - 16, d: 24, r: 2.5 };
    out.push(S(k.slabOf(slot, z + 11, 1.6, P, 4), { tone: "lo", crease: "none", flat: true }));
    out.push(L(k.planOutline(slot, z + 12.6, P, 4), { tone: "lo" }));
    if (i === 0) out.push(accent(S(k.slabOf({ x: slot.x + 5, y: slot.y + 5, w: slot.w - 10, d: slot.d - 10, r: 2 }, z + 12.6, 6, P, 4, 0.5), { tone: "hi", lit: true })));
  }
  return out.join("");
}

// ---------- L3 handset ----------
function handset(z) {
  const out = [];
  const body = { x: -26, y: -26, w: 62, d: 16, r: 6 };
  out.push(mat("case", S(k.slabOf(body, z, 84, P, 8, 1.4), { tone: "mid" })));
  out.push(L(k.planOutline(body, z + 84, P, 8), { tone: "faint" }));
  const screen = { x: -20, y: -27, w: 50, d: 1, r: 1.6 };
  out.push(S(k.slabOf(screen, z + 12, 62, P, 4, 0), { tone: "lo", crease: "none", flat: true }));
  for (let i = 0; i < 3; i++) {
    out.push(L(k.lineOnTop([-15, -27], [-15 + 34 - i * 9, -27], z + 66 - i * 18, P), { tone: "faint" }));
  }
  out.push(L(k.lineOnTop([-6, -27], [6, -27], z + 16, P), { tone: "lo" }));
  out.push(mat("brass", S(k.slabOf({ x: 34, y: -16, w: 10, d: 20, r: 2 }, z + 24, 4, P, 4, 0.5), { tone: "hi" })));
  const vault = { x: -64, y: -14, w: 26, d: 30, r: 4 };
  out.push(accent(S(k.slabOf(vault, z, 20, P, 6, 1), { tone: "hi", lit: true })));
  out.push(accent(L(k.planOutline(vault, z + 20, P, 6), { tone: "hi" })));
  out.push(accent(D([at([vault.x + 13, vault.y + 15, z + 20])], { size: 1.7, tone: "hi" })));
  for (let i = 0; i < 3; i++) {
    out.push(L(k.onTop([[40, 34], [54 + i * 9, 30 - i * 9]], z + 30 + i * 14, P), { tone: "faint" }));
  }
  return out.join("");
}

// ---------- L4 carrier ----------
function carrier(z) {
  const out = [];
  const mx = -44;
  const my = -22;
  for (let i = 0; i < 3; i++) {
    const w = 22 - i * 5;
    out.push(mat("case", S(k.slabOf({ x: mx - w / 2, y: my - w / 2, w, d: w, r: 2 }, z + i * 26, 26, P, 4, 0.6), { tone: "mid" })));
    out.push(L(k.planOutline({ x: mx - w / 2, y: my - w / 2, w, d: w, r: 2 }, z + i * 26 + 26, P, 4), { tone: "faint" }));
  }
  for (const [dz, half] of [[20, 34], [46, 26], [72, 18]]) {
    out.push(L(k.lineOnTop([mx - half, my], [mx + half, my], z + dz, P), { tone: "lo" }));
  }
  out.push(mat("brass", S(k.cylinder(mx, my, 3.4, z + 78, 14, P, 12), { tone: "hi", lit: true })));
  out.push(accent(S(k.cylinder(mx, my, 3.4, z + 92, 4.5, P, 12), { tone: "hi", lit: true })));
  for (let i = 0; i < 3; i++) {
    out.push(L(k.onTop([[mx + 12, my], [mx + 34 + i * 10, my - 6 - i * 8]], z + 70 - i * 10, P), { tone: "faint" }));
  }
  const peer = { x: 82, y: -8, w: 18, d: 54, r: 3 };
  out.push(S(k.slabOf(peer, z, 10, P, 6, 0.9), { tone: "hi" }));
  out.push(L(k.planOutline(peer, z + 10, P, 6), { tone: "faint" }));
  out.push(S(k.slabOf({ x: peer.x + 3, y: peer.y + 5, w: 12, d: 38, r: 1 }, z + 10, 0.5, P, 3, 0), { tone: "lo", crease: "none", flat: true }));
  return out.join("");
}

const body = [
  plate(Z[0]), carrier(Z[0] + 4),
  plate(Z[1]), handset(Z[1] + 4),
  plate(Z[2]), edge(Z[2] + 4),
  plate(Z[3]), operator(Z[3] + 4),
].join("");

const svg = a.assetSvg({
  width: W,
  height: H,
  label:
    "The DakFlare stack in four exploded layers: the operator's browser and terminal on top, the Cloudflare edge below it with a Worker chip, an auth lock, D1 disks, KV drawers and a command queue, then the handset with its SIM tray and keystore chip, and the carrier mast with a peer phone at the bottom. One coral wire marks the signed hop between the edge and the handset.",
  body,
  paper: PAPER,
  accents: ACCENTS,
  weight: 0.8,
  id: "dakflare-stack",
});

writeFileSync(join(HERE, "stack.svg"), svg);
console.log(`stack.svg ${(svg.length / 1024).toFixed(0)} KB`);
