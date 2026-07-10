// EYES-ON verify for the exploding-barrels feature (barrels worker, G4-run) -- drives
// verify/exploding-barrels-demo.html (a standalone THREE scene, NOT main.ts -- see that file's doc
// comment on why) via raw CDP against a headless Brave, same pattern as verify/shoot.mjs. Assumes a
// `vite` DEV server (not preview/build) is already running and reachable at DEV_URL -- this demo page
// isn't part of index.html's build graph, so `vite build`/`vite preview` won't serve it; `vite dev`
// serves any .html under the project root directly.
//
// Usage: (from game/) npx vite --port 5183 --strictPort &   # start once, separately
//        node verify/shoot-exploding-barrels.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9423;
const DEV_PORT = 5183;
const URL = `http://localhost:${DEV_PORT}/verify/exploding-barrels-demo.html`;
const OUT_DIR = path.join(gameRoot, 'verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

function cdp(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let id = 0;
	const pending = new Map();
	const ready = new Promise((res, rej) => {
		ws.addEventListener('open', res, { once: true });
		ws.addEventListener('error', rej, { once: true });
	});
	ws.addEventListener('message', (ev) => {
		const m = JSON.parse(ev.data);
		if (m.id && pending.has(m.id)) {
			const p = pending.get(m.id);
			pending.delete(m.id);
			m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
		}
	});
	const send = (method, params = {}) =>
		new Promise((res, rej) => {
			const myId = ++id;
			pending.set(myId, { res, rej });
			ws.send(JSON.stringify({ id: myId, method, params }));
		});
	return { ready, send, ws };
}

async function getWsUrl(port) {
	for (let i = 0; i < 60; i++) {
		try {
			const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
			const page = tabs.find((t) => t.type === 'page');
			if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		} catch {}
		await sleep(500);
	}
	throw new Error('no devtools page target');
}

async function main() {
	console.log('[verify] launching headless Brave...');
	const browser = spawn(
		BROWSER,
		[
			'--headless=new',
			`--remote-debugging-port=${CDP_PORT}`,
			'--remote-debugging-address=127.0.0.1',
			'--use-gl=angle',
			'--use-angle=swiftshader',
			'--enable-unsafe-swiftshader',
			'--ignore-gpu-blocklist',
			'--hide-scrollbars',
			'--mute-audio',
			'--no-first-run',
			'--no-default-browser-check',
			'--window-size=1280,720',
			'--force-device-scale-factor=1',
			'--user-data-dir=/tmp/game-verify-barrels-brave-profile',
			'about:blank',
		],
		{ stdio: 'ignore' },
	);

	const consoleErrors = [];
	const pageErrors = [];
	let exitCode = 0;

	try {
		const c = cdp(await getWsUrl(CDP_PORT));
		await c.ready;
		await c.send('Page.enable');
		await c.send('Runtime.enable');

		c.ws.addEventListener('message', (ev) => {
			const m = JSON.parse(ev.data);
			if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
				consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
			}
			if (m.method === 'Runtime.exceptionThrown') {
				pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
			}
		});

		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });

		const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

		let ok = false;
		for (let i = 0; i < 60; i++) {
			const r = await evalExpr('window.__BARREL_DEMO__ && window.__BARREL_DEMO__.ready === true');
			if (r === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__BARREL_DEMO__.ready never became true');
		console.log('[verify] demo ready');

		await evalExpr('window.__BARREL_DEMO__.stepN(30); "ok"'); // 0.5s settle (asleep bodies, suspension)
		let shot = await c.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(OUT_DIR, 'screenshot-exploding-barrels-before.png'), Buffer.from(shot.data, 'base64'));
		console.log('[verify] wrote screenshot-exploding-barrels-before.png');

		await evalExpr('window.__BARREL_DEMO__.crash(60); "ok"');
		// Drive to the FIRST slice of the chain window: the sim test (game/sim/exploding-barrels.
		// test.mjs) showed the apex barrel detonates ~0.35s post-impact and every other barrel (all
		// packed within one BARREL_CHAIN_RADIUS_M of the apex) follows within ~0.4s more -- 26 steps
		// (~0.43s) lands just after the apex's own boom but before the rest have caught, a genuine
		// "mid-chain, some gone, some not yet" moment rather than "whole triangle already gone".
		const approachSteps = 26;
		await evalExpr(`window.__BARREL_DEMO__.stepN(${approachSteps}); "ok"`);

		const explodedMid = await evalExpr('window.__BARREL_DEMO__.explodedCount()');
		console.log('[verify] explodedCount mid-chain =', explodedMid);

		shot = await c.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(OUT_DIR, 'screenshot-exploding-barrels-mid-chain.png'), Buffer.from(shot.data, 'base64'));
		console.log('[verify] wrote screenshot-exploding-barrels-mid-chain.png');

		await evalExpr('window.__BARREL_DEMO__.stepN(60); "ok"'); // let the rest of the cascade + fireball/smoke play out
		const explodedAfter = await evalExpr('window.__BARREL_DEMO__.explodedCount()');
		console.log('[verify] explodedCount after full cascade =', explodedAfter);
		shot = await c.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(path.join(OUT_DIR, 'screenshot-exploding-barrels-after.png'), Buffer.from(shot.data, 'base64'));
		console.log('[verify] wrote screenshot-exploding-barrels-after.png');

		writeFileSync(
			path.join(OUT_DIR, 'console-report-exploding-barrels.json'),
			JSON.stringify({ consoleErrors, pageErrors, explodedMid, explodedAfter }, null, 2),
		);

		if (consoleErrors.length || pageErrors.length) {
			console.error('[verify] console/page errors detected:', { consoleErrors, pageErrors });
			exitCode = 1;
		}

		c.ws.close();
	} catch (err) {
		console.error('[verify] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
	}
	process.exit(exitCode);
}

main();
