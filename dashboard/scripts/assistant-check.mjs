// The console assistant, driven end to end without a Worker.
//
// Two things in this pass could only be checked by looking at the real app:
//
//   A. discovery — the rail carries "AI assistant", the topbar names it, and the
//      settings page shows the *absence* of a key as a command rather than as an
//      empty field (a key typed into a browser ends up in a log).
//   B. handover — the assistant panel hands a `stage_workflow_patch` proposal to
//      the mounted editor through the sink `lib/assistant.ts` exposes, and the
//      editor draws it as a ghost that still needs a human Accept.
//
// The four admin endpoints are stubbed inside the page, so this runs against the
// Vite dev server alone: no Worker, no provider, no key.
//
//   cd dashboard && node scripts/assistant-check.mjs
//
// Exit 0 when every assertion passes. Screenshots land in /tmp/opencode.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = 5199;
const DEBUG = 9333;
const OUT = '/tmp/opencode';

const results = [];
function check(name, ok, detail = '') {
	results.push({ name, ok, detail });
	console.log(`${ok ? 'ok  ' : 'FAIL'} - ${name}${detail ? ` :: ${detail}` : ''}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function up(url) {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
		return res.status < 500;
	} catch {
		return false;
	}
}

async function startVite() {
	if (await up(`http://localhost:${PORT}/`)) return { proc: null };
	const proc = spawn('npm', ['run', 'dev', '--', '--port', String(PORT), '--strictPort'], {
		cwd: APP,
		stdio: 'ignore',
		detached: true
	});
	for (let i = 0; i < 60; i += 1) {
		await wait(500);
		if (await up(`http://localhost:${PORT}/`)) return { proc };
	}
	throw new Error('vite did not come up on ' + PORT);
}

/**
 * Launch a Chromium-family browser and wait for CDP.
 *
 * A CI runner has no `chromium` on PATH, so the candidate list is tried in order and
 * `CHROME_PATH` wins when set — that is what `browser-actions/setup-chrome` exports. When none
 * of them answers, the failure names every path tried instead of saying "chromium did not
 * expose CDP", which is what sent the last person looking at the wrong end of the pipe.
 */
async function startChrome() {
	const candidates = [
		process.env.CHROME_PATH,
		'chromium',
		'chromium-browser',
		'google-chrome',
		'google-chrome-stable'
	].filter((value) => typeof value === 'string' && value !== '');
	const tried = [];
	let lastError = '';

	for (const candidate of candidates) {
		const proc = spawn(
			candidate,
			[
				'--headless=new',
				`--remote-debugging-port=${DEBUG}`,
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-gpu',
				'--hide-scrollbars',
				'--window-size=1280,900',
				`--user-data-dir=${OUT}/chrome-assistant-check`,
				'about:blank'
			],
			{ stdio: 'ignore', detached: true }
		);
		let exited = false;
		proc.once('error', (error) => {
			exited = true;
			lastError = String(error.message ?? error);
		});
		for (let i = 0; i < 40; i += 1) {
			if (exited) break;
			await wait(300);
			if (await up(`http://127.0.0.1:${DEBUG}/json/version`)) return { proc, browser: candidate };
		}
		tried.push(`${candidate}${lastError === '' ? '' : ` (${lastError})`}`);
		try {
			process.kill(-proc.pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}

	throw new Error(
		`no Chromium-family browser answered CDP on ${DEBUG}. Tried: ${tried.join(', ')}. ` +
			'Set CHROME_PATH to a Chrome/Chromium binary (CI does this with browser-actions/setup-chrome).'
	);
}

async function attach() {
	const list = await (await fetch(`http://127.0.0.1:${DEBUG}/json/list`)).json();
	const page = list.find((target) => target.type === 'page');
	if (!page) throw new Error('no page target');
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	let next = 0;
	const pending = new Map();
	ws.addEventListener('message', (event) => {
		const msg = JSON.parse(event.data);
		if (msg.id && pending.has(msg.id)) {
			const settle = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) settle.reject(new Error(msg.error.message));
			else settle.resolve(msg.result);
		}
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++next;
			pending.set(id, { resolve, reject });
			ws.send(JSON.stringify({ id, method, params }));
		});
	return { send, ws };
}

/**
 * The gateway's four answers, in their real shapes. `localStorage.stub` carries
 * per-scenario knobs so a navigation does not lose them.
 */
const STUB = String.raw`
(() => {
	const json = (body, status = 200) =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status,
				headers: { 'content-type': 'application/json' }
			})
		);
	const knobs = () => {
		try {
			return JSON.parse(localStorage.getItem('stub') || '{}');
		} catch {
			return {};
		}
	};
	window.fetch = (input, init) => {
		let path = '';
		try {
			const url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
			path = new URL(url, location.origin).pathname;
		} catch {
			return Promise.reject(new Error('bad url'));
		}
		if (path.endsWith('/admin/session')) {
			return json({ expires_at: Math.floor(Date.now() / 1000) + 3600 });
		}
		if (path === '/v1/admin/ai/settings') {
			const configured = knobs().keyConfigured !== false;
			const workers = knobs().provider === 'workers-ai';
			const base = workers ? null : 'https://api.example.com/v1';
			const model = workers ? '@cf/meta/llama-3.3-70b-instruct-fp8-fast' : 'gpt-4o-mini';
			return json({
				provider: workers ? 'workers-ai' : 'openai-compatible',
				model,
				baseUrl: base,
				// One row, two roles: the effective System One values are resolved
				// server-side, so an inheriting row arrives already filled in.
				system1: {
					model: workers ? 'clef' : 'Clef',
					provider: workers ? 'workers-ai' : 'openai-compatible',
					baseUrl: base,
					inheritsBase: true
				},
				// Workers AI answers through the binding, so neither role needs a key.
				apiKeyConfigured: configured,
				keySource: {
					chat: configured ? 'AI_CHAT_API_KEY' : 'none',
					system1: configured ? 'TOKENLAB_API_KEY' : 'none'
				},
				hint: workers
					? "Uses the Worker's AI binding; no API key is needed."
					: configured
						? 'Key configured.'
						: 'No key for chat or System One.',
				budget: { day: '2026-11-15', used: 12, limit: 20000 }
			});
		}
		if (path === '/v1/admin/assistant/chat') {
			return json({
				answer: 'One proposal, nothing applied.',
				withheld:
					knobs().withheld === true
						? [
								{
									kind: 'stage_workflow_patch',
									reason: 'removing "Condition" is refused because it has two outgoing connections'
								}
							]
						: [],
				proposals: [
					{
						id: 'ap_stubproposal01',
						kind: 'stage_workflow_patch',
						title: 'Add a delay after the trigger',
						summary: 'Add a Delay step after step 1.',
						payload: window.__sinkPatch ?? {}
					}
				]
			});
		}
		// The panel probes the runtime before it asks, and falls back to the stateless route
		// when the runtime is off. Answering an empty object here made it believe a turn succeeded while
		// returning nothing, so the proposal never rendered — the check was stale, not the panel.
		if (path === '/v1/admin/agent/runtime') {
			return json({ enabled: false, schemaVersion: 6, sessions: 0, pinnedName: 'assistant' });
		}
		if (path === '/v1/admin/agent/say') {
			return json(
				{ error: 'agent_runtime_off', message: 'the agent runtime is off on this deployment' },
				503
			);
		}
		if (path === '/v1/admin/agent/conversation') {
			return json({ conversation: 'conv_stub', messages: [], truncated: false });
		}
		if (path === '/v1/admin/agent/attachments') return json({ attachments: [] });
		if (path === '/v1/admin/agent/autonomy') {
			return json({
				enabled: false,
				caps: { sms: 10, writes: 50 },
				usage: { day: '2026-11-19', tokens: 0, writes: 0, sms: 0 },
				mine: true
			});
		}
		if (path.includes('/health')) return json({ ok: true, checks: [] });
		if (path.includes('/alerts')) return json({ alerts: [] });
		if (path.includes('/approvals')) return json({ approvals: [] });
		if (path.includes('/devices')) return json({ devices: [] });
		return json({});
	};
})();
`;

async function evaluate(cdp, expression) {
	const out = await cdp.send('Runtime.evaluate', {
		expression,
		awaitPromise: true,
		returnByValue: true
	});
	if (out.exceptionDetails) {
		throw new Error(
			`evaluate failed: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`
		);
	}
	return out.result?.value;
}

async function until(cdp, expression, label, tries = 80) {
	for (let i = 0; i < tries; i += 1) {
		if (await evaluate(cdp, expression)) return true;
		await wait(250);
	}
	check(label, false, 'timed out');
	return false;
}

async function shot(cdp, name) {
	const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
	await writeFile(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
}

let vite = null;
let chrome = null;
let cdp = null;
let failed = false;

try {
	vite = await startVite();
	chrome = await startChrome();
	cdp = await attach();

	await cdp.send('Page.enable');
	await cdp.send('Runtime.enable');
	await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });

	/* ---------------------------------------------------------------- A. discovery */

	// First load establishes the origin; the key-missing scenario is a knob the
	// stub reads from localStorage, so it survives the reload that follows.
	await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/admin/security/ai` });
	if (!(await until(cdp, `!!document.querySelector('button.launcher')`, 'console shell loaded')))
		throw new Error('shell never rendered');
	check('console shell loaded with the assistant launcher', true);
	await evaluate(cdp, `localStorage.setItem('stub', JSON.stringify({ keyConfigured: false })); true`);
	await cdp.send('Page.reload');
	// The launcher is client-rendered, so waiting for it means the page has
	// hydrated and the rail's `aria-current` reflects this URL rather than the
	// prerendered shell.
	if (!(await until(cdp, `!!document.querySelector('button.launcher')`, 'reloaded with no key')))
		throw new Error('reload never rendered');
	await until(cdp, `!!document.querySelector('.rail, nav')`, 'rail rendered');

	// The rail and the phone topbar mirror each other by design, so the current
	// marker is expected in both. What must not happen is Sign-in also claiming
	// this page, which is what the `exact` flag on that item prevents.
	const nav = await evaluate(
		cdp,
		`(() => {
			const rail = document.querySelector('aside.rail');
			const links = rail
				? [...rail.querySelectorAll('a')].filter((a) => /security\\/ai$/.test(a.getAttribute('href') || ''))
				: [];
			const current = [...document.querySelectorAll('[aria-current="page"]')].map((el) =>
				el.innerText.replace(/\\s+/g, ' ').trim()
			);
			const top = document.querySelector('.topbar');
			return {
				railItem: links.length,
				railLabel: links[0] ? links[0].innerText.replace(/\\s+/g, ' ').trim() : '',
				current,
				topbar: top ? top.innerText.replace(/\\s+/g, ' ').trim() : ''
			};
		})()`
	);
	check('the rail carries exactly one AI assistant entry', nav.railItem === 1, nav.railLabel);
	check(
		'every current marker names the AI page (Sign-in does not claim it)',
		nav.current.length > 0 && nav.current.every((label) => /AI assistant/i.test(label)),
		nav.current.join(' | ')
	);
	check('the topbar names the page', /AI assistant/i.test(nav.topbar), nav.topbar.slice(0, 60));

	const key = await evaluate(
		cdp,
		`(() => {
			const text = document.body.innerText;
			const flat = text.replace(/\\s+/g, ' ');
			const commands = flat.match(/cf workers secrets update [A-Z_]+/g) ?? [];
			return {
				// This deployment sets secrets with cf; the page must not send an
				// operator to a second CLI. One command per role.
				command: commands.length > 0,
				commands,
				password: document.querySelectorAll('input[type="password"]').length,
				chip: /not configured/i.test(text),
				budget: /12\\s*\\/\\s*20000/.test(flat),
				unit: /20000 tokens/.test(flat) ? 'tokens' : /20000 calls/.test(flat) ? 'calls' : 'none',
				calls: /\\bcalls\\b/.test(flat)
			};
		})()`
	);
	check(
		'a missing key is stated as a cf command, one per role',
		key.command === true && key.commands.length === 2,
		key.commands.join(' | ') || 'none found'
	);
	check('the page has no place to type a key', key.password === 0, 'input[type=password] count 0');
	check('key state and budget are both rendered', key.chip && key.budget, '');
	check('the allowance counts tokens, not calls', key.unit === 'tokens' && !key.calls, key.unit);
	await shot(cdp, 'assistant-settings');

	// The default provider takes no key at all, so the page must not tell this
	// operator to install one.
	await evaluate(
		cdp,
		`localStorage.setItem('stub', JSON.stringify({ provider: 'workers-ai' })); true`
	);
	await cdp.send('Page.reload');
	await until(cdp, `!!document.querySelector('button.launcher')`, 'reloaded on workers-ai');
	await until(cdp, `document.body.innerText.includes('Workers AI') || !!document.querySelector('select')`, 'settings settled');
	const workers = await evaluate(
		cdp,
		`(() => {
			const text = document.body.innerText;
			return {
				command: /cf workers secrets update AI_/.test(text.replace(/\s+/g, ' ')),
				notNeeded: /not needed/i.test(text),
				binding: /AI\b binding|binding/i.test(text),
				baseField: [...document.querySelectorAll('label')].some((l) => /base url/i.test(l.innerText))
			};
		})()`
	);
	check('workers-ai is not told to install a key', workers.command === false, 'wrangler command absent');
	check('workers-ai says the binding answers instead', workers.notNeeded && workers.binding, '');
	check('workers-ai hides the base URL field', workers.baseField === false, '');
	await shot(cdp, 'assistant-settings-workers-ai');

	/* ------------------------------------------- the sink after a real navigation */

	// The panel outlives navigation. A patch proposed on a page with no editor
	// must become stageable once the operator follows the card's own link into
	// one, without closing and re-asking.
	await evaluate(
		cdp,
		`window.__sinkPatch = {
			flow_id: null,
			nodes: [{ id: 'n_nav_delay', type: 'delay', position: { x: 80, y: 120 }, data: { seconds: 3 } }],
			edges: []
		}; true`
	);
	await evaluate(cdp, `document.querySelector('button.launcher').click(); true`);
	await until(cdp, `!!document.querySelector('form.ask input')`, 'panel opened for the navigation case');
	await evaluate(
		cdp,
		`(() => {
			const input = document.querySelector('form.ask input');
			input.value = 'add a delay';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		})()`
	);
	await evaluate(cdp, `document.querySelector('form.ask').requestSubmit(); true`);
	if (!(await until(cdp, `!!document.querySelector('.proposal')`, 'proposal on a page with no editor')))
		throw new Error('proposal never rendered on the settings page');
	const beforeNav = await evaluate(
		cdp,
		`(() => {
			const li = document.querySelector('.proposal');
			return {
				text: li.innerText.replace(/\\s+/g, ' ').trim(),
				buttons: [...li.querySelectorAll('button')].map((b) => b.innerText.trim()),
				link: (li.querySelector('a') || {}).getAttribute ? li.querySelector('a').getAttribute('href') : null
			};
		})()`
	);
	check(
		'with no editor open the card explains instead of offering a button',
		!/Stage the patch/.test(beforeNav.buttons.join(' ')) && /editor is not open/i.test(beforeNav.text),
		beforeNav.buttons.join(' | ') || 'no buttons'
	);

	await evaluate(
		cdp,
		`(() => { const a = document.querySelector('.proposal a'); a.click(); return true; })()`
	);
	if (!(await until(cdp, `document.body.innerText.includes('Draft · not saved')`, 'editor reached from the card link')))
		throw new Error('the card link did not open the editor');
	const afterNav = await evaluate(
		cdp,
		`(() => {
			const li = document.querySelector('.proposal');
			return li ? [...li.querySelectorAll('button')].map((b) => b.innerText.trim()) : [];
		})()`
	);
	check(
		'the same proposal becomes stageable after the editor mounts',
		afterNav.includes('Stage the patch'),
		afterNav.join(' | ') || 'no buttons'
	);
	await evaluate(cdp, `document.querySelector('button.close').click(); true`);

	/* ---------------------------------------------------------------- B. handover */

	await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/admin/workflows/edit` });
	if (!(await until(cdp, `document.body.innerText.includes('Draft · not saved')`, 'editor mounted')))
		throw new Error('editor never rendered');

	// The editor opens on Steps; the canvas (and its node ids) is the Map. Using
	// the operator's own control keeps this out of component internals.
	await evaluate(
		cdp,
		`(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Map'); if (btn) btn.click(); return true; })()`
	);
	if (!(await until(cdp, `!!document.querySelector('[data-node-id]')`, 'map surface with a node')))
		throw new Error('canvas never rendered');
	const triggerId = await evaluate(
		cdp,
		`document.querySelector('[data-node-id]').getAttribute('data-node-id')`
	);
	check('workflow editor is mounted (draft with one trigger)', Boolean(triggerId), triggerId ?? '');

	const patchFor = (flowId) => `{
		flow_id: ${JSON.stringify(flowId)},
		nodes: [
			{ id: ${JSON.stringify(triggerId)}, type: 'trigger', position: { x: 40, y: 120 }, data: {} },
			{ id: 'n_sink_delay', type: 'delay', position: { x: 360, y: 120 }, data: { seconds: 5 } }
		],
		edges: [{ id: 'e_sink_1', source: ${JSON.stringify(triggerId)}, target: 'n_sink_delay' }]
	}`;

	// A patch written for another flow is refused by the editor's sink, not
	// staged into whatever happens to be open: `patchFitsFlow` is structural.
	await evaluate(cdp, `window.__sinkPatch = ${patchFor('wf_some_other_flow')}; true`);

	await evaluate(cdp, `document.querySelector('button.launcher').click(); true`);
	if (!(await until(cdp, `!!document.querySelector('form.ask input')`, 'panel opened')))
		throw new Error('panel did not open');
	check('launcher opens the panel', true);

	await evaluate(
		cdp,
		`(() => {
			const input = document.querySelector('form.ask input');
			input.value = 'add a delay';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		})()`
	);
	await evaluate(cdp, `document.querySelector('form.ask').requestSubmit(); true`);

	if (!(await until(cdp, `!!document.querySelector('.proposal')`, 'proposal card rendered')))
		throw new Error('proposal card never rendered');
	const card = await evaluate(
		cdp,
		`(() => {
			const li = document.querySelector('.proposal');
			return {
				text: li.innerText.replace(/\\s+/g, ' ').trim(),
				buttons: [...li.querySelectorAll('button')].map((b) => b.innerText.trim())
			};
		})()`
	);
	check('the proposed patch says it stages in the editor', /Stages in the editor/.test(card.text));
	check(
		'"Stage the patch" is offered only because the sink is registered',
		card.buttons.includes('Stage the patch'),
		card.buttons.join(' | ')
	);
	const before = await evaluate(
		cdp,
		`(() => { const b = document.querySelector('.ghost-banner'); return b ? b.innerText : ''; })()`
	);
	check('nothing is staged before the click', before === '');

	await evaluate(
		cdp,
		`(() => {
			const btn = [...document.querySelectorAll('.proposal button')].find((b) => b.innerText.trim() === 'Stage the patch');
			btn.click();
			return true;
		})()`
	);
	await wait(800);
	const wrongFlow = await evaluate(
		cdp,
		`(() => {
			const li = document.querySelector('.proposal');
			const banner = document.querySelector('.ghost-banner');
			return {
				card: li ? li.innerText.replace(/\\s+/g, ' ').trim() : '',
				banner: banner ? banner.innerText : ''
			};
		})()`
	);
	check(
		'a patch written for another flow is refused, not staged',
		/written for flow/i.test(wrongFlow.card) && wrongFlow.banner === '',
		wrongFlow.card.slice(-90)
	);

	// The same proposal for this flow: close, re-ask with a patch that names no
	// flow (a draft has no id to name), then stage for real.
	await evaluate(cdp, `window.__sinkPatch = ${patchFor(null)}; true`);
	await evaluate(cdp, `document.querySelector('button.close').click(); true`);
	await evaluate(cdp, `document.querySelector('button.launcher').click(); true`);
	await until(cdp, `!!document.querySelector('form.ask input')`, 'panel reopened');
	await evaluate(
		cdp,
		`(() => {
			const input = document.querySelector('form.ask input');
			input.value = 'add a delay';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		})()`
	);
	await evaluate(cdp, `document.querySelector('form.ask').requestSubmit(); true`);
	if (!(await until(cdp, `!!document.querySelector('.proposal')`, 'second proposal rendered')))
		throw new Error('second proposal never rendered');
	await shot(cdp, 'assistant-proposal');

	await evaluate(
		cdp,
		`(() => {
			const btn = [...document.querySelectorAll('.proposal button')].find((b) => b.innerText.trim() === 'Stage the patch');
			btn.click();
			return true;
		})()`
	);
	await wait(1200);

	const after = await evaluate(
		cdp,
		`(() => {
			const li = document.querySelector('.proposal');
			const banner = document.querySelector('.ghost-banner');
			return {
				card: li ? li.innerText.replace(/\\s+/g, ' ').trim() : '',
				banner: banner ? banner.innerText.replace(/\\s+/g, ' ').trim() : '',
				ghostNodes: document.querySelectorAll('.wf-node-ghost').length
			};
		})()`
	);
	check(
		'the editor accepted the handover and drew the ghost',
		/Staged patch/i.test(after.banner) && after.ghostNodes > 0,
		`ghosts=${after.ghostNodes} banner="${after.banner.slice(0, 80)}"`
	);
	check(
		'the patch is presented as unjudged, not as validated',
		/no judgement/i.test(after.banner)
	);
	check('the card reports the editor result', /staged/i.test(after.card), after.card.slice(0, 70));
	await shot(cdp, 'assistant-staged');

	/* --------------------------------------- a proposal the gateway withheld */

	await cdp.send('Page.navigate', { url: `http://localhost:${PORT}/admin/security/ai` });
	await wait(1200);
	if (!(await until(cdp, `!!document.querySelector('button.launcher')`, 'shell for the withheld case')))
		throw new Error('shell never rendered for the withheld case');
	await evaluate(cdp, `localStorage.setItem('stub', JSON.stringify({ withheld: true })); true`);
	await cdp.send('Page.reload');
	await wait(1200);
	await until(cdp, `!!document.querySelector('button.launcher')`, 'reloaded for the withheld case');
	await evaluate(cdp, `document.querySelector('button.launcher').click(); true`);
	await until(cdp, `!!document.querySelector('form.ask input')`, 'panel opened for the withheld case');
	await evaluate(
		cdp,
		`(() => {
			const input = document.querySelector('form.ask input');
			input.value = 'add a delay';
			input.dispatchEvent(new Event('input', { bubbles: true }));
			return true;
		})()`
	);
	await evaluate(cdp, `document.querySelector('form.ask').requestSubmit(); true`);
	await until(cdp, `!!document.querySelector('.withheld-line')`, 'withheld line rendered');
	const withheldLine = await evaluate(
		cdp,
		`(() => {
			const line = document.querySelector('.withheld-line');
			return line ? line.innerText : '';
		})()`
	);
	const withheldText = String(withheldLine).replace(/\s+/g, ' ').trim();
	check(
		'a withheld proposal is reported, not silently dropped',
		/two outgoing connections/.test(withheldText) && /stage_workflow_patch/.test(withheldText),
		withheldText.slice(0, 100)
	);
	await shot(cdp, 'assistant-withheld');
	await evaluate(cdp, `localStorage.setItem('stub', JSON.stringify({})); true`);

	failed = results.some((result) => !result.ok);
} catch (error) {
	console.error(`ERROR ${error.message}`);
	failed = true;
} finally {
	try {
		cdp?.ws.close();
	} catch {
		/* ignore */
	}
	if (chrome?.proc) process.kill(-chrome.proc.pid, 'SIGTERM');
	if (vite?.proc) process.kill(-vite.proc.pid, 'SIGTERM');
}

const passed = results.filter((result) => result.ok).length;
console.log(`\n# ${passed} passed, ${results.length - passed} failed`);
process.exit(failed ? 1 : 0);
