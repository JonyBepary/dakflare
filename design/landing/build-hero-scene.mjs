// The hero artifact, after the reference: five parties as floating islands on the cream
// field — operator, a glass edge cube, the handset, the carrier mast, the peer — joined by
// dashed coral arrows. Scene tier: the person, the cube and the mast are the expensive parts.
//
//   ANATOMY_ASSET_KIT=~/.agents/skills/anatomy-asset/kit node design/landing/build-hero-scene.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = process.env.ANATOMY_ASSET_KIT ?? "/home/jony/.agents/skills/anatomy-asset/kit";
const k = await import(join(KIT, "iso-kit.mjs"));
const a = await import(join(KIT, "asset.mjs"));

const HERE = dirname(fileURLToPath(import.meta.url));
const PAPER = "#fbf6ee";
const CORAL = "#d9502c";
const CASE_INK = "#3a3129";
const BRASS = "#a8804a";
const GLASS = "#cfe0e6";
const ACCENTS = { brand: CORAL, case: CASE_INK, brass: BRASS, ink: "#241f1a", glass: GLASS, skin: "#c9a887" };

const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (pts, style) => k.dotsSvg(pts, style);
const accent = (svg) => `<g class="ac-brand">${svg}</g>`;
const mat = (name, svg) => `<g class="ac-${name}">${svg}</g>`;

const W = 900;
const H = 560;
const REGION = { x: 18, y: 22, w: 864, h: 516 };

// ---------- the five islands ----------
const ISLANDS = [
  { id: "operator", at: [-360, 70], label: ["Operator", "Web · CLI"] },
  { id: "edge", at: [-150, -60], label: ["Cloudflare edge", "Worker · D1 · KV · DO"] },
  { id: "handset", at: [40, 90], label: ["Handset", "the radio"] },
  { id: "carrier", at: [250, -70], label: ["Cellular network", "GSM / LTE"] },
  { id: "peer", at: [450, 70], label: ["Peer mobile", "recipient"] },
];
const PAD = { w: 118, d: 76, r: 10, h: 7 };

const pts = [];
for (const isl of ISLANDS) {
  pts.push(...k.boxCorners({ x: isl.at[0] - PAD.w / 2, y: isl.at[1] - PAD.d / 2, w: PAD.w, d: PAD.d, r: PAD.r }, -PAD.h, 210));
}
const P = a.fitInto(pts, REGION, { pad: 12, azimuth: 58 });
const at = (p) => k.iso(p, P);

// ---------- an island ----------
function island([x, y]) {
  const plan = { x: x - PAD.w / 2, y: y - PAD.d / 2, w: PAD.w, d: PAD.d, r: PAD.r };
  const out = [`<path class="iso-halo" d="${k.haloOf(k.insetPlan(plan, -3), -PAD.h - 6, 7, P)}"/>`];
  out.push(S(k.slabOf(plan, -PAD.h, PAD.h, P, 10, 1.6), { tone: "hi", crease: "none" }));
  out.push(L(k.planOutline(plan, 0, P, 10), { tone: "faint" }));
  return out.join("");
}

