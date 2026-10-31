// The four layers of the architecture, drawn shapes-only. Each is its own close-up so the
// scroll can hand the stage to one at a time; the coral part in each is the one the copy
// beside it is about, and a coral leader points at it.
//
//   ANATOMY_ASSET_KIT=~/.agents/skills/anatomy-asset/kit node design/landing/build-layers.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = process.env.ANATOMY_ASSET_KIT ?? "/home/jony/.agents/skills/anatomy-asset/kit";
const k = await import(join(KIT, "iso-kit.mjs"));
const a = await import(join(KIT, "asset.mjs"));

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = "#fffdf8"; // the layer cards' field
const CORAL = "#d9502c";
const CASE_INK = "#3a3129";
const BRASS = "#a8804a";
const ACCENTS = { brand: CORAL, case: CASE_INK, brass: BRASS, ink: "#241f1a", ground: "#f6efe3" };

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (pts, style) => k.dotsSvg(pts, style);
const accent = (svg) => `<g class="ac-brand">${svg}</g>`;
const mat = (name, svg) => `<g class="ac-${name}">${svg}</g>`;

const W = 720;
const H = 340;

function make({ id, label, art, points }) {
  const P = a.fitInto(points, { x: 36, y: 24, w: 648, h: 292 }, { pad: 12, azimuth: 58 });
  const at = (p) => k.iso(p, P);
  return a.assetSvg({
    width: W,
    height: H,
    label,
    body: art({ P, at }),
    paper: PAPER,
    accents: ACCENTS,
    weight: 0.8,
    id,
  });
}

// a thin stage every layer sits on
function stage(P, plan) {
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(plan, -6), -4, 6, P)}"/>`];
  out.push(mat("ground", S(k.slabOf(plan, -4, 4, P, 12, 1.4), { tone: "lo", crease: "none" })));
  out.push(mat("ground", L(k.planOutline(k.insetPlan(plan, 5), 0, P, 12), { tone: "faint" })));
  return out;
}

// a coral leader with a dot at the end, pointing at the accent part
function leader(from, to, P) {
  return (
    accent(L(k.onTop([from, to], 0, P), { tone: "hi" })) +
    accent(D([k.iso([to[0], to[1], 0], P)], { size: 1.6, tone: "hi" }))
  );
}

// ---------- 01 operator ----------
const operator = make({
  id: "layer-operator",
  label: "The operator layer: a browser window and a terminal on a plate, with a coral passkey chip in front of them.",
  points: k.boxCorners({ x: -196, y: -104, w: 392, d: 208, r: 10 }, -4, 70),
  art: ({ P, at }) => {
    const out = stage(P, { x: -196, y: -104, w: 392, d: 208, r: 10 });
    // browser: a slab with a chrome bar and three content rules
    const win = { x: -170, y: -84, w: 190, d: 120, r: 6 };
    out.push(S(k.slabOf(win, 0, 34, P, 8, 1.2), { tone: "hi", lit: true }));
    out.push(L(k.planOutline(win, 34, P, 8), { tone: "faint" }));
    out.push(L(k.lineOnTop([win.x, win.y + 18], [win.x + win.w, win.y + 18], 34, P), { tone: "lo" }));
    out.push(D([[win.x + 9, win.y + 9], [win.x + 17, win.y + 9], [win.x + 25, win.y + 9]].map(([x, y]) => at([x, y, 34])), { size: 1.1, tone: "lo" }));
    for (let i = 0; i < 3; i++) {
      out.push(L(k.lineOnTop([win.x + 14, win.y + 34 + i * 16], [win.x + win.w - 24 - i * 26, win.y + 34 + i * 16], 34, P), { tone: "faint" }));
    }
    // terminal: a dark slab with a prompt and two rules
    const term = { x: 40, y: -70, w: 130, d: 96, r: 6 };
    out.push(mat("case", S(k.slabOf(term, 0, 26, P, 8, 1.2), { tone: "mid" })));
    out.push(L(k.planOutline(term, 26, P, 8), { tone: "faint" }));
    out.push(L(k.lineOnTop([term.x + 12, term.y + 22], [term.x + 30, term.y + 22], 26, P), { tone: "lo" }));
    out.push(L(k.lineOnTop([term.x + 38, term.y + 22], [term.x + 96, term.y + 22], 26, P), { tone: "faint" }));
    out.push(L(k.lineOnTop([term.x + 12, term.y + 40], [term.x + 78, term.y + 40], 26, P), { tone: "faint" }));
    // the passkey: a coral chip with a ring, in front of both
    const chip = { x: -50, y: 62, w: 54, d: 34, r: 8 };
    out.push(accent(S(k.slabOf(chip, 0, 12, P, 8, 1.4), { tone: "hi", lit: true })));
    out.push(accent(L(k.planOutline(chip, 12, P, 8), { tone: "hi" })));
    out.push(accent(L(k.ring(chip.x + 27, chip.y + 17, 9, 12, P, 24), { tone: "hi" })));
    out.push(accent(D([at([chip.x + 27, chip.y + 17, 12])], { size: 1.4, tone: "hi" })));
    // a leader from the chip out to the right edge
    out.push(leader([chip.x + 54, chip.y + 17], [190, 60], P));
    return out.join("");
  },
});

