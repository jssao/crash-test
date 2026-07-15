// P005 ROUND 2 capture: the WIDE segmented crash-lab brick wall. Center hit at 50km/h -> the struck
// centre panel breaches while the two flanking panels (own footings, expansion-joint isolated) stay
// standing. Same headless-Brave CDP pattern as verify/p005-offset.mjs, per this run's brief (preview
// :4203, CDP :9503). Writes round2-*.png to the P005 sim screenshots dir (keeps existing files).
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9503;
const PREVIEW_PORT = 4203;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const OUT_DIR = '/Users/jesuscalderon/Documents/crash test/screenshots/P005_brick-wall-crash/sim';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT_DIR, { recursive: true });

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
	const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
	ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
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

async function main() {
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);
	const browser = spawn(BROWSER, [
		'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
		'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
		'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
		'--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-round2-p005-brave-profile', 'about:blank',
	], { stdio: 'ignore' });
	let exitCode = 0;
	try {
		const c = cdp(await getWsUrl(CDP_PORT));
		await c.ready;
		await c.send('Page.enable');
		await c.send('Runtime.enable');
		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });
		const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
		let ok = false;
		for (let i = 0; i < 120; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
		if (!ok) throw new Error('lab never ready');
		await sleep(800);

		const shot = async (name) => {
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
			console.log(`wrote ${name}`);
		};

		// CENTRE hit at 50km/h, wall 14m ahead.
		await evalExpr(`window.__LAB__.selectProtocol('free'); 'ok'`);
		await evalExpr(`window.__LAB__.setFreeConfig({ speedKmh: 50, offsetM: 0, angleDeg: 0 }); 'ok'`);
		await evalExpr(`window.__LAB__.setCrashTargetDistance(14); 'ok'`);
		await evalExpr(`window.__LAB__.setCrashTarget('building-brick'); 'ok'`);
		await sleep(400);

		// --- APPROACH: intact wide wall + car, 3/4 framed to show the full ~8.2m span dwarfing the car.
		await evalExpr(`window.__LAB__.setOrbitView({ radius: 17, height: 6, targetHeight: 1.0 }); window.__LAB__.setFixedAngle(-0.7); 'ok'`);
		await sleep(500);
		await shot('round2-01-approach-3q.png');

		// --- Launch. Lab coasts (NEUTRAL input); light mass-attenuated bricks barely slow the car, so it
		// punches through fast. Catch the NOSE-IN-BREACH moment early (~1s = car reaches the wall line).
		await evalExpr(`window.__LAB__.run('free'); 'ok'`);
		await evalExpr('window.__LAB__.stepN(60); "ok"'); // ~1s: chassis on the wall line, both flanks abreast

		// TOP-DOWN at the breach moment: car ON the wall line, a standing panel abreast on EACH side.
		await evalExpr(`window.__LAB__.setCameraPreset('top'); 'ok'`);
		await sleep(500);
		await shot('round2-02-breach-top.png');

		// HERO 3/4: car buried in the breach where the centre panel was, flanking panels standing.
		await evalExpr(`window.__LAB__.setOrbitView({ radius: 12, height: 4, targetHeight: 1.0 }); window.__LAB__.setFixedAngle(-0.9); 'ok'`);
		await sleep(500);
		await shot('round2-03-breach-3q.png');

		// SIDE: wall face with the breach + a standing panel + ground rubble.
		await evalExpr(`window.__LAB__.setCameraPreset('side'); 'ok'`);
		await sleep(500);
		await shot('round2-04-breach-side.png');

		// RUBBLE CLOSE-UP at settle: low, tight orbit on the debris pile.
		await evalExpr('window.__LAB__.stepN(120); "ok"');
		await evalExpr(`window.__LAB__.setOrbitView({ radius: 7, height: 1.8, targetHeight: 0.5 }); window.__LAB__.setFixedAngle(-0.3); 'ok'`);
		await sleep(500);
		await shot('round2-05-rubble-closeup.png');

		c.ws.close();
	} catch (err) {
		console.error('ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}
	process.exit(exitCode);
}
main();