// ---------- operator: a person with a phone ----------
function operator([x, y]) {
  const out = [];
  const H_ = 148;
  // legs, slightly apart, with shoes
  for (const [dx, w] of [[-11, 12], [2, 12]]) {
    out.push(mat("case", S(k.slabOf({ x: x + dx, y: y - 8, w, d: 14, r: 4 }, 6, H_ * 0.44, P, 4, 0.8), { tone: "mid" })));
    out.push(mat("ink", S(k.slabOf({ x: x + dx - 2, y: y - 11, w: w + 4, d: 20, r: 4 }, 0, 7, P, 4, 0.6), { tone: "mid" })));
  }
  // torso and hood
  out.push(mat("case", S(k.slabOf({ x: x - 17, y: y - 12, w: 34, d: 22, r: 9 }, H_ * 0.44, H_ * 0.38, P, 6, 1.4), { tone: "mid" })));
  out.push(mat("case", S(k.slabOf({ x: x - 19, y: y - 13, w: 38, d: 24, r: 11 }, H_ * 0.78, 12, P, 6, 1.4), { tone: "hi" })));
  // arms: one down, one raised holding the phone
  out.push(mat("case", S(k.slabOf({ x: x - 24, y: y - 9, w: 8, d: 16, r: 4 }, H_ * 0.46, H_ * 0.30, P, 4, 0.7), { tone: "mid" })));
  out.push(mat("case", S(k.slabOf({ x: x + 16, y: y - 9, w: 8, d: 16, r: 4 }, H_ * 0.50, H_ * 0.26, P, 4, 0.7), { tone: "mid" })));
  // head
  out.push(mat("skin", S(k.cylinder(x, y - 2, 4.4, H_ * 0.90, 5, P, 14), { tone: "mid" })));
  out.push(mat("skin", S(k.cylinder(x, y - 2, 8.4, H_ * 0.94, 13, P, 20, 1.4), { tone: "hi", lit: true })));
  out.push(mat("ink", S(k.cylinder(x, y - 2, 8.6, H_ * 1.04, 4, P, 20, 1), { tone: "mid" })));
  // the phone, held up in the raised hand
  const px = x + 26;
  const py = y - 12;
  const pz = H_ * 0.66;
  out.push(S(k.slabOf({ x: px, y: py, w: 6, d: 16, r: 2 }, pz, 26, P, 4, 0.5), { tone: "hi", lit: true }));
  out.push(accent(S(k.slabOf({ x: px + 1.6, y: py - 0.6, w: 2.8, d: 12, r: 1 }, pz + 4, 18, P, 3, 0), { tone: "hi", crease: "none", flat: true })));
  return out.join("");
}

// ---------- edge: a glass cube around a rack of slabs ----------
function edge([x, y]) {
  const out = [];
  const box = { x: x - 62, y: y - 40, w: 124, d: 80 };
  const z0 = 0;
  const z1 = 148;
  const c = (dx, dy, dz) => at([box.x + dx * box.w, box.y + dy * box.d, dz]);
  const corner = { a: c(0, 0, 0), b: c(1, 0, 0), c: c(1, 1, 0), d: c(0, 1, 0) };
  const top = { a: c(0, 0, z1), b: c(1, 0, z1), c: c(1, 1, z1), d: c(0, 1, z1) };
  const poly = (pts, fill, op, stroke) =>
    `<path d="${pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("")}Z" fill="${fill}" fill-opacity="${op}" stroke="${stroke}" stroke-width="1.2"/>`;

  // the rack inside: four slabs with coral LEDs
  for (let i = 0; i < 4; i++) {
    const plan = { x: box.x + 16, y: box.y + 16, w: box.w - 32, d: box.d - 32, r: 4 };
    const z = 12 + i * 30;
    out.push(S(k.slabOf(plan, z, 22, P, 6, 1.2), { tone: i === 3 ? "hi" : "mid", lit: i === 3 }));
    out.push(L(k.planOutline(plan, z + 22, P, 6), { tone: "faint" }));
    out.push(accent(D([at([plan.x + 10, plan.y + plan.d - 6, z + 22])], { size: 1.1, tone: "hi" })));
  }

  // glass: back faces first, then the front two and the lid, faint
  out.push(poly([corner.a, corner.b, top.b, top.a], "#b9d2da", 0.20, "none"));
  out.push(poly([corner.b, corner.c, top.c, top.b], "#b9d2da", 0.20, "none"));
  out.push(poly([corner.a, corner.d, top.d, top.a], "#b9d2da", 0.20, "none"));
  out.push(poly([corner.d, corner.c, top.c, top.d], "#b9d2da", 0.20, "none"));
  out.push(poly([top.a, top.b, top.c, top.d], "#b9d2da", 0.30, "none"));
  // edges
  const edges = [
    [top.a, top.b], [top.b, top.c], [top.c, top.d], [top.d, top.a],
    [corner.a, top.a], [corner.b, top.b], [corner.c, top.c], [corner.d, top.d],
  ];
  for (const [p0, p1] of edges) {
    out.push(L(`M${p0[0].toFixed(1)} ${p0[1].toFixed(1)}L${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`, { tone: "lo", free: true }));
  }
  // the cloud mark on the lid
  const cx = (top.a[0] + top.c[0]) / 2;
  const cy = (top.a[1] + top.c[1]) / 2;
  out.push(accent(`<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)})"><path d="M-13 3a6 6 0 0 1 1.5-11.8A9 9 0 0 1 5-12a7 7 0 0 1 8 7 5 5 0 0 1-1 10z" fill="var(--anatomy-face)" stroke="var(--anatomy-hi)" stroke-width="1"/></g>`));
  return out.join("");
}

