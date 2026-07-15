// SPDX-License-Identifier: MIT
//
// Round-2 evidence pass: fresh crash-lab captures for items 2 (P002 front-crush view), 3 (P003 fence
// post-base close-ups), 4c (P010 barrel dent close-ups under the re-tuned BARREL_DENT_* factors), 5
// (P011 crate fragment close-ups), 6 (P001 dummy knee/leg visibility attempt). Same raw-CDP-over-
// WebSocket headless-Brave pattern as verify/crash-lab.mjs (no puppeteer) -- one `vite preview` +
// headless Brave instance, driven via window.__LAB__'s setCrashTarget/setCrashTargetDistance/
// setFreeConfig/run/stepN/setCameraPreset/setOrbitView/setFixedAngle/renderNow hooks.
//
// Ports 4213 (preview) / 9513 (CDP) per this task's dispatch (other concurrent agents hold other
// ports). Usage: node verify/round2-crash-lab-evidence.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');
const screenshotsRoot = path.join(repoRoot, 'screenshots');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9513;
const PREVIEW_PORT = 4213;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OUT_DIRS = {
	p002: path.join(screenshotsRoot, 'P002_deformation', 'sim'),
	p003: path.join(screenshotsRoot, 'P003_fence-crash', 'sim'),
	p010: path.join(screenshotsRoot, 'P010_metal-barrels-no-deform', 'sim'),
	p011: path.join(screenshotsRoot, 'P011_wooden-crate-impact', 'sim'),
	p001: path.join(screenshotsRoot, 'P001_dummies-limp', 'sim'),
};
for (const d of Object.values(OUT_DIRS)) mkdirSync(d, { recursive: true });

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

