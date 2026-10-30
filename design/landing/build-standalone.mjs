// A standalone copy of the landing page: same file the Worker serves, with the three
// root-absolute links pointed at their real destinations so it works opened from disk.
//
//   node design/landing/build-standalone.mjs
//
// Writes design/landing/dakflare-landing.html. Nothing else changes: the page has no
// scripts, no webfonts, no images and no network requests, so the copy is the page.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "worker", "public", "index.html");
const OUT = join(HERE, "dakflare-landing.html");

const DEPLOY = "https://dakflare-worker.sohelahmedjony.workers.dev";
const REPO = "https://github.com/JonyBepary/dakflare";

let html = readFileSync(SRC, "utf8");

// A file opened from disk has no origin, so `/source` and `/admin/` would 404.
// `/` is this page, so it stays a local anchor.
html = html.replaceAll('href="/source"', `href="${REPO}"`);
html = html.replaceAll('href="/admin/"', `href="${DEPLOY}/admin/"`);
html = html.replaceAll('href="/"', 'href="#main"');

// Say on the page itself that it is a saved copy, so a reader is not surprised by the
// links leaving the file.
const note = `<div class="saved-note">Saved copy · the live page is at <a href="${DEPLOY}/">${DEPLOY.replace("https://", "")}</a></div>`;
html = html.replace("<body>", `<body>\n${note}`);

const css = `<style>
.saved-note{position:fixed;right:14px;bottom:14px;z-index:60;font-family:var(--mono);font-size:10px;
letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);background:var(--surface-card);
border:1px solid var(--line);border-radius:999px;padding:7px 12px;box-shadow:var(--shadow-2)}
.saved-note a{color:var(--accent)}
@media (max-width:640px){.saved-note{right:10px;bottom:10px;font-size:9px;padding:6px 10px}}
</style>`;
html = html.replace("</head>", `${css}\n</head>`);

writeFileSync(OUT, html);
console.log(`dakflare-landing.html ${(html.length / 1024).toFixed(0)} KB`);
