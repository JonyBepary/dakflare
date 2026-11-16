#!/usr/bin/env node
// theme-color-check.mjs: the browser's own chrome colour has to match the page.
//
// `src/app.html` carries two static `theme-color` metas, one per scheme, so the
// address bar and the status bar sit on the same cream (or night) the console
// paints instead of flashing white. Static HTML cannot read a custom property,
// so the two values are literals and nothing stops them drifting from the design
// tokens. This check is the thing that stops them: it resolves
// `--df-surface-page` the way the browser does and compares.
//
// Where the value comes from
//   design/tokens.css   the single token source: the light value, as a var() chain
//   src/app.css         the light/dark pair, because one value cannot hold two
//                       colours and tokens.css carries no dark block
//
// Usage
//   node scripts/theme-color-check.mjs [options]
//     --html <file>     the document, default `src/app.html` beside this script
//     --tokens <file>   the token source, default `../design/tokens.css`
//     --sheet <file>    the sheet holding the light/dark pair, default `src/app.css`
//     --quiet           print only a failure
//     --help            this text
//
// Exit 0 when both metas match their token, 1 when a meta has drifted or the pair
// cannot be resolved, 2 when a file cannot be read. No dependencies.

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const HELP = `theme-color-check.mjs: compare src/app.html's theme-color metas with the surface token

Usage: node scripts/theme-color-check.mjs [--html <file>] [--tokens <file>] [--sheet <file>] [--quiet]

  --html <file>     the document that holds the metas (default src/app.html)
  --tokens <file>   the token source (default ../design/tokens.css)
  --sheet <file>    the sheet with the light/dark pair (default src/app.css)
  --quiet           print nothing when the two agree
  --help            this text

Exit 0 when each meta equals --df-surface-page, 1 when one of them has drifted or
the pair cannot be resolved, 2 when a file cannot be read. A #fff and a #ffffff are
equal; case does not matter.`;

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f) => {
	const i = argv.indexOf(f);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

if (flag('--help') || flag('-h')) {
	console.log(HELP);
	process.exit(0);
}
const bad = ['--html', '--tokens', '--sheet'].filter((f) => argv.includes(f) && !val(f));
if (bad.length) {
	console.error(`theme-color-check: ${bad.join(', ')} needs a file after it`);
	process.exit(2);
}

const htmlPath = val('--html') ? resolve(val('--html')) : join(ROOT, 'src/app.html');
const tokenPath = val('--tokens') ? resolve(val('--tokens')) : join(ROOT, '../design/tokens.css');
const sheetPath = val('--sheet') ? resolve(val('--sheet')) : join(ROOT, 'src/app.css');
const quiet = flag('--quiet');
const TOKEN = '--df-surface-page';

/** A file's text, or exit 2 with the reason. A missing file is a setup error, not a finding. */
function read(file, what) {
	try {
		return readFileSync(file, 'utf8');
	} catch (error) {
		console.error(`theme-color-check: cannot read the ${what} at ${file}: ${error.message}`);
		process.exit(2);
	}
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;
// A path the reader can find: relative to where they ran the check, and absolute
// when it sits outside the tree (a --html copy in a temp folder, two levels up).
const shown = (file) => {
	const rel = relative(process.cwd(), file) || file;
	return rel.split(/[\\/]/).filter((part) => part === '..').length > 1 ? file : rel;
};

/**
 * Every `--name: value` declaration in a stylesheet, in source order, with the
 * file and line it came from. Comments are dropped first so a commented-out
 * declaration cannot win.
 */
function declarations(file) {
	const text = read(file, 'stylesheet').replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));
	const out = [];
	for (const match of text.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
		out.push({ name: match[1], value: match[2].trim(), file, line: lineAt(text, match.index) });
	}
	return out;
}

// Source order is cascade order here: tokens.css defines the light value and
// app.css redefines it with the pair, so the last declaration is the one the
// browser uses.
const decls = [...declarations(tokenPath), ...declarations(sheetPath)];
const byName = new Map();
for (const d of decls) byName.set(d.name, d);

/** Split `fn(...)` arguments at the top level, so a nested var() stays whole. */
function args(text) {
	const out = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === ',' && depth === 0) {
			out.push(text.slice(start, i));
			start = i + 1;
		}
	}
	out.push(text.slice(start));
	return out.map((x) => x.trim());
}

const LIGHT_DARK = /^light-dark\(([\s\S]*)\)$/;

/**
 * The value of a custom property as one scheme resolves it: var() chains walked,
 * a light-dark() pair narrowed to its side. Returns { value, from, at }, where
 * `at` names the declaration that finally held the colour.
 */
