// SPDX-License-Identifier: MIT
//
// Follow-up eyes-on pass for P009/P010/P011: the first pass (verify/shoot-props.mjs) showed the pole
// snap clearly but framed the barrel dent/crate splinters too far away/too late to read well (barrels
// get carried up onto the hood almost immediately, crate fragments scatter out of the default 3q
// frame). This pass (a) reads window.__crashTargetDebug (crashTargets.ts's verify-only hook) to
// confirm each mechanism fired NUMERICALLY, not just by eye, and (b) uses tighter/earlier framing +
// a top-down pass to actually see the debris.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9462;
const PREVIEW_PORT = 4188;
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
	console.log('[shoot-props-2] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);

	console.log('[shoot-props-2] launching headless Brave...');
	const browser = spawn(
		BROWSER,
		[
			'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
			'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
			'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
			'--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-shoot-props-2-brave-profile', 'about:blank',
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
				if (r?.exceptionDetails) console.error('[shoot-props-2] EVAL EXCEPTION:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
				return r?.result?.value;
			});

		let ok = false;
		for (let i = 0; i < 60; i++) {
			if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__LAB__.ready never became true');
		console.log('[shoot-props-2] lab ready');
		await sleep(800);

		async function shot(outDir, name) {
			mkdirSync(outDir, { recursive: true });
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			const file = path.join(outDir, name);
			writeFileSync(file, Buffer.from(s.data, 'base64'));
			console.log(`[shoot-props-2] wrote ${file}`);
			return file;
		}

		// ---- P009 follow-up: TOP preset shows the whole 8.2m pole (the 3q shot cropped its top,
		// hiding the cross-arm) -- confirm the cross-arm/insulator dressing actually renders. ----
		console.log('[shoot-props-2] === pole (cross-arm check) ===');
		await evalExpr("window.__LAB__.setCrashTarget('pole'); 'ok'");
		await evalExpr('window.__LAB__.setCrashTargetDistance(14); "ok"');
		await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
		await evalExpr("window.__LAB__.setOrbitView({ radius: 9, height: 5, targetHeight: 4 }); 'ok'");
		await sleep(500);
		await shot(path.join(SCREENSHOTS_ROOT, 'P009_utility-pole-crash', 'sim'), 'pole-05-crossarm-check.png');

		// ---- P010 follow-up: catch the barrel MUCH sooner after the hit event (before it's carried up
		// onto the hood), from a low, close, side-on angle, and confirm dentedVertexCount > 0 via the
		// debug hook. Run blue then rust back-to-back for a direct side-by-side comparison. ----
		async function barrelFollowup(id, outName) {
			console.log(`[shoot-props-2] === ${id} (early low-angle dent check) ===`);
			await evalExpr(`window.__LAB__.setCrashTarget('${id}'); 'ok'`);
			await evalExpr('window.__LAB__.setCrashTargetDistance(12); "ok"');
			await evalExpr('window.__LAB__.setFreeConfig({ speedKmh: 40, offsetM: 0, angleDeg: 0 }); "ok"');
			await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
			await evalExpr("window.__LAB__.setOrbitView({ radius: 3, height: 0.9, targetHeight: 0.35 }); 'ok'");
			await sleep(300);
			await evalExpr("window.__LAB__.run('free'); 'ok'");

			// Poll for the hit (approach-to-impact takes a bit under 1s at 40km/h over ~8m of free flight).
			let dentedAtStep = -1;
			for (let i = 0; i < 60; i++) {
				await evalExpr('window.__LAB__.stepN(1); "ok"');
				const dented = await evalExpr('window.__crashTargetDebug ? window.__crashTargetDebug.barrelDentedVertexCount() : 0');
				if (dented > 0) { dentedAtStep = i; break; }
			}
			await sleep(200);
			await shot(path.join(SCREENSHOTS_ROOT, 'P010_metal-barrels-no-deform', 'sim'), `${outName}-05-early-dent.png`);
			// A couple more steps -- let it settle a hair more without flying too far out of frame.
			await evalExpr('window.__LAB__.stepN(8); "ok"');
			await sleep(200);
			await shot(path.join(SCREENSHOTS_ROOT, 'P010_metal-barrels-no-deform', 'sim'), `${outName}-06-early-dent-settled.png`);

			const dentedFinal = await evalExpr('window.__crashTargetDebug ? window.__crashTargetDebug.barrelDentedVertexCount() : 0');
			const isFull = await evalExpr('window.__crashTargetDebug ? window.__crashTargetDebug.barrelIsFull() : null');
			const maxDepthM = await evalExpr('window.__crashTargetDebug ? window.__crashTargetDebug.barrelMaxDentDepthM() : null');
			return { dentedAtStep, dentedFinal, isFull, maxDepthM };
		}
		report.barrelBlueFollowup = await barrelFollowup('barrel-blue', 'barrel-blue');
		report.barrelRustFollowup = await barrelFollowup('barrel-rust', 'barrel-rust');

		// ---- P011 follow-up: TOP preset + wider orbit to find where the 2 splinter fragments actually
		// landed, plus confirm fragment count via the debug hook. ----
		console.log('[shoot-props-2] === crate (find the fragments) ===');
		await evalExpr("window.__LAB__.setCrashTarget('crate'); 'ok'");
		await evalExpr('window.__LAB__.setCrashTargetDistance(12); "ok"');
		await evalExpr('window.__LAB__.setFreeConfig({ speedKmh: 45, offsetM: 0, angleDeg: 0 }); "ok"');
		await evalExpr("window.__LAB__.setCameraPreset('top'); 'ok'");
		await evalExpr("window.__LAB__.setOrbitView({ radius: 1.5, height: 10, targetHeight: 0.3 }); 'ok'");
		await sleep(300);
		await evalExpr("window.__LAB__.run('free'); 'ok'");
		await evalExpr('window.__LAB__.stepN(90); "ok"');
		await sleep(300);
		await shot(path.join(SCREENSHOTS_ROOT, 'P011_wooden-crate-impact', 'sim'), 'crate-05-top-impact.png');
		await evalExpr('window.__LAB__.stepN(150); "ok"');
		await sleep(300);
		await shot(path.join(SCREENSHOTS_ROOT, 'P011_wooden-crate-impact', 'sim'), 'crate-06-top-settled.png');
		report.crateFollowup = {
			fractured: await evalExpr('window.__crashTargetDebug ? window.__crashTargetDebug.crateFractured() : null'),
			fragmentCount: await evalExpr('window.__crashTargetDebug ? window.__crashTargetDebug.crateFragmentCount() : null'),
			fragmentPositions: await evalExpr('window.__crashTargetDebug ? JSON.stringify(window.__crashTargetDebug.crateFragmentPositions()) : null'),
		};

		console.log('[shoot-props-2] report:', JSON.stringify(report, null, 2));
		c.ws.close();
	} catch (err) {
		console.error('[shoot-props-2] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log(`\n[shoot-props-2] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
	consoleErrors.slice(0, 20).forEach((e, i) => console.log(`  err[${i}] ${e}`));
	pageErrors.slice(0, 20).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

	writeFileSync(path.join(__dirname, 'shoot-props-2-report.json'), JSON.stringify({ consoleErrors, pageErrors, ...report, timestamp: new Date().toISOString() }, null, 2));
	if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}

main();
