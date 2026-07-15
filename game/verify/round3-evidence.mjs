// SPDX-License-Identifier: MIT
//
// ROUND-3 evidence pass (orchestrator-run): correctly-staged captures for the 7 gate-open bugs.
// Hard lesson from round 2 (see docs/loom/2026-07-15-bugfix-run/gate.md): capture agents mis-framed
// 4 of 5 items. This script therefore (a) navigates a FRESH page per item (no state bleed),
// (b) captures a PRE-RUN staging frame proving the crash target actually spawned before launching,
// and (c) uses __LAB__.renderNow() before every shot for deterministic frames.
// Ports 4223 (preview) / 9523 (CDP). Usage: node verify/round3-evidence.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');
const shots = (bug) => path.join(repoRoot, 'screenshots', bug, 'sim');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9523;
const PREVIEW_PORT = 4223;
const LAB_URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const GAME_URL = `http://localhost:${PREVIEW_PORT}/index.html?quality=medium`;
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
async function shot(bug, name) {
	await sleep(250);
	const r = await client.send('Page.captureScreenshot', { format: 'png' });
	const dir = shots(bug);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, name), Buffer.from(r.data, 'base64'));
	console.log(`[shot] ${bug}/${name}`);
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
const step = async (n) => { await evalExpr(`window.__LAB__.stepN(${n}); 'ok'`); await evalExpr(`window.__LAB__.renderNow(); 'ok'`); };
const fx = async () => { try { return JSON.stringify(await evalExpr('window.__FX__ ? window.__FX__.counters() : null')); } catch { return 'n/a'; } };

async function labItem({ bug, prefix, targetId, speedKmh, dist, frames }) {
	console.log(`\n=== ${prefix} (${targetId} @ ${speedKmh}km/h, dist ${dist}) ===`);
	await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
	await lab(`setFreeConfig({ speedKmh: ${speedKmh}, offsetM: 0, angleDeg: 0 })`);
	await lab(`setCrashTarget('${targetId}')`);
	await lab(`setCrashTargetDistance(${dist})`);
	await sleep(800);
	await lab(`setCameraPreset('3q')`);
	await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
	await shot(bug, `${prefix}-00-STAGING-preview-3q.png`); // must show the target ahead of the car
	await lab(`run('free')`);
	let cum = 0;
	for (const f of frames) {
		if (f.steps > cum) { await step(f.steps - cum); cum = f.steps; }
		if (f.preset) await lab(`setCameraPreset('${f.preset}')`);
		if (f.orbit) await lab(`setOrbitView(${JSON.stringify(f.orbit)})`);
		if (f.angle !== undefined) await lab(`setFixedAngle(${f.angle})`);
		await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
		console.log(`[fx@${cum}] ${await fx()}`);
		await shot(bug, `${prefix}-${f.name}.png`);
		if (f.angle !== undefined) await lab(`setFixedAngle(null)`);
	}
	console.log(`[readout] ${JSON.stringify(await evalExpr('({state: window.__LAB__.runState, crushF: window.__LAB__.readout?.crush?.front ?? null})')).slice(0, 200)}`);
}