function resolveToken(name, scheme, depth = 0, from = null) {
	const d = byName.get(name);
	if (!d) return { value: null, from, missing: name };
	if (depth > 12) return { value: null, from: d, loop: true };
	from = d;
	const pair = LIGHT_DARK.exec(d.value);
	const value = pair ? args(pair[1])[scheme === 'dark' ? 1 : 0] : d.value;
	const ref = /var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)/.exec(value);
	if (!ref) return { value, from, at: { name, file: d.file, line: d.line } };
	const inner = resolveToken(ref[1], scheme, depth + 1, from);
	if (inner.value === null && ref[2]) return { value: ref[2].trim(), from };
	return inner;
}

/** `#abc`, `#aabbcc`, `#abcd`, `#aabbccdd` as lowercase six or eight digits. */
function hex(color) {
	const m = /^#([0-9a-f]{3,8})$/i.exec(String(color).trim());
	if (!m) return null;
	const digits = m[1].toLowerCase();
	if (digits.length === 3 || digits.length === 4) return `#${[...digits].map((c) => c + c).join('')}`;
	if (digits.length === 6 || digits.length === 8) return `#${digits}`;
	return null;
}

// The two metas, in the order and shape the document writes them. A meta with no
// media is the document's default and counts as light.
const html = read(htmlPath, 'document');
const metas = [];
for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
	const tag = match[0];
	const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag);
	if (!name || name[1].toLowerCase() !== 'theme-color') continue;
	const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
	const media = /\bmedia\s*=\s*["']([^"']*)["']/i.exec(tag);
	const scheme = !media ? 'light' : /prefers-color-scheme\s*:\s*dark/i.test(media[1]) ? 'dark' : /prefers-color-scheme\s*:\s*light/i.test(media[1]) ? 'light' : null;
	metas.push({ scheme, content: content ? content[1] : null, line: lineAt(html, match.index), tag });
}

const problems = [];
if (metas.length !== 2) problems.push(`${shown(htmlPath)} has ${metas.length} theme-color meta${metas.length === 1 ? '' : 's'}, expected two: one per prefers-color-scheme`);
for (const scheme of ['light', 'dark']) {
	const found = metas.filter((m) => m.scheme === scheme);
	if (metas.length === 2 && found.length !== 1) problems.push(`${shown(htmlPath)} has ${found.length} theme-color metas for the ${scheme} scheme, expected one`);
}

const token = resolveToken(TOKEN, 'light');
const dark = resolveToken(TOKEN, 'dark');
if (token.value === null || dark.value === null) {
	const miss = token.missing || dark.missing;
	problems.push(`${shown(tokenPath)} does not define ${miss ? miss : TOKEN}${token.loop || dark.loop ? ' (a var() chain loops)' : ''}`);
}

const expected = {
	light: { hex: hex(token.value), raw: token.value, from: token.from, at: token.at },
	dark: { hex: hex(dark.value), raw: dark.value, from: dark.from, at: dark.at }
};
for (const scheme of ['light', 'dark']) {
	if (expected[scheme].raw && !expected[scheme].hex)
		problems.push(`${TOKEN} resolves to ${expected[scheme].raw} for the ${scheme} scheme, which is not a hex colour this check can compare`);
}

if (problems.length) {
	console.error(`theme-color-check: ${problems.join('\n  ')}`);
	process.exit(1);
}

const mismatch = [];
for (const scheme of ['light', 'dark']) {
	const meta = metas.find((m) => m.scheme === scheme);
	const want = expected[scheme];
	const got = hex(meta.content);
	if (got === want.hex) continue;
	mismatch.push(
		`  ${shown(htmlPath)}:${meta.line}  content="${meta.content}"\n` +
			`  ${shown(want.from.file)}:${want.from.line}  ${TOKEN} (${scheme}) = ${want.raw}`
	);
}

if (mismatch.length) {
	console.error(
		`theme-color-check: the theme-color metas and ${TOKEN} disagree.\n${mismatch.join('\n')}\n` +
			'  Fix the meta, or the token, so the browser chrome matches the page it frames.'
	);
	process.exit(1);
}

if (!quiet) {
	const line = (scheme) => {
		const meta = metas.find((m) => m.scheme === scheme);
		const want = expected[scheme];
		return `  ${scheme.padEnd(5)} ${shown(htmlPath)}:${meta.line} ${want.hex}  =  ${want.at.name} at ${shown(want.at.file)}:${want.at.line}`;
	};
	console.log(`theme-color-check: both theme-color metas equal ${TOKEN}\n${line('light')}\n${line('dark')}`);
}
