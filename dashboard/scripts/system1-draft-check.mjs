#!/usr/bin/env node
/**
 * The System One origin: own or inherited.
 *
 * A double negation here once read an equal base as "own" and a differing base as
 * "inherited", and saving in that state cleared a stored origin. The rule is small
 * enough to state exactly, so it is stated once and asserted.
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith('./') || specifier.startsWith('../')) && path.extname(specifier) === '') {
			const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : HERE;
			for (const suffix of ['.ts', '/index.ts']) {
				const candidate = path.resolve(base, specifier + suffix);
				if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	}
});

const { system1BaseIsOwn } = await import('../src/lib/assistant.ts');

let passed = 0;
const failures = [];
function check(label, ok, detail = '') {
	if (ok) { passed += 1; console.log(`  ok  ${label}`); return; }
	failures.push(label);
	console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}

// The gateway's flag is authoritative when present.
check('flag false means inherited even when the URLs differ',
	system1BaseIsOwn({ inheritsBase: false, baseUrl: 'https://other.example/v1' }, 'https://chat.example/v1') === true);
check('flag true means inherited even when the URLs equal',
	system1BaseIsOwn({ inheritsBase: true, baseUrl: 'https://chat.example/v1' }, 'https://chat.example/v1') === false);

// An older Worker sends no flag: equal means inherited, differing means own.
check('no flag, equal URLs -> inherited',
	system1BaseIsOwn({ baseUrl: 'https://chat.example/v1' }, 'https://chat.example/v1') === false);
check('no flag, differing URLs -> own',
	system1BaseIsOwn({ baseUrl: 'https://sys.example/v1' }, 'https://chat.example/v1') === true);
check('no flag, null stored base -> inherited',
	system1BaseIsOwn({ baseUrl: null }, 'https://chat.example/v1') === false);
check('no System One block -> inherited',
	system1BaseIsOwn(null, 'https://chat.example/v1') === false);

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
