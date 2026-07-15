// SPDX-License-Identifier: MIT
// Follow-up P003 fence post-base close-ups (building-fence @ 50km/h) -- first pass's ground-level
// sweeps missed the actual broken debris (a standing 2-post section was in frame instead). Map the
// wreckage with a wide top-down shot first, then aim close-ups at the actual snapped pieces.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');
const OUT_DIR = path.join(repoRoot, 'screenshots', 'P003_fence-crash', 'sim');
mkdirSync(OUT_DIR, { recursive: true });

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9515;
const PREVIEW_PORT = 4215;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForHttp(url, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		(async function poll() { while (Date.now() - start < timeoutMs) { try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {} await sleep(300); } reject(new Error('preview never up')); })();
	});
}
function cdp(wsUrl) {
	const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
	const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
	const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); });
	return { ready, send, ws };
}
async function getWsUrl(port) { for (let i = 0; i < 60; i++) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {} await sleep(500); } throw new Error('no target'); }

async function main() {
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'ignore' });
	await waitForHttp(URL);
	const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-round2-p003-brave', 'about:blank'], { stdio: 'ignore' });
	try {
		const c = cdp(await getWsUrl(CDP_PORT));
		await c.ready; await c.send('Page.enable'); await c.send('Runtime.enable');
		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });
		const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
		let ok = false; for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
		if (!ok) throw new Error('never ready');
		await sleep(500);
		await evalExpr("window.__LAB__.setFreeConfig({ speedKmh: 50, offsetM: 0, angleDeg: 0 }); 'ok'");
		await evalExpr("window.__LAB__.setCrashTarget('building-fence'); 'ok'");
		await evalExpr("window.__LAB__.setCrashTargetDistance(14); 'ok'");
		await evalExpr("window.__LAB__.run('free'); 'ok'");
		await evalExpr('window.__LAB__.stepN(420); "ok"');

		async function shot(name) {
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			const p = path.join(OUT_DIR, name);
			writeFileSync(p, Buffer.from(s.data, 'base64'));
			console.log('[p003-followup] wrote', p);
		}
		async function cam(radius, height, targetHeight, angle) {
			await evalExpr(`window.__LAB__.setOrbitView({ radius: ${radius}, height: ${height}, targetHeight: ${targetHeight} }); 'ok'`);
			await evalExpr(`window.__LAB__.setFixedAngle(${angle}); 'ok'`);
			await evalExpr('window.__LAB__.renderNow(); "ok"');
			await sleep(150);
		}

		// Wide top-down map of the whole wreckage (very high, dead-center over the car -- the fence line
		// spans laterally across the car's straight-line path since offsetM=0).
		await cam(0.1, 40, 0.3, 0);
		await shot('round2-map-top-wide.png');
		await cam(0.1, 25, 0.3, 0);
		await shot('round2-map-top-medium.png');

		// The debris (2 fallen rails + a post remnant) sits within a few meters of the car's resting
		// position -- sweep angles at ground level to find the clearest framing.
		const angles = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, (5 * Math.PI) / 4, (3 * Math.PI) / 2, (7 * Math.PI) / 4];
		for (let i = 0; i < angles.length; i++) {
			await cam(2.5, 0.4, 0.15, angles[i]);
			await shot(`round2-post-sweep-${i}.png`);
		}

		c.ws.close();
	} catch (e) {
		console.error('[p003-followup] ERROR', e);
	} finally {
		browser.kill();
		preview.kill();
	}
}
main();
