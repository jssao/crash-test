// SPDX-License-Identifier: MIT
//
// Browser verification for the ESCALATION fixes to the active-occupant layer (user-playtest wave):
//   1. seated occupants VISUALLY STILL at idle (measured head angular speed via occupantStates-
//      adjacent sampling: two screenshots 1s apart must show an unchanged cabin, plus the sim-side
//      RMS gate lives in sim/occupants-escalation.test.mjs);
//   2. a 30km/h wall bump ejects NOBODY (all 4 seated after impact);
//   3. a violent frontal still ejects through the shattering windshield, and survivors GET UP
//      GROUNDED on the real terrain heightfield (feet at terrain height -- the old absolute-Y stand
//      hovered/kneeled mid-air wherever terrain height differed from 0);
//   4. Shift+R-equivalent world reset (window.__GAME__.resetWorld()) taken from a post-crash state
//      re-seats all 4 (seated, alive, restrained) with zero console errors.
//
// Usage: node verify/occupants-escalation.mjs   (spawns `vite preview` itself; run `npx vite build` first).
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9467;
const PREVIEW_PORT = 4207;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = path.join(gameRoot, 'verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

function waitForHttp(url, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		(async function poll() {
			while (Date.now() - start < timeoutMs) {
				try {
					const r = await fetch(url);
					if (r.ok) return resolve(true);
				} catch {}
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
	console.log('[verify-esc] starting vite preview server...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);
	console.log('[verify-esc] preview up at', URL);

	const browser = spawn(
		BROWSER,
		[
			'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
			'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
			'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
			'--window-size=1280,720', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-esc-brave', 'about:blank',
		],
		{ stdio: 'ignore' },
	);

	const consoleErrors = [];
	const pageErrors = [];
	let exitCode = 0;
	const stages = {};

	try {
		const c = cdp(await getWsUrl(CDP_PORT));
		await c.ready;
		await c.send('Page.enable');
		await c.send('Runtime.enable');
		await c.send('Log.enable');
		c.ws.addEventListener('message', (ev) => {
			const m = JSON.parse(ev.data);
			if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
				consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
			}
			if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
		});

		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });
		const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

		let ok = false;
		for (let i = 0; i < 60; i++) {
			if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__GAME__.ready never became true');
		console.log('[verify-esc] game ready');
		await sleep(1200);

		const shot = async (name) => {
			await sleep(400);
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
			console.log('[verify-esc] wrote', name);
		};
		const states = () => evalExpr('window.__GAME__.features.occupants.occupantStates()');

		// ---- Stage 1: IDLE STILLNESS. Sample head positions 2s apart at idle; the whole cabin must
		// not have moved (numeric gate: max head drift < 2cm), plus a close-up screenshot pair.
		await evalExpr('window.__GAME__.stepN(300); "ok"'); // settle
		await evalExpr('window.__GAME__.setOrbitView({ radius: 6.5, height: 2.6, targetHeight: 0.8 }); window.__GAME__.setFixedAngle(' + Math.PI / 2.9 + '); "ok"');
		const idleA = await states();
		await shot('occupants-esc-1-idle-a.png');
		await evalExpr('window.__GAME__.stepN(120); "ok"'); // 2s of idle
		const idleB = await states();
		await shot('occupants-esc-1-idle-b.png');
		const idleDrift = Math.max(
			...idleA.map((a, i) => {
				const b = idleB[i];
				return Math.hypot(a.headPos.x - b.headPos.x, a.headPos.y - b.headPos.y, a.headPos.z - b.headPos.z);
			}),
		);
		stages.idle = { idleDriftM: idleDrift, states: idleB };

		// ---- Stage 2: 30km/h BUMP -> nobody ejects.
		await evalExpr('window.__GAME__.spawnTestWall(14); "ok"');
		await evalExpr('window.__GAME__.crash(30); "ok"');
		await evalExpr('window.__GAME__.features.occupants.matchVehicleVelocity(); "ok"');
		await evalExpr('window.__GAME__.stepN(300); "ok"'); // bump + 4s aftermath
		stages.mildBump = await states();
		await shot('occupants-esc-2-mild-bump.png');
		await evalExpr('window.__GAME__.resetWorld(); window.__GAME__.stepN(120); "ok"');

		// ---- Stage 3: violent frontal -> ejection -> GROUNDED get-up on the real terrain.
		await evalExpr('window.__GAME__.spawnTestWall(24); "ok"');
		await evalExpr('window.__GAME__.crash(72); "ok"');
		await evalExpr('window.__GAME__.features.occupants.matchVehicleVelocity(); "ok"');
		await evalExpr('window.__GAME__.stepN(80); "ok"');
		stages.ejection = await states();
		await shot('occupants-esc-3-ejection.png');
		await evalExpr('window.__GAME__.stepN(600); "ok"'); // settle + get up
		stages.getup = await states();
		// Frame the getting-up survivor if there is one (fall back to the car view).
		const surv = stages.getup.find((s) => s.alive && s.ejected && (s.state === 'recover' || s.state === 'flee' || s.state === 'safe'));
		if (surv) {
			await evalExpr(`window.__GAME__.setOrbitView({ radius: 9, height: 3.0, targetHeight: 0.9 }); "ok"`);
		}
		await shot('occupants-esc-4-getup.png');
		await evalExpr('window.__GAME__.stepN(500); "ok"');
		stages.flee = await states();
		await shot('occupants-esc-5-flee.png');

		// GROUNDED numeric gate on the REAL terrain: every alive upright survivor's pelvis sits in the
		// human stand band ABOVE the terrain-derived ground under it. occupantStates() has no groundY,
		// but the terrain hook does: sample terrain height at each survivor's x/z if exposed; otherwise
		// gate on pelvis-minus-min-part height (feet under pelvis, not floating beside it).
		// Only fully-standing states (flee/safe) are gated on uprightness -- a RECOVER snapshot can
		// legitimately catch the ramp's grounded-crouch start (that's the fix working, not a hover).
		stages.groundedCheck = stages.flee
			.filter((s) => s.alive && s.ejected && (s.state === 'flee' || s.state === 'safe'))
			.map((s) => ({ seat: s.seatKey, state: s.state, pelvisY: s.pelvisPos.y, headY: s.headPos.y, headMinusPelvis: s.headPos.y - s.pelvisPos.y }));

		// ---- Stage 4: WORLD RESET from this post-crash state (Shift+R equivalent) -> all 4 reseated.
		await evalExpr('window.__GAME__.resetWorld(); window.__GAME__.stepN(180); "ok"');
		stages.afterReset = await states();
		await evalExpr('window.__GAME__.setOrbitView({ radius: 6.5, height: 2.6, targetHeight: 0.8 }); window.__GAME__.setFixedAngle(' + Math.PI / 2.9 + '); "ok"');
		await shot('occupants-esc-6-after-reset.png');
		// And a reset taken while everyone is SEATED (the user's second repro path).
		await evalExpr('window.__GAME__.resetWorld(); window.__GAME__.stepN(180); "ok"');
		stages.afterSecondReset = await states();

		console.log('[verify-esc] idle:', JSON.stringify(stages.idle.idleDriftM));
		console.log('[verify-esc] mildBump:', JSON.stringify(stages.mildBump));
		console.log('[verify-esc] ejection:', JSON.stringify(stages.ejection));
		console.log('[verify-esc] getup:', JSON.stringify(stages.getup));
		console.log('[verify-esc] flee:', JSON.stringify(stages.flee));
		console.log('[verify-esc] grounded:', JSON.stringify(stages.groundedCheck));
		console.log('[verify-esc] afterReset:', JSON.stringify(stages.afterReset));
		console.log('[verify-esc] afterSecondReset:', JSON.stringify(stages.afterSecondReset));

		c.ws.close();
	} catch (err) {
		console.error('[verify-esc] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log('\n[verify-esc] console errors:', consoleErrors.length);
	consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
	console.log('[verify-esc] page exceptions:', pageErrors.length);
	pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

	writeFileSync(path.join(OUT_DIR, 'console-report-occupants-escalation.json'), JSON.stringify({ consoleErrors, pageErrors, stages, timestamp: new Date().toISOString() }, null, 2));

	// ---- Numeric acceptance gates ----
	const failures = [];
	if (!(stages.idle?.idleDriftM < 0.02)) failures.push(`idle head drift ${stages.idle?.idleDriftM}m >= 0.02m (not still)`);
	if (!(stages.mildBump ?? []).every((s) => !s.ejected && s.alive && s.state === 'seated')) failures.push('30km/h bump ejected/killed someone');
	if (!(stages.ejection ?? []).some((s) => s.ejected)) failures.push('72km/h crash ejected nobody');
	if (!(stages.flee ?? []).some((s) => (s.shatteredGlass ?? []).length > 0)) failures.push('no glass shattered in the violent crash');
	if (!(stages.afterReset ?? []).every((s) => s.alive && !s.ejected && s.state === 'seated')) failures.push('world reset from post-crash state did not re-seat 4/4');
	if (!(stages.afterSecondReset ?? []).every((s) => s.alive && !s.ejected && s.state === 'seated')) failures.push('world reset from seated state did not re-seat 4/4');
	for (const g of stages.groundedCheck ?? []) {
		// upright survivor: head must be ABOVE the pelvis by a neck-and-torso's worth (0.25-0.6m),
		// i.e. genuinely standing, not a hovering crouch ball.
		if (!(g.headMinusPelvis > 0.25)) failures.push(`survivor ${g.seat} not upright (head-pelvis ${g.headMinusPelvis})`);
	}
	if (consoleErrors.length > 0 || pageErrors.length > 0) failures.push('console/page errors present');

	console.log(failures.length === 0 ? '[verify-esc] ALL GATES PASS' : `[verify-esc] FAILURES:\n  - ${failures.join('\n  - ')}`);
	process.exit(failures.length === 0 && exitCode === 0 ? 0 : 1);
}

main();