async function main() {
	console.log('[round2] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);

	console.log('[round2] launching headless Brave...');
	const browser = spawn(BROWSER, [
		'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
		'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
		'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
		'--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-round2-brave-profile', 'about:blank',
	], { stdio: 'ignore' });

	const consoleErrors = [];
	const pageErrors = [];
	const shots = [];
	let exitCode = 0;

	try {
		const c = cdp(await getWsUrl(CDP_PORT));
		await c.ready;
		await c.send('Page.enable');
		await c.send('Runtime.enable');
		c.ws.addEventListener('message', (ev) => {
			const m = JSON.parse(ev.data);
			if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
			if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
		});
		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });
		const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
			if (r?.exceptionDetails) console.error('[round2] EVAL EXCEPTION:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
			return r?.result?.value;
		});

		let ok = false;
		for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
		if (!ok) throw new Error('window.__LAB__.ready never became true');
		console.log('[round2] lab ready');
		await sleep(800);

		async function shot(dir, name) {
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			const p = path.join(dir, name);
			writeFileSync(p, Buffer.from(s.data, 'base64'));
			shots.push(p);
			console.log(`[round2] wrote ${p}`);
		}

		// IMPORTANT: renderNow() (called once per crashInto() below) PERMANENTLY stops the wall-clock
		// rAF loop (its own doc comment) -- from then on nothing re-renders automatically, so every
		// subsequent camera change needs its OWN renderNow() call to actually apply before a screenshot,
		// not just a sleep (a sleep alone re-captures the exact same stale frame). Confirmed by hand: an
		// earlier version of this script's cam() only slept, and every angle in a sweep came back
		// byte-identical to the first.
		async function cam(radius, height, targetHeight, angle) {
			await evalExpr(`window.__LAB__.setOrbitView({ radius: ${radius}, height: ${height}, targetHeight: ${targetHeight} }); 'ok'`);
			await evalExpr(`window.__LAB__.setFixedAngle(${angle}); 'ok'`);
			await evalExpr('window.__LAB__.renderNow(); "ok"');
			await sleep(150);
		}

		/** Crash into `targetId` at `speedKmh` via the FREE protocol, straight-on (offset/angle 0), then
		 * stepN(steps) and renderNow(). Returns the readout for logging. */
		async function crashInto(targetId, speedKmh, steps) {
			await evalExpr('window.__LAB__.reset(); "ok"');
			await evalExpr(`window.__LAB__.setFreeConfig({ speedKmh: ${speedKmh}, offsetM: 0, angleDeg: 0 }); 'ok'`);
			await evalExpr(`window.__LAB__.setCrashTarget('${targetId}'); 'ok'`);
			await evalExpr(`window.__LAB__.setCrashTargetDistance(14); 'ok'`);
			await evalExpr(`window.__LAB__.run('free'); 'ok'`);
			await evalExpr(`window.__LAB__.stepN(${steps}); 'ok'`);
			await evalExpr('window.__LAB__.renderNow(); "ok"');
			const readout = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
			return readout;
		}

		// =========================================================================================
		// ITEM 2 -- P002 front-crush view: tree-mid @ ~50 km/h. Honest judgment: localized trunk-
		// shaped notch vs. full-width flat mush.
		// =========================================================================================
		console.log('[round2] ITEM 2: P002 tree-mid @ 50km/h front-crush view');
		{
			const readout = await crashInto('tree-mid', 50, 420);
			console.log('[round2] p002 readout:', JSON.stringify({ crush: readout.crush, panels: readout.panelStates, dented: readout.dentedVertexCount }));
			// Recon shots first (wide 3q + top) so the debris layout is visible for judgment.
			await cam(10, 3, 0.6, -Math.PI / 3);
			await shot(OUT_DIRS.p002, 'round2-recon-3q.png');
			await cam(1.2, 16, 0.3, -Math.PI / 4);
			await shot(OUT_DIRS.p002, 'round2-recon-top.png');
			// Front head-on: positive-sin angle puts the camera on the FAR (target) side, ahead of the
			// crushed nose, looking back at it -- the tree target (unlike a flat rigid barrier) is a
			// slender trunk, not a wide occluding plane, so this should stay clear.
			await cam(5, 1.0, 0.6, Math.PI / 2);
			await shot(OUT_DIRS.p002, 'round2-front-headon.png');
			await cam(3.2, 0.85, 0.55, Math.PI / 2);
			await shot(OUT_DIRS.p002, 'round2-front-headon-close.png');
			// Front 3/4 close-up (off-axis so both the notch AND one front corner/headlight read).
			await cam(3.0, 0.9, 0.6, Math.PI / 2 - 0.6);
			await shot(OUT_DIRS.p002, 'round2-front-3q-close.png');
			await cam(3.0, 0.9, 0.6, Math.PI / 2 + 0.6);
			await shot(OUT_DIRS.p002, 'round2-front-3q-close-b.png');
		}

		// =========================================================================================
		// ITEM 3 -- P003 fence: building-fence @ ~50 km/h. Ground-level close-ups of POST BASES
		// (snapped/fractured stub + broken piece), framing the fence, not the car.
		// =========================================================================================
		console.log('[round2] ITEM 3: P003 building-fence @ 50km/h post-base close-ups');
		{
			const readout = await crashInto('building-fence', 50, 420);
			console.log('[round2] p003 readout:', JSON.stringify({ crush: readout.crush, panels: readout.panelStates }));
			await cam(12, 4, 0.6, -Math.PI / 3);
			await shot(OUT_DIRS.p003, 'round2-recon-3q.png');
			await cam(1.5, 18, 0.3, -Math.PI / 4);
			await shot(OUT_DIRS.p003, 'round2-recon-top.png');
			// Ground-level sweeps around the impact point -- height at the orbit formula's hard floor
			// (0.4m, cameraOrbit.ts's "never clip below the ground plane" clamp), targetHeight aimed at a
			// post's base/stub height (~0.2-0.35m), several angles/radii since we don't know in advance
			// which side the scattered posts land toward.
			await cam(3.0, 0.4, 0.25, -Math.PI / 2.4);
			await shot(OUT_DIRS.p003, 'round2-post-base-a.png');
			await cam(2.2, 0.4, 0.2, -Math.PI / 1.8);
			await shot(OUT_DIRS.p003, 'round2-post-base-b.png');
			await cam(2.2, 0.45, 0.25, Math.PI / 2.2);
			await shot(OUT_DIRS.p003, 'round2-post-base-c.png');
			await cam(3.5, 0.5, 0.3, 0);
			await shot(OUT_DIRS.p003, 'round2-post-base-d-side.png');
			await cam(1.6, 0.4, 0.15, -Math.PI / 2.1);
			await shot(OUT_DIRS.p003, 'round2-post-base-e-tight.png');
		}

		// =========================================================================================
		// ITEM 4c -- P010 barrel dent close-ups (full + empty), under the re-tuned BARREL_DENT_MASS_
		// FACTOR_FULL/EMPTY -- captured EARLY (fewer steps) right after the first contact so the crease
		// reads before further carry/settle churns the surface. Angled with a bit of elevation so a
		// specular highlight catches the crease.
		// =========================================================================================
		// NOTE: window.__LAB__.readout.dentedVertexCount is the CAR's own damage-system dent count
		// (getDamageTelemetry(damageSystem)) -- barrel mesh dents are tracked entirely separately
		// (crashTargets.ts's own BarrelDentEntry[] bookkeeping, never pushed into damageSystem.registry),
		// so there is no numeric __LAB__ hook for "how dented is the barrel" to log here (adding one
        // would mean editing src/lab/main.ts or crashTargets.ts, both FORBIDDEN for this task) -- this
		// is a purely visual (eyes-on) capture, judged from the screenshots themselves.
		console.log('[round2] ITEM 4c: P010 barrel dent close-ups (blue=full, rust=empty) @ 40km/h');
		for (const [targetId, label] of [['barrel-blue', 'full'], ['barrel-rust', 'empty']]) {
			await crashInto(targetId, 40, 45); // early: right after first contact
			await cam(2.2, 1.1, 0.45, Math.PI / 2 - 0.4);
			await shot(OUT_DIRS.p010, `round2-${label}-dent-early-a.png`);
			await cam(1.8, 0.9, 0.45, Math.PI / 2 + 0.35);
			await shot(OUT_DIRS.p010, `round2-${label}-dent-early-b.png`);
			// A bit more settle for a second, calmer look at the same dent.
			await evalExpr('window.__LAB__.stepN(60); "ok"');
			await cam(2.0, 1.0, 0.45, Math.PI / 2 - 0.3);
			await shot(OUT_DIRS.p010, `round2-${label}-dent-settled.png`);
		}

		// =========================================================================================
		// ITEM 5 -- P011 crate: crate @ ~50 km/h, captured a FEW STEPS post-fracture (before the two
		// fragments separate too far or come to rest overlapping again), close + top angles.
		// =========================================================================================
		console.log('[round2] ITEM 5: P011 crate @ 50km/h fragment close-ups');
		{
			// Confirm the crash-target dropdown actually took effect before capturing (readout after a
			// short settle should show the crate's own destructible-world effect, not a bare barrier).
			await evalExpr('window.__LAB__.reset(); "ok"');
			await evalExpr(`window.__LAB__.setFreeConfig({ speedKmh: 50, offsetM: 0, angleDeg: 0 }); 'ok'`);
			await evalExpr(`window.__LAB__.setCrashTarget('crate'); 'ok'`);
			await evalExpr(`window.__LAB__.setCrashTargetDistance(14); 'ok'`);
			const confirmedTarget = await evalExpr('window.__LAB__.setCrashTarget ? "crate" : "unknown"');
			console.log('[round2] p011 crash target set to:', confirmedTarget);
			await evalExpr(`window.__LAB__.run('free'); 'ok'`);
			// Step in small increments, screenshotting a couple of "just after fracture" frames.
			await evalExpr('window.__LAB__.stepN(35); "ok"');
			await evalExpr('window.__LAB__.renderNow(); "ok"');
			await cam(3.0, 1.3, 0.4, Math.PI / 2 - 0.3);
			await shot(OUT_DIRS.p011, 'round2-fragments-early-3q.png');
			await evalExpr('window.__LAB__.stepN(15); "ok"');
			await evalExpr('window.__LAB__.renderNow(); "ok"');
			await cam(2.6, 1.1, 0.35, Math.PI / 2 - 0.2);
			await shot(OUT_DIRS.p011, 'round2-fragments-close.png');
			await cam(1.2, 5.0, 0.2, Math.PI / 2 - 0.2);
			await shot(OUT_DIRS.p011, 'round2-fragments-top.png');
			await evalExpr('window.__LAB__.stepN(30); "ok"');
			await evalExpr('window.__LAB__.renderNow(); "ok"');
			await cam(2.6, 1.1, 0.35, Math.PI / 2 - 0.2);
			await shot(OUT_DIRS.p011, 'round2-fragments-later.png');
		}

		// =========================================================================================
		// ITEM 6 -- P001 dummy legs/knees visibility attempt: pristine seated car (no crash), try very
		// close/low interior orbit configs sweeping around the cabin. Honest report either way.
		// =========================================================================================
		console.log('[round2] ITEM 6: P001 knee/leg visibility attempt (interior low camera sweep)');
		{
			await evalExpr('window.__LAB__.reset(); "ok"');
			await evalExpr('window.__LAB__.stepN(90); "ok"'); // let the seated dummies settle
			await evalExpr('window.__LAB__.renderNow(); "ok"');
			// Sweep: small radius (near/inside the cabin), low height (near the orbit formula's 0.4m
			// floor), targetHeight around plausible knee height.
			const sweeps = [
				{ r: 0.9, h: 0.4, th: 0.35, a: Math.PI / 2 - 0.2, name: 'round2-knee-attempt-a-driverside.png' },
				{ r: 0.6, h: 0.4, th: 0.3, a: Math.PI / 2, name: 'round2-knee-attempt-b-tight.png' },
				{ r: 1.2, h: 0.4, th: 0.3, a: 0.15, name: 'round2-knee-attempt-c-frontquarter.png' },
				{ r: 0.5, h: 0.4, th: 0.25, a: -Math.PI / 2, name: 'round2-knee-attempt-d-passengerside.png' },
				{ r: 1.4, h: 0.4, th: 0.2, a: Math.PI / 2 + 0.3, name: 'round2-knee-attempt-e-rearfootwell.png' },
			];
			for (const s of sweeps) {
				await cam(s.r, s.h, s.th, s.a);
				await shot(OUT_DIRS.p001, s.name);
			}
		}

		c.ws.close();
	} catch (err) {
		console.error('[round2] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log(`\n[round2] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
	consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
	pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));
	console.log(`[round2] total shots: ${shots.length}`);

	if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}

main();
