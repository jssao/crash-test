// SPDX-License-Identifier: MIT
//
// Eyes-on verify battery for the P009 (utility pole)/P010 (metal barrels)/P011 (wooden crate) bug
// fixes -- same headless-Brave CDP harness as verify/crash-lab.mjs (a `vite preview` server + raw
// DevTools-Protocol WebSocket, no puppeteer), but driving the Crash Lab's single-prop "crash target"
// picker (src/lab/crashTargets.ts's window.__LAB__.setCrashTarget/setCrashTargetDistance) instead of
// its standardized barrier protocols. For each target: select it, set the 'free' protocol's speed,
// run(), and capture approach/impact/post screenshots (car velocity-set at run start, so stepN alone
// drives everything -- no throttle input needed, same convention as every other lab/sim harness).
//
// Usage: node verify/shoot-props.mjs   (spawns its own `vite preview` on 4187, CDP on 9461)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9461;
const PREVIEW_PORT = 4187;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const SCREENSHOTS_ROOT = path.resolve(gameRoot, '..', 'screenshots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
	console.log('[shoot-props] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);

	console.log('[shoot-props] launching headless Brave...');
	const browser = spawn(
		BROWSER,
		[
			'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
			'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
			'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
			'--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-shoot-props-brave-profile', 'about:blank',
		],
		{ stdio: 'ignore' },
	);

	const consoleErrors = [];
	const pageErrors = [];
	let exitCode = 0;
	const report = {};

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
		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });

		const evalExpr = (expr) =>
			c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
				if (r?.exceptionDetails) console.error('[shoot-props] EVAL EXCEPTION:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
				return r?.result?.value;
			});

		let ok = false;
		for (let i = 0; i < 60; i++) {
			if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__LAB__.ready never became true');
		console.log('[shoot-props] lab ready');
		await sleep(800);

		async function shot(outDir, name) {
			mkdirSync(outDir, { recursive: true });
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			const file = path.join(outDir, name);
			writeFileSync(file, Buffer.from(s.data, 'base64'));
			console.log(`[shoot-props] wrote ${file}`);
			return file;
		}

		/** Selects a crash target at a fixed distance, sets the 'free' protocol's speed, runs it, and
		 * captures approach/impact/post screenshots into `outDir`. `impactSteps` is tuned per-target
		 * below (empirically, via a throwaway run watching the readout) to land mid-action. */
		async function runTarget({ id, label, speedKmh, distanceM, cameraPreset, outDir, approachSteps, impactSteps, settleSteps }) {
			console.log(`[shoot-props] === ${label} (${id}, ${speedKmh}km/h) ===`);
			await evalExpr(`window.__LAB__.setCrashTarget('${id}'); 'ok'`);
			await evalExpr(`window.__LAB__.setCrashTargetDistance(${distanceM}); 'ok'`);
			await evalExpr(`window.__LAB__.setFreeConfig({ speedKmh: ${speedKmh}, offsetM: 0, angleDeg: 0 }); 'ok'`);
			await evalExpr(`window.__LAB__.setCameraPreset('${cameraPreset}'); 'ok'`);
			await sleep(300);
			await evalExpr("window.__LAB__.run('free'); 'ok'");

			await evalExpr(`window.__LAB__.stepN(${approachSteps}); 'ok'`);
			await sleep(200);
			await shot(outDir, `${id}-01-approach.png`);

			await evalExpr(`window.__LAB__.stepN(${impactSteps - approachSteps}); 'ok'`);
			await sleep(200);
			await shot(outDir, `${id}-02-impact.png`);

			await evalExpr(`window.__LAB__.stepN(${settleSteps - impactSteps}); 'ok'`);
			await sleep(200);
			await shot(outDir, `${id}-03-post.png`);

			const runState = await evalExpr('window.__LAB__.runState');
			return { runState };
		}

		// ---- P009: utility pole -- 60km/h to reliably snap it at the base (sim-tested at 55km/h). ----
		report.pole = await runTarget({
			id: 'pole', label: 'Utility pole', speedKmh: 60, distanceM: 14, cameraPreset: '3q',
			outDir: path.join(SCREENSHOTS_ROOT, 'P009_utility-pole-crash', 'sim'),
			approachSteps: 40, impactSteps: 140, settleSteps: 420,
		});
		await evalExpr("window.__LAB__.setOrbitView({ radius: 7, height: 3, targetHeight: 0.8 }); 'ok'");
		await sleep(300);
		await shot(path.join(SCREENSHOTS_ROOT, 'P009_utility-pole-crash', 'sim'), 'pole-04-post-closeup.png');

		// ---- P010: metal barrels -- full (blue) vs empty (rust), same 40km/h approach for both, so the
		// two galleries are directly comparable. ----
		report.barrelBlue = await runTarget({
			id: 'barrel-blue', label: 'Blue barrel (full)', speedKmh: 40, distanceM: 12, cameraPreset: '3q',
			outDir: path.join(SCREENSHOTS_ROOT, 'P010_metal-barrels-no-deform', 'sim'),
			approachSteps: 30, impactSteps: 90, settleSteps: 240,
		});
		await evalExpr("window.__LAB__.setOrbitView({ radius: 4, height: 1.6, targetHeight: 0.5 }); 'ok'");
		await sleep(300);
		await shot(path.join(SCREENSHOTS_ROOT, 'P010_metal-barrels-no-deform', 'sim'), 'barrel-blue-04-dent-closeup.png');

		report.barrelRust = await runTarget({
			id: 'barrel-rust', label: 'Rust barrel (empty)', speedKmh: 40, distanceM: 12, cameraPreset: '3q',
			outDir: path.join(SCREENSHOTS_ROOT, 'P010_metal-barrels-no-deform', 'sim'),
			approachSteps: 30, impactSteps: 90, settleSteps: 240,
		});
		await evalExpr("window.__LAB__.setOrbitView({ radius: 4, height: 1.6, targetHeight: 0.5 }); 'ok'");
		await sleep(300);
		await shot(path.join(SCREENSHOTS_ROOT, 'P010_metal-barrels-no-deform', 'sim'), 'barrel-rust-04-dent-closeup.png');

		// ---- P011: wooden crate -- 45km/h hard hit to reliably splinter it (sim-tested). ----
		report.crate = await runTarget({
			id: 'crate', label: 'Wooden crate', speedKmh: 45, distanceM: 12, cameraPreset: '3q',
			outDir: path.join(SCREENSHOTS_ROOT, 'P011_wooden-crate-impact', 'sim'),
			approachSteps: 30, impactSteps: 90, settleSteps: 240,
		});
		await evalExpr("window.__LAB__.setOrbitView({ radius: 5, height: 2.2, targetHeight: 0.4 }); 'ok'");
		await sleep(300);
		await shot(path.join(SCREENSHOTS_ROOT, 'P011_wooden-crate-impact', 'sim'), 'crate-04-post-closeup.png');

		console.log('[shoot-props] per-target runState:', JSON.stringify({ pole: report.pole.runState, barrelBlue: report.barrelBlue.runState, barrelRust: report.barrelRust.runState, crate: report.crate.runState }));

		c.ws.close();
	} catch (err) {
		console.error('[shoot-props] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log(`\n[shoot-props] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
	consoleErrors.slice(0, 20).forEach((e, i) => console.log(`  err[${i}] ${e}`));
	pageErrors.slice(0, 20).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

	writeFileSync(path.join(__dirname, 'shoot-props-report.json'), JSON.stringify({ consoleErrors, pageErrors, ...report, timestamp: new Date().toISOString() }, null, 2));
	if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}

main();
