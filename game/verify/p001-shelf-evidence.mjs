// SPDX-License-Identifier: MIT
//
// P001 FOOTWELL-SHELF evidence pass (orchestrator-run). Captures the seated occupants AT REST in the
// crash lab -- the same top-down-through-the-panoramic-roof angle as the original bug's 'before' photos
// (screenshots/P001_dummies-limp/*.png) -- after the footwell shelf (vehicle/geometry.ts +
// vehicle/vehicle.ts) plants the seated feet at the cabin floor line. The car sits idle (v=0) so the
// speed-gated shelf is ENGAGED. Writes final-*.png to screenshots/P001_dummies-limp/sim/.
// Ports 4233 (preview) / 9533 (CDP) -- deliberately NOT the round3 ports, and NOT the :5173 dev server.
// Usage: node verify/p001-shelf-evidence.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');
const OUT_DIR = path.join(repoRoot, 'screenshots', 'P001_dummies-limp', 'sim');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9533;
const PREVIEW_PORT = 4233;
const LAB_URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForHttp(url, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		(async function poll() {
			while (Date.now() - start < timeoutMs) {
				try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {}
				await sleep(300);
			}
			reject(new Error('preview server never came up'));
		})();
	});
}

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
		if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
	});
	const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); });
	return { ready, send, ws };
}

async function getWsUrl(port) {
	for (let i = 0; i < 60; i++) {
		try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {}
		await sleep(500);
	}
	throw new Error('no devtools page target');
}

let client;
async function evalExpr(expr) {
	const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error(`page exception: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)}`);
	return r.result?.value;
}
async function shot(name) {
	await sleep(250);
	const r = await client.send('Page.captureScreenshot', { format: 'png' });
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(path.join(OUT_DIR, name), Buffer.from(r.data, 'base64'));
	console.log(`[shot] ${name}`);
}
async function navigate(url, readyExpr) {
	await client.send('Page.navigate', { url });
	for (let i = 0; i < 120; i++) {
		await sleep(500);
		try { if (await evalExpr(readyExpr)) return; } catch {}
	}
	throw new Error(`page never ready: ${url}`);
}
const lab = async (expr) => evalExpr(`window.__LAB__.${expr}; 'ok'`);
const render = async () => evalExpr(`window.__LAB__.renderNow(); 'ok'`);

async function main() {
	console.log('[p001] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(LAB_URL);
	console.log('[p001] launching headless Brave...');
	const brave = spawn(BROWSER, [`--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--use-angle=swiftshader', '--window-size=1280,800', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
	client = cdp(await getWsUrl(CDP_PORT));
	await client.ready;
	await client.send('Page.enable');
	await client.send('Runtime.enable');

	try {
		await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
		// Settle the seated occupants onto the shelf at rest (car idle, v=0 -> shelf engaged).
		await lab('stepN(360)');
		await render();
		const occ = await evalExpr('JSON.stringify(window.__LAB__.readout?.occupants ?? null)');
		console.log('[p001] occupants readout:', occ);

		// (a) TOP-DOWN through the panoramic roof -- the original bug's own angle.
		await lab(`setCameraPreset('top')`);
		await render();
		await shot('final-01-top-sunroof.png');

		// 3/4 overhead (matches the loose 'before' photos' framing most closely).
		await lab(`setCameraPreset('3q')`);
		await render();
		await shot('final-02-3q.png');

		// CLOSE overhead through the panoramic roof -- the same framing as the loose 'before' photos
		// (screenshots/P001_dummies-limp/Screenshot*.png): the transparent pano roof shows the seated
		// occupants. Angle ~2.3rad (a rear-3/4 overhead) matches the 'before' composition most closely.
		for (const [i, angle] of [[3, 2.3], [4, 0.9]].entries()) {
			await lab(`setOrbitView({ radius: 6.0, height: 5.5, targetHeight: 0.6 })`);
			await lab(`setFixedAngle(${[2.3, 0.9][i]})`);
			await render();
			await shot(`final-0${[3, 4][i]}-overhead-through-roof-a${[2.3, 0.9][i]}.png`);
		}
		await lab('setFixedAngle(null)');

		console.log('[p001] DONE');
	} finally {
		try { brave.kill(); } catch {}
		try { preview.kill(); } catch {}
	}
}

main().catch((e) => { console.error('[p001] FAILED:', e); process.exit(1); });