// ---------- 02 edge ----------
const edge = make({
  id: "layer-edge",
  label: "The edge layer: a Worker chip, a lock for the auth guard, stacked D1 disks, KV drawers and a command queue, with a coral command waiting in the queue.",
  points: k.boxCorners({ x: -236, y: -110, w: 472, d: 220, r: 10 }, -4, 120),
  art: ({ P, at }) => {
    const out = stage(P, { x: -236, y: -110, w: 472, d: 220, r: 10 });
    // Worker: a chip with a pin grid
    const chip = { x: -224, y: -84, w: 96, d: 70, r: 5 };
    out.push(mat("case", S(k.slabOf(chip, 0, 16, P, 6, 1.2), { tone: "mid" })));
    out.push(D(k.dotGrid(chip.x + 14, chip.y + 12, 5, 4, 17, 16, P), { size: 0.9, tone: "lo" }));
    out.push(L(k.planOutline(chip, 16, P, 6), { tone: "faint" }));
    // AuthGuard: a lock — a body and a shackle
    const lock = { x: -104, y: -96, w: 46, d: 38, r: 6 };
    out.push(mat("brass", S(k.slabOf(lock, 0, 26, P, 8, 1.4), { tone: "hi", lit: true })));
    out.push(mat("case", L(k.ring(lock.x + 23, lock.y + 19, 13, 26, P, 26), { tone: "mid" })));
    out.push(mat("case", S(k.cylinder(lock.x + 23, lock.y + 19, 3, 26, 8, P, 14), { tone: "mid" })));
    // D1: three stacked disks
    for (let i = 0; i < 3; i++) {
      out.push(mat("case", S(k.cylinder(-22, -74, 30, i * 9, 8, P, 30, 0.8), { tone: i === 2 ? "hi" : "mid", lit: i === 2 })));
      out.push(mat("brass", L(k.ring(-22, -74, 30, i * 9 + 8, P, 30), { tone: "lo" })));
    }
    // KV: two drawers
    for (const dx of [0, 44]) {
      const drawer = { x: 40 + dx, y: -92, w: 38, d: 54, r: 4 };
      out.push(mat("case", S(k.slabOf(drawer, 0, 20, P, 6, 1), { tone: "mid" })));
      out.push(L(k.planOutline(drawer, 20, P, 6), { tone: "faint" }));
      out.push(mat("brass", S(k.slabOf({ x: drawer.x + 12, y: drawer.y + 46, w: 14, d: 4, r: 2 }, 12, 4, P, 4, 0.4), { tone: "hi" })));
    }
    // DeviceGateway: a queue of three slots, one command waiting in coral
    const queue = { x: 150, y: -70, w: 84, d: 130, r: 5 };
    out.push(mat("case", S(k.slabOf(queue, 0, 14, P, 6, 1), { tone: "mid" })));
    out.push(L(k.planOutline(queue, 14, P, 6), { tone: "faint" }));
    for (let i = 0; i < 3; i++) {
      const slot = { x: queue.x + 10, y: queue.y + 10 + i * 38, w: queue.w - 20, d: 28, r: 3 };
      out.push(S(k.slabOf(slot, 14, 2, P, 4), { tone: "lo", crease: "none", flat: true }));
      out.push(L(k.planOutline(slot, 16, P, 4), { tone: "lo" }));
      if (i === 0) {
        out.push(accent(S(k.slabOf({ x: slot.x + 6, y: slot.y + 6, w: slot.w - 12, d: slot.d - 12, r: 2 }, 16, 7, P, 4, 0.6), { tone: "hi", lit: true })));
      }
    }
    out.push(leader([queue.x + queue.w / 2, queue.y + 24], [244, 40], P));
    return out.join("");
  },
});

