#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';

const APP = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = 5201;
const DEBUG = 9335;
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

async function startChrome() {
	const proc = spawn(
		'chromium',
		[
			'--headless=new',
			`--remote-debugging-port=${DEBUG}`,
			'--no-first-run',
			'--no-default-browser-check',
			'--disable-gpu',
			'--hide-scrollbars',
			'--window-size=1280,900',
			`--user-data-dir=${OUT}/chrome-states-verify`,
			'about:blank'
		],
		{ stdio: 'ignore', detached: true }
	);
	for (let i = 0; i < 60; i += 1) {
		await wait(300);
		if (await up(`http://127.0.0.1:${DEBUG}/json/version`)) return { proc };
	}
	throw new Error('chromium did not expose CDP');
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

async function evaluate(cdp, expression) {
	const res = await cdp.send('Runtime.evaluate', {
		expression,
		returnByValue: true,
		awaitPromise: true
	});
	if (res.exceptionDetails) {
		throw new Error(res.exceptionDetails.text || 'eval failed');
	}
	return res.result?.value;
}

let chrome;
let vite;
let cdp;
let failed = false;

try {
	vite = await startVite();
	chrome = await startChrome();
	cdp = await attach();

	await cdp.send('Page.enable');
	await cdp.send('Runtime.enable');

	const routesDir = new URL('../src/routes/states', import.meta.url).pathname;
	const routes = readdirSync(routesDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();

	console.log(`Verifying ${routes.length} state workbenches in Chromium...`);

	for (const route of routes) {
		const url = `http://localhost:${PORT}/admin/states/${route}`;

		// 1. Desktop viewport (1500x900) - accommodates up to 1368px breakpoint
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width: 1500,
			height: 900,
			deviceScaleFactor: 1,
			mobile: false
		});
		await cdp.send('Page.navigate', { url });
		await wait(800);

		const desktopCheck = await evaluate(
			cdp,
			`(() => {
				const switcher = document.querySelector('.state-switcher');
				const select = document.querySelector('.state-switcher-select');
				const activeBtn = document.querySelector('.state-switcher button[aria-pressed="true"]');
				const stage = document.querySelector('.state-stage');
				if (!switcher) return { ok: false, reason: 'missing .state-switcher' };
				if (!select) return { ok: false, reason: 'missing .state-switcher-select' };
				if (!stage) return { ok: false, reason: 'missing .state-stage' };
				const sStyle = window.getComputedStyle(switcher);
				const selStyle = window.getComputedStyle(select);
				return {
					ok: true,
					switcherDisplay: sStyle.display,
					selectDisplay: selStyle.display,
					activeState: activeBtn ? activeBtn.getAttribute('data-state') : null
				};
			})()`
		);

		// The rail is a container-query layout: it appears when the workbench has
		// 1180px of its own, and the select stands in below that. What must hold is
		// the pair — a visible rail never overlaps a visible select, and something
		// is always reachable.
		const railShown = desktopCheck.switcherDisplay === 'flex';
		const selectShown = desktopCheck.selectDisplay !== 'none';
		check(
			`${route} desktop layout`,
			desktopCheck.ok && (railShown ? !selectShown : selectShown),
			`active=${desktopCheck.activeState} rail=${desktopCheck.switcherDisplay} select=${desktopCheck.selectDisplay}`
		);

		// 2. Mobile viewport (390x844)
		await cdp.send('Emulation.setDeviceMetricsOverride', {
			width: 390,
			height: 844,
			deviceScaleFactor: 2,
			mobile: true
		});
		await wait(300);

		const mobileCheck = await evaluate(
			cdp,
			`(() => {
				const switcher = document.querySelector('.state-switcher');
				const select = document.querySelector('.state-switcher-select');
				if (!switcher || !select) return { ok: false };
				const sStyle = window.getComputedStyle(switcher);
				const selStyle = window.getComputedStyle(select);
				return {
					ok: true,
					switcherDisplay: sStyle.display,
					selectDisplay: selStyle.display
				};
			})()`
		);

		check(
			`${route} mobile responsive fallback`,
			mobileCheck.ok && mobileCheck.switcherDisplay === 'none' && mobileCheck.selectDisplay !== 'none',
			`switcher=${mobileCheck.switcherDisplay}, select=${mobileCheck.selectDisplay}`
		);
	}

	failed = results.some((r) => !r.ok);
} catch (error) {
	console.error('ERROR:', error);
	failed = true;
} finally {
	try {
		cdp?.ws.close();
	} catch {}
	if (chrome?.proc) process.kill(-chrome.proc.pid, 'SIGTERM');
	if (vite?.proc) process.kill(-vite.proc.pid, 'SIGTERM');
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n# ${passed} passed, ${results.length - passed} failed`);
process.exit(failed ? 1 : 0);
