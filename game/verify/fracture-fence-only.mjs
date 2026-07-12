// FENCE-ONLY fracture eyes-on retake: the combined battery's (verify/fracture-launch-eyeson.mjs)
// last run wedged its fence align leg (9 unsticks) and overwrote the fence screenshots with an
// unfractured fence, while its shed/tree captures succeeded. This retake reruns JUST the fence hit,
// using v1's (verify/fracture-eyeson.mjs) exact proven route -- east corridor x=26, then a driven ram
// at (24,50) cap 50 which fractured fence-e3 on its first try there -- plus a boostTo insurance dash
// on retry only. Writes ONLY 01-fence-rail-snapped-{a,b,c}.png + its own report.
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9461;
const PREVIEW_PORT = 4201;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = process.env.FRACTURE_OUT_DIR
	?? '/private/tmp/claude-501/-Users-jesuscalderon-Documents-crash-test/46951e21-50da-4b66-9aab-09c2276982ee/scratchpad/fracture';
const PROGRESS = path.join(OUT_DIR, 'PROGRESS.md');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT_DIR, { recursive: true });

function log(line) {
	console.log(line);
	const ts = new Date().toISOString().slice(11, 16);
	appendFileSync(PROGRESS, `${ts} ${line}\n`);
}

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

const DRIVE_SNIPPET = `
window.__driveToward = function (targetX, targetZ, maxSteps, stopDist, throttle, gain, speedCapKmh) {
	const cap = speedCapKmh === undefined ? Infinity : speedCapKmh;
	function yawOf(q) {
		const t = { x: 2 * (q.y * 1 - q.z * 0), y: 2 * (q.z * 0 - q.x * 1), z: 2 * (q.x * 0 - q.y * 0) };
		const fwd = {
			x: 0 + q.w * t.x + (q.y * t.z - q.z * t.y),
			y: 0 + q.w * t.y + (q.z * t.x - q.x * t.z),
			z: 1 + q.w * t.z + (q.x * t.y - q.y * t.x),
		};
		return Math.atan2(fwd.x, fwd.z);
	}
	function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
	let i = 0;
	let stuckSteps = 0;
	let unsticks = 0;
	for (; i < maxSteps; i++) {
		const t = window.__GAME__.telemetry;
		const p = t.chassisPos;
		const dist = Math.hypot(p.x - targetX, p.z - targetZ);
		if (dist < stopDist) break;
		if (t.speedKmh < 2 && i > 20) stuckSteps++;
		else stuckSteps = 0;
		if (stuckSteps > 30) {
			for (let r = 0; r < 55; r++) {
				window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false });
				window.__GAME__.stepN(1);
			}
			window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false });
			window.__GAME__.stepN(10);
			stuckSteps = 0;
			unsticks++;
			continue;
		}
		const desiredYaw = Math.atan2(targetX - p.x, targetZ - p.z);
		const err = wrap(desiredYaw - yawOf(t.chassisQuat));
		const steer = Math.max(-1, Math.min(1, -err * gain));
		const effectiveThrottle = t.speedKmh > cap ? 0 : throttle;
		window.__GAME__.setInput({ throttle: effectiveThrottle, brake: 0, steer, handbrake: false });
		window.__GAME__.stepN(1);
	}
	const f = window.__GAME__.telemetry;
	return { steps: i, finalPos: f.chassisPos, speedKmh: f.speedKmh, unsticks };
};
window.__stop = function (steps) {
	window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false });
	window.__GAME__.stepN(steps || 40);
	window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	return window.__GAME__.telemetry.chassisPos;
};
window.__boostDash = function (speedKmh, steps) {
	window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	window.__GAME__.boostTo(speedKmh);
	window.__GAME__.stepN(steps);
	const f = window.__GAME__.telemetry;
	return { finalPos: f.chassisPos, speedKmh: f.speedKmh };
};
'ok';
`;