// ---------- 03 handset ----------
const handset = make({
  id: "layer-handset",
  label: "The handset layer: a phone standing on a plate with a SIM tray and radio arcs, and a coral keystore chip behind the screen.",
  points: k.boxCorners({ x: -132, y: -92, w: 264, d: 184, r: 10 }, -4, 150),
  art: ({ P, at }) => {
    const out = stage(P, { x: -132, y: -92, w: 264, d: 184, r: 10 });
    // the phone: a tall slab with a screen and a home bar
    const body = { x: -44, y: -34, w: 88, d: 20, r: 8 };
    out.push(mat("case", S(k.slabOf(body, 0, 118, P, 8, 1.6), { tone: "mid" })));
    out.push(L(k.planOutline(body, 118, P, 8), { tone: "faint" }));
    const screen = { x: -36, y: -35.2, w: 72, d: 1.2, r: 2 };
    out.push(S(k.slabOf(screen, 16, 88, P, 4, 0), { tone: "lo", crease: "none", flat: true }));
    for (let i = 0; i < 3; i++) {
      out.push(L(k.lineOnTop([-28, -35.2], [-28 + 50 - i * 12, -35.2], 96 - i * 26, P), { tone: "faint" }));
    }
    out.push(L(k.lineOnTop([-10, -35.2], [10, -35.2], 20, P), { tone: "lo" }));
    // SIM tray at the phone's edge
    out.push(mat("brass", S(k.slabOf({ x: 44, y: -20, w: 14, d: 26, r: 2 }, 34, 5, P, 4, 0.6), { tone: "hi" })));
    // the keystore: a coral chip behind the screen with a keyhole
    const vault = { x: -84, y: -20, w: 34, d: 40, r: 5 };
    out.push(accent(S(k.slabOf(vault, 0, 26, P, 6, 1.2), { tone: "hi", lit: true })));
    out.push(accent(L(k.planOutline(vault, 26, P, 6), { tone: "hi" })));
    out.push(accent(D([at([vault.x + 17, vault.y + 20, 26])], { size: 2, tone: "hi" })));
    // radio arcs to the right
    for (let i = 0; i < 3; i++) {
      out.push(L(k.onTop([[54, 40], [72 + i * 10, 40 - i * 12]], 40 + i * 20, P), { tone: "faint" }));
    }
    out.push(leader([vault.x + 17, vault.y + 40], [-150, 40], P));
    return out.join("");
  },
});

// ---------- 04 carrier ----------
const carrier = make({
  id: "layer-carrier",
  label: "The carrier layer: a lattice mast with an antenna, a peer handset on a plate, and radio arcs between them.",
  points: k.boxCorners({ x: -190, y: -104, w: 380, d: 208, r: 10 }, -4, 170),
  art: ({ P, at }) => {
    const out = stage(P, { x: -190, y: -104, w: 380, d: 208, r: 10 });
    // the mast: a tapered stack of three segments with cross bars
    const mx = -60;
    const my = -30;
    for (let i = 0; i < 3; i++) {
      const w = 26 - i * 6;
      out.push(mat("case", S(k.slabOf({ x: mx - w / 2, y: my - w / 2, w, d: w, r: 2 }, i * 46, 46, P, 4, 0.6), { tone: "mid" })));
      out.push(L(k.planOutline({ x: mx - w / 2, y: my - w / 2, w, d: w, r: 2 }, i * 46 + 46, P, 4), { tone: "faint" }));
    }
    // cross bars
    for (const [z, half] of [[34, 40], [80, 30], [126, 20]]) {
      out.push(L(k.lineOnTop([mx - half, my], [mx + half, my], z, P), { tone: "lo" }));
    }
    // antenna tip
    out.push(mat("brass", S(k.cylinder(mx, my, 4, 138, 20, P, 12), { tone: "hi", lit: true })));
    // radio arcs
    for (let i = 0; i < 3; i++) {
      out.push(L(k.onTop([[mx + 16, my], [mx + 40 + i * 12, my - 8 - i * 10]], 120 - i * 14, P), { tone: "faint" }));
    }
    // the peer handset, lying on the plate
    const peer = { x: 96, y: -10, w: 22, d: 64, r: 4 };
    out.push(S(k.slabOf(peer, 0, 12, P, 6, 1), { tone: "hi" }));
    out.push(L(k.planOutline(peer, 12, P, 6), { tone: "faint" }));
    out.push(S(k.slabOf({ x: peer.x + 4, y: peer.y + 6, w: 14, d: 46, r: 1 }, 12, 0.6, P, 3, 0), { tone: "lo", crease: "none", flat: true }));
    out.push(accent(S(k.cylinder(mx, my, 4, 158, 5, P, 12), { tone: "hi", lit: true })));
    out.push(leader([mx, my + 18], [-190, 60], P));
    return out.join("");
  },
});

writeFileSync(join(HERE, "layer-1.svg"), operator);
writeFileSync(join(HERE, "layer-2.svg"), edge);
writeFileSync(join(HERE, "layer-3.svg"), handset);
writeFileSync(join(HERE, "layer-4.svg"), carrier);
for (const [n, s] of [["1", operator], ["2", edge], ["3", handset], ["4", carrier]]) {
  console.log(`layer-${n}.svg ${(s.length / 1024).toFixed(0)} KB`);
}
