// P003/P005 fixer verification harness -- adapted from verify/crash-lab.mjs + verify/fracture-fence-only.mjs's
// headless-Brave CDP pattern. Drives the crash-lab (crash-lab.html) 'free' protocol into 'building-fence'
// (P003) and 'building-brick' (P005) crash-lab targets at 50km/h, capturing approach/impact/post screenshots
// for eyes-on comparison against the reference crash photos.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9477;
const PREVIEW_PORT = 4213;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const FENCE_OUT = '/Users/jesuscalderon/Documents/crash test/screenshots/P003_fence-crash/sim';
const BRICK_OUT = '/Users/jesuscalderon/Documents/crash test/screenshots/P005_brick-wall-crash/sim';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(FENCE_OUT, { recursive: true });
mkdirSync(BRICK_OUT, { recursive: true });

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
	console.log('[p003-p005] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);

	console.log('[p003-p005] launching headless Brave...');
	const browser = spawn(BROWSER, [
		'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
		'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
		'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
		'--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-p003-p005-brave-profile', 'about:blank',
	], { stdio: 'ignore' });

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
			if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
			if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
		});
		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });
		const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
			if (r?.exceptionDetails) console.error('[p003-p005] EVAL EXCEPTION:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
			return r?.result?.value;
		});

		let ok = false;
		for (let i = 0; i < 120; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
		if (!ok) throw new Error('window.__LAB__.ready never became true');
		console.log('[p003-p005] lab ready');
		await sleep(1000);

		const shot = async (outDir, name) => {
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(path.join(outDir, name), Buffer.from(s.data, 'base64'));
			console.log(`[p003-p005] wrote ${outDir}/${name}`);
		};

		async function runScenario(targetId, distanceM, speedKmh, outDir, prefix) {
			await evalExpr(`window.__LAB__.selectProtocol('free'); 'ok'`);
			await evalExpr(`window.__LAB__.setFreeConfig({ speedKmh: ${speedKmh}, offsetM: 0, angleDeg: 0 }); 'ok'`);
			await evalExpr(`window.__LAB__.setCrashTargetDistance(${distanceM}); 'ok'`);
			await evalExpr(`window.__LAB__.setCrashTarget('${targetId}'); 'ok'`);
			await sleep(300);

			// APPROACH: target spawned, car not yet launched -- 3q view.
			await evalExpr(`window.__LAB__.setCameraPreset('3q'); 'ok'`);
			await sleep(400);
			await shot(outDir, `${prefix}-01-approach-3q.png`);

			await evalExpr(`window.__LAB__.run('free'); 'ok'`);
			// IMPACT: step forward just enough to reach the target, then a little past first contact.
			await evalExpr('window.__LAB__.stepN(50); "ok"');
			await evalExpr(`window.__LAB__.setCameraPreset('3q'); 'ok'`);
			await sleep(400);
			await shot(outDir, `${prefix}-02-impact-3q.png`);
			await evalExpr(`window.__LAB__.setCameraPreset('side'); 'ok'`);
			await sleep(400);
			await shot(outDir, `${prefix}-02-impact-side.png`);

			// POST: settle a bit further, then top + 3q + side for the aftermath.
			await evalExpr('window.__LAB__.stepN(60); "ok"');
			await evalExpr(`window.__LAB__.setCameraPreset('3q'); 'ok'`);
			await sleep(400);
			await shot(outDir, `${prefix}-03-post-3q.png`);
			await evalExpr(`window.__LAB__.setCameraPreset('top'); 'ok'`);
			await sleep(400);
			await shot(outDir, `${prefix}-03-post-top.png`);
			await evalExpr(`window.__LAB__.setOrbitView({ radius: 5, height: 1.8, targetHeight: 0.5 }); window.__LAB__.setFixedAngle(1.0); 'ok'`);
			await sleep(400);
			await shot(outDir, `${prefix}-03-post-closeup.png`);

			const readout = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
			console.log(`[p003-p005] ${prefix} readout: ${JSON.stringify(readout.crush)}`);
		}

		await runScenario('building-fence', 14, 50, FENCE_OUT, 'fence');
		await runScenario('building-brick', 14, 50, BRICK_OUT, 'brick');

		c.ws.close();
	} catch (err) {
		console.error('[p003-p005] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log(`\n[p003-p005] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
	consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
	pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));
	if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}

main();