// ---------- handset ----------
function handset([x, y]) {
  const out = [];
  const dock = { x: x - 30, y: y - 16, w: 60, d: 32, r: 8 };
  out.push(mat("case", S(k.slabOf(dock, 0, 6, P, 8, 1), { tone: "mid" })));
  out.push(L(k.planOutline(dock, 6, P, 8), { tone: "faint" }));
  const body = { x: x - 22, y: y - 9, w: 44, d: 16, r: 6 };
  out.push(S(k.slabOf(body, 6, 82, P, 8, 1.4), { tone: "hi", lit: true }));
  const screen = { x: x - 17, y: y - 10, w: 34, d: 1, r: 1.4 };
  out.push(S(k.slabOf(screen, 18, 60, P, 4, 0), { tone: "lo", crease: "none", flat: true }));
  // a green android-ish mark on the screen
  out.push(`<g transform="translate(${at([x, y - 10, 48])[0].toFixed(1)} ${at([x, y - 10, 48])[1].toFixed(1)})" opacity=".9"><circle r="6.5" fill="#7bc47f"/><rect x="-7" y="-2.5" width="14" height="4" rx="2" fill="#7bc47f"/><circle cx="-3" cy="-4.5" r="1.1" fill="#fffdf8"/><circle cx="3" cy="-4.5" r="1.1" fill="#fffdf8"/></g>`);
  // the keystore shield, standing beside the phone
  const sx = x + 26;
  const sy = y + 6;
  out.push(accent(S(k.slabOf({ x: sx, y: sy, w: 18, d: 10, r: 4 }, 6, 22, P, 6, 1), { tone: "hi", lit: true })));
  out.push(accent(`<g transform="translate(${at([sx + 9, sy + 5, 32])[0].toFixed(1)} ${at([sx + 9, sy + 5, 32])[1].toFixed(1)})"><path d="M0 -6l6 3v5c0 4-6 6-6 6s-6-2-6-6v-5z" fill="var(--anatomy-hi)" stroke="none"/></g>`));
  return out.join("");
}

// ---------- carrier mast ----------
function carrier([x, y]) {
  const out = [];
  const base = { x: x - 22, y: y - 18, w: 44, d: 36, r: 4 };
  out.push(mat("case", S(k.slabOf(base, 0, 8, P, 6, 1), { tone: "mid" })));
  for (let i = 0; i < 4; i++) {
    const w = 18 - i * 3.4;
    out.push(mat("case", S(k.slabOf({ x: x - w / 2, y: y - w / 2, w, d: w, r: 1.6 }, 8 + i * 34, 34, P, 4, 0.5), { tone: "mid" })));
    out.push(L(k.planOutline({ x: x - w / 2, y: y - w / 2, w, d: w, r: 1.6 }, 8 + i * 34 + 34, P, 4), { tone: "faint" }));
  }
  for (const [dz, half] of [[18, 26], [52, 21], [86, 16], [120, 12]]) {
    out.push(L(k.lineOnTop([x - half, y], [x + half, y], 8 + dz, P), { tone: "lo" }));
    out.push(L(k.lineOnTop([x, y - half * 0.6], [x, y + half * 0.6], 8 + dz, P), { tone: "faint" }));
  }
  out.push(mat("brass", S(k.cylinder(x, y, 3.2, 144, 16, P, 12), { tone: "hi", lit: true })));
  // signal arcs, drawn in screen space off the antenna tip
  const tip = at([x, y, 166]);
  const arcs = [11, 20, 29].map((r) => {
    const d = `M${(tip[0] + 5).toFixed(1)} ${(tip[1] + 2).toFixed(1)}A${r} ${r} 0 0 1 ${(tip[0] + 5 + r * 0.78).toFixed(1)} ${(tip[1] + 2 - r * 0.78).toFixed(1)}`;
    return `<path d="${d}" fill="none" stroke="var(--anatomy-mid)" stroke-width="2" stroke-linecap="round" opacity="${(0.95 - r * 0.02).toFixed(2)}"/>`;
  }).join("");
  out.push(accent(arcs));
  return out.join("");
}

