#!/usr/bin/env node
/**
 * Generate `public/md/**` from `content/docs/**`.
 *
 * `/docs/{slug}.md` is served by `app/api/md/[...slug]`, which reads a file from `public/md`. Until
 * now those files were hand-kept copies of the MDX: twenty-one pages, forty-two files, no
 * generator. The cost was not theoretical — four pages repeated the same wrong command count, and
 * an import was corrected in the MDX while its markdown twin kept the old one.
 *
 * The transform is the one those copies were made with, so the output is what an editor would have
 * written: frontmatter becomes an H1 and a blockquote, everything else is verbatim — including
 * code fences, which are never touched.
 *
 * Two markers decide what a machine reader sees, and they are the page author's choice:
 *
 *   {/* llms-ignore:start *\/} … {/* llms-ignore:end *\/}   dropped from the markdown
 *   {/* llms-only:start *\/} … {/* llms-only:end *\/}       kept, markers removed, and the page
 *                                                            becomes only that block
 *
 * Run before `dev` and `build`, so the copies cannot be stale. `--check` compares instead of
 * writing and exits 1 on any difference, for a caller that wants to prove it.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const contentDir = join(appDir, "content", "docs");
const outDir = join(appDir, "public", "md");

function mdxFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...mdxFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".mdx")) found.push(full);
  }
  return found;
}

/** Lines inside a fenced code block are never rewritten. */
function transform(source) {
  const lines = source.split("\n");

  // frontmatter
  let start = 0;
  let title = null;
  let description = null;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      const meta = lines.slice(1, end).join("\n");
      const t = meta.match(/^title:\s*(.+)$/m);
      const d = meta.match(/^description:\s*(.+)$/m);
      title = t ? t[1].trim() : null;
      description = d ? d[1].trim() : null;
      start = end + 1;
    }
  }

  const body = lines.slice(start).join("\n").replace(/^\n+/, "");

  // `llms-only` means "the page's own heading for a machine reader is the one inside this block",
  // so the frontmatter title is not repeated — the block and everything after it are kept.
  const hasMachineHeading = /\{\/\*\s*llms-only:start\s*\*\/\}/.test(body);

  const withoutIgnored = body
    .replace(/\{\/\*\s*llms-only:(start|end)\s*\*\/\}/g, "")
    .replace(
    /\{\/\*\s*llms-ignore:start\s*\*\/\}[\s\S]*?\{\/\*\s*llms-ignore:end\s*\*\/\}/g,
    "",
  );

  const kept = [];
  let inFence = false;
  for (const line of withoutIgnored.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence) {
      if (/^import\s/.test(line)) continue;
      if (/^\{\/\*[\s\S]*\*\/\}$/.test(line.trim())) continue;
    }
    kept.push(line);
  }

  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const head = hasMachineHeading
    ? ""
    : [title === null ? null : `# ${title}`, description === null ? null : `> ${description}`]
    .filter((part) => part !== null)
    .filter((part) => part !== null)
    .join("\n\n");
  return `${head === "" ? "" : `${head}\n\n`}${cleaned}\n`;
}

const check = process.argv.includes("--check");
const expected = new Map();

for (const file of mdxFiles(contentDir)) {
  // `agents/index.mdx` is served at `/docs/agents.md`, so an index page flattens onto its
  // directory name; only the root index keeps `index`.
  const slug = relative(contentDir, file)
    .replace(/\.mdx$/, "")
    .replace(/(^|\/)index$/, (match, lead) => (lead === "" ? "index" : ""));
  expected.set(join(outDir, `${slug}.md`), transform(readFileSync(file, "utf8")));
}

if (!check) {
  rmSync(outDir, { recursive: true, force: true });
}

const problems = [];
for (const [target, wanted] of expected) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === wanted) continue;
  if (check) {
    problems.push(relative(appDir, target));
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, wanted);
}

if (check) {
  if (problems.length === 0) {
    console.log(`markdown mirrors match their pages · ${expected.size} files`);
    process.exit(0);
  }
  console.error(
    `markdown mirrors are stale (${problems.length} of ${expected.size}):\n` +
      problems.map((line) => `  ${line}`).join("\n") +
      "\nRun `node scripts/sync-markdown.mjs`.",
  );
  process.exit(1);
}

console.log(`markdown mirrors generated · ${expected.size} files`);