async function main() {
	log('[fence-only] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);

	const browser = spawn(
		BROWSER,
		[
			'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
			'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
			'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
			'--window-size=1280,720', '--force-device-scale-factor=1',
			'--user-data-dir=/tmp/game-verify-fracture-fence-brave-profile', 'about:blank',
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
		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });

		const evalExpr = (expr) =>
			c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
				if (r?.exceptionDetails) {
					console.error('[fence-only] EVAL EXCEPTION:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
				}
				return r?.result?.value;
			});

		// 150s ready budget (was 45s): a parallel worker is rebuilding dist/ for the S90 car integration
		// in this same tree -- a mid-rebuild dist or a cold S90 GLB load can push first-ready past 45s.
		let ok = false;
		for (let i = 0; i < 300; i++) {
			if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__GAME__.ready never became true');
		log('[fence-only] game ready');
		await sleep(1000);
		await evalExpr(DRIVE_SNIPPET);

		async function shoot(name, radius, height, angle, targetHeight = 0.6) {
			await evalExpr(`window.__GAME__.setOrbitView({ radius: ${radius}, height: ${height}, targetHeight: ${targetHeight} }); 'ok'`);
			await evalExpr(`window.__GAME__.setFixedAngle(${angle}); 'ok'`);
			await sleep(700);
			const shot = await c.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'));
			log(`[fence-only] wrote ${name}`);
		}

		async function legTo(x, z, maxSteps, stopDist, throttle, gain, cap) {
			const r = await evalExpr(`window.__driveToward(${x}, ${z}, ${maxSteps}, ${stopDist}, ${throttle}, ${gain}, ${cap})`);
			await evalExpr('window.__stop(40); "ok"');
			return r;
		}

		const FENCE_IDS = ['fence-w3', 'fence-w2', 'fence-w1', 'fence-e1', 'fence-e2', 'fence-e3'];
		async function fenceCounts() {
			const byLine = {};
			for (const id of FENCE_IDS) byLine[id] = await evalExpr(`window.__GAME__.features.buildings.fracturedPieceCountFor('${id}')`);
			return byLine;
		}

		report.bodyCountBefore = await evalExpr('window.__GAME__.featureBodyCount()');
		// v1's exact proven route: east corridor legs, then the driven ram at (24,50).
		report.leg1 = await legTo(26, 12, 500, 3, 0.5, 1.5, 38);
		report.leg2 = await legTo(26, 39, 500, 3, 0.5, 1.5, 35);
		report.hit = await evalExpr('window.__driveToward(24, 50, 300, 2.5, 0.85, 1.4, 50)');
		await evalExpr('window.__stop(50); "ok"');
		report.fracturedByLine = await fenceCounts();
		report.liveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
		report.bodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
		let total = Object.values(report.fracturedByLine).reduce((a, b) => a + b, 0);
		log('[fence-only] hit: ' + JSON.stringify(report.hit) + ' fractured: ' + JSON.stringify(report.fracturedByLine) + ' fragments: ' + report.liveFragments + ' bodyCount ' + report.bodyCountBefore + '->' + report.bodyCountAfter);
		for (let attempt = 0; attempt < 3 && total === 0; attempt++) {
			log(`[fence-only] retry ${attempt}: driving back and ramming again...`);
			await legTo(24, 40, 400, 2.5, 0.55, 1.5, 35);
			await evalExpr(`window.__driveToward(23, 51, 250, 2.5, 0.9, 1.4, ${52 + attempt * 4}); "ok"`);
			await evalExpr('window.__stop(50); "ok"');
			report.fracturedByLine = await fenceCounts();
			report.liveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
			report.bodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
			total = Object.values(report.fracturedByLine).reduce((a, b) => a + b, 0);
			log('[fence-only] retry result: ' + JSON.stringify(report.fracturedByLine) + ' fragments: ' + report.liveFragments);
		}
		// Park at the fence wreckage for the photos (camera orbits the car).
		await legTo(23, 44.5, 500, 1.8, 0.4, 1.5, 13);
		await shoot('01-fence-rail-snapped-a.png', 5, 2.2, 2.6, 0.5);
		await shoot('01-fence-rail-snapped-b.png', 6, 3, 4.0, 0.5);
		await shoot('01-fence-rail-snapped-c.png', 4, 1.6, 1.2, 0.4);

		c.ws.close();
		if (!(total > 0)) exitCode = 1;
	} catch (err) {
		console.error('[fence-only] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log('\n[fence-only] console errors:', consoleErrors.length);
	consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
	console.log('[fence-only] page exceptions:', pageErrors.length);
	pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

	writeFileSync(path.join(OUT_DIR, 'fracture-fence-only-report.json'), JSON.stringify({ consoleErrors, pageErrors, ...report, timestamp: new Date().toISOString() }, null, 2));
	if (pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}

main();