// ---------- peer ----------
function peer([x, y]) {
  const out = [];
  const dock = { x: x - 26, y: y - 14, w: 52, d: 28, r: 7 };
  out.push(mat("case", S(k.slabOf(dock, 0, 5, P, 8, 1), { tone: "mid" })));
  const body = { x: x - 18, y: y - 8, w: 36, d: 14, r: 5 };
  out.push(mat("case", S(k.slabOf(body, 5, 66, P, 8, 1.2), { tone: "mid" })));
  const screen = { x: x - 14, y: y - 9, w: 28, d: 1, r: 1.2 };
  out.push(S(k.slabOf(screen, 14, 48, P, 4, 0), { tone: "lo", crease: "none", flat: true }));
  out.push(accent(`<g transform="translate(${at([x, y - 9, 38])[0].toFixed(1)} ${at([x, y - 9, 38])[1].toFixed(1)})"><rect x="-8" y="-6" width="16" height="12" rx="2" fill="var(--anatomy-face)" stroke="none"/><path d=\"M-5 -2h10M-5 2h7\" stroke=\"#fffdf8\" stroke-width=\"1.4\"/></g>`));
  return out.join("");
}

// ---------- the arrows ----------
function arrow(from, to, { lift = 0 } = {}) {
  const p0 = at([from[0], from[1], lift]);
  const p1 = at([to[0], to[1], lift]);
  const mx = (p0[0] + p1[0]) / 2;
  const my = (p0[1] + p1[1]) / 2;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const s = [p0[0] + ux * 14, p0[1] + uy * 14];
  const e = [p1[0] - ux * 16, p1[1] - uy * 16];
  const cx = mx - uy * 10;
  const cy = my + ux * 10;
  const head = 7;
  const left = [e[0] - ux * head - uy * head * 0.6, e[1] - uy * head + ux * head * 0.6];
  const right = [e[0] - ux * head + uy * head * 0.6, e[1] - uy * head - ux * head * 0.6];
  const f = (p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
  return accent(
    `<path d="M${f(s)}Q${f([cx, cy])} ${f(e)}" fill="none" stroke="var(--anatomy-mid)" stroke-width="2" stroke-dasharray="6 6"/>` +
      `<path d="M${f(e)}L${f(left)}L${f(right)}Z" fill="var(--anatomy-mid)"/>`,
  );
}

// ---------- labels ----------
function labels() {
  return ISLANDS.map((isl) => {
    const p = at([isl.at[0], isl.at[1] + PAD.d / 2 + 52, -PAD.h]);
    return (
      `<text x="${p[0].toFixed(1)}" y="${p[1].toFixed(1)}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="17" letter-spacing=".03em" fill="#241f1a">${isl.label[0]}</text>` +
      `<text x="${p[0].toFixed(1)}" y="${(p[1] + 18).toFixed(1)}" text-anchor="middle" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" letter-spacing=".05em" fill="#6b6153">${isl.label[1]}</text>`
    );
  }).join("");
}

// ---------- assemble ----------
const byId = Object.fromEntries(ISLANDS.map((i) => [i.id, i.at]));
const art = [
  island(byId.operator), operator(byId.operator),
  island(byId.edge), edge(byId.edge),
  island(byId.handset), handset(byId.handset),
  island(byId.carrier), carrier(byId.carrier),
  island(byId.peer), peer(byId.peer),
  arrow([byId.operator[0] + 60, byId.operator[1] - 30], [byId.edge[0] - 70, byId.edge[1] + 30]),
  arrow([byId.edge[0] + 70, byId.edge[1] + 26], [byId.handset[0] - 40, byId.handset[1] - 26]),
  arrow([byId.handset[0] + 44, byId.handset[1] - 24], [byId.carrier[0] - 34, byId.carrier[1] + 30]),
  arrow([byId.carrier[0] + 34, byId.carrier[1] + 26], [byId.peer[0] - 34, byId.peer[1] - 20]),
  labels(),
].join("");

const svg = a.assetSvg({
  width: W,
  height: H,
  label:
    "Five floating islands on a cream field: an operator holding a phone, a glass cube of Cloudflare servers marked with a cloud, an Android handset with a keystore shield, a cellular mast with signal arcs, and a peer phone — joined by dashed coral arrows.",
  body: art,
  paper: PAPER,
  accents: ACCENTS,
  weight: 0.85,
  id: "dakflare-hero-scene",
});

writeFileSync(join(HERE, "hero-scene.svg"), svg);
console.log(`hero-scene.svg ${(svg.length / 1024).toFixed(0)} KB`);