async function main() {
	console.log('[round3] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(`http://localhost:${PREVIEW_PORT}/crash-lab.html`);
	console.log('[round3] launching headless Brave...');
	const brave = spawn(BROWSER, [`--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--use-angle=swiftshader', '--window-size=1280,800', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
	client = cdp(await getWsUrl(CDP_PORT));
	await client.ready;
	await client.send('Page.enable');
	await client.send('Runtime.enable');

	try {
		// P002 — tree-mid front-crush view (wrap-vs-mush evidence)
		await labItem({
			bug: 'P002_deformation', prefix: 'round3-p002', targetId: 'tree-mid', speedKmh: 50, dist: 14,
			frames: [
				{ steps: 75, preset: 'side', name: '01-impact-side' },
				{ steps: 300, orbit: { radius: 7, height: 1.3, targetHeight: 0.7 }, angle: 0, name: '02-front-angle0' },
				{ steps: 300, angle: Math.PI, name: '03-front-anglePI' },
				{ steps: 300, preset: '3q', name: '04-settled-3q' },
			],
		});
		// P003 — fence post bases
		await labItem({
			bug: 'P003_fence-crash', prefix: 'round3-p003', targetId: 'building-fence', speedKmh: 50, dist: 14,
			frames: [
				{ steps: 120, preset: 'side', name: '01-impact-side' },
				{ steps: 300, orbit: { radius: 8, height: 0.9, targetHeight: 0.4 }, angle: 0, name: '02-low-angle0' },
				{ steps: 300, angle: Math.PI / 2, name: '03-low-anglePIhalf' },
				{ steps: 300, angle: Math.PI, name: '04-low-anglePI' },
			],
		});
		// P010 — barrel dents, both variants
		for (const [variant, speed] of [['barrel-rust', 40], ['barrel-blue', 40]]) {
			await labItem({
				bug: 'P010_metal-barrels-no-deform', prefix: `round3-p010-${variant}`, targetId: variant, speedKmh: speed, dist: 10,
				frames: [
					{ steps: 55, orbit: { radius: 4.5, height: 1.3, targetHeight: 0.8 }, angle: 0, name: '01-close-angle0' },
					{ steps: 55, angle: Math.PI / 2, name: '02-close-anglePIhalf' },
					{ steps: 175, angle: 0, name: '03-settled-close' },
				],
			});
		}
		// P011 — crate fragments
		await labItem({
			bug: 'P011_wooden-crate-impact', prefix: 'round3-p011', targetId: 'crate', speedKmh: 50, dist: 10,
			frames: [
				{ steps: 55, preset: 'top', name: '01-impact-top' },
				{ steps: 55, orbit: { radius: 5.5, height: 2.5, targetHeight: 0.3 }, angle: Math.PI / 4, name: '02-close-high' },
				{ steps: 160, preset: 'top', name: '03-settled-top' },
			],
		});
		// R003/R004 — FX battery A: NHTSA frontal (shards/dust/smoke burst around contact, then puddle+scuffs)
		console.log('\n=== round3-fx frontal-56 ===');
		await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
		await lab(`run('nhtsa-frontal-56')`);
		let cum = 0;
		for (const [steps, preset, name] of [[48, 'side', '01-contact-side'], [56, 'side', '02-contact+8-side'], [64, '3q', '03-contact+16-3q'], [72, '3q', '04-contact+24-3q']]) {
			await step(steps - cum); cum = steps;
			await lab(`setCameraPreset('${preset}')`);
			await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
			console.log(`[fx@${cum}] ${await fx()}`);
			await shot('R003_missing-crash-effects', `round3-fx-${name}.png`);
		}
		await step(400 - cum);
		await lab(`setCameraPreset('top')`);
		await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
		console.log(`[fx@settled] ${await fx()}`);
		await shot('R003_missing-crash-effects', 'round3-fx-05-settled-puddle-top.png');
		await lab(`setOrbitView({ radius: 4.5, height: 1.0, targetHeight: 0.7 })`);
		await lab(`setFixedAngle(-2.4)`);
		await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
		await shot('R004_no-paint-damage-hanging-parts', 'round3-fx-06-scuff-frontleft-close.png');
		await lab(`setFixedAngle(2.4)`);
		await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
		await shot('R004_no-paint-damage-hanging-parts', 'round3-fx-07-scuff-frontright-close.png');
		// FX battery B: 130 km/h free (sprung doors + shattered glass + heavier fluids)
		console.log('\n=== round3-fx free-130 ===');
		await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
		await lab(`setFreeConfig({ speedKmh: 130, offsetM: 0, angleDeg: 0 })`);
		await lab(`run('free')`);
		await step(420);
		await lab(`setCameraPreset('3q')`);
		await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
		console.log(`[fx@130settled] ${await fx()}`);
		await shot('R004_no-paint-damage-hanging-parts', 'round3-fx-08-sprungdoor-3q.png');
		await lab(`setOrbitView({ radius: 4.5, height: 1.6, targetHeight: 1.1 })`);
		await lab(`setFixedAngle(1.9)`);
		await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
		await shot('R004_no-paint-damage-hanging-parts', 'round3-fx-09-shatteredglass-close.png');
		await lab(`setCameraPreset('top')`);
		await evalExpr(`window.__LAB__.renderNow(); 'ok'`);
		await shot('R003_missing-crash-effects', 'round3-fx-10-130-settled-top.png');
		// P013 — driving page in motion, pristine
		console.log('\n=== round3-p013 driving page ===');
		await navigate(GAME_URL, 'window.__GAME__ && window.__GAME__.ready === true');
		await evalExpr(`window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'`);
		await evalExpr(`window.__GAME__.stepN(240); 'ok'`);
		await sleep(700);
		await shot('P013_car-deformation-system', 'round3-p013-01-inmotion-throttle.png');
		await evalExpr(`window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0.6, handbrake: false }); 'ok'`);
		await evalExpr(`window.__GAME__.stepN(150); 'ok'`);
		await sleep(700);
		await shot('P013_car-deformation-system', 'round3-p013-02-hardbrake-steer.png');
		await evalExpr(`window.__GAME__.setInput(null); 'ok'`);
		console.log(`[p013 damage] ${JSON.stringify(await evalExpr('({d: window.__GAME__.telemetry.damage ?? null})')).slice(0, 400)}`);
		console.log('\n[round3] DONE');
	} finally {
		try { brave.kill(); } catch {}
		try { preview.kill(); } catch {}
	}
}

main().catch((e) => { console.error('[round3] FAILED:', e); process.exit(1); });
