// SPDX-License-Identifier: MIT
//
// Eyes-on verification for the destruction round-2 materials work (playtest issues #1/#2/#3/#6):
//   - real-sized brick wall (194x92x57mm) cracks CRISPLY into clumps (no jelly wobble) when rammed;
//   - freed debris SETTLES instead of spinning forever (angular damping) -- checked by sampling piece
//     displacements twice, seconds apart, and asserting they've gone (nearly) static;
//   - a reset (Shift+R) restores the structures and they DON'T spontaneously collapse afterwards.
// Same headless-Brave CDP harness as verify/feature-buildings.mjs (drive controller ported verbatim).
// Writes screenshot-materials-truth-{intact,breach,settled,reset}.png + console-report-materials-truth.json.
//
// Usage: node verify/materials-truth.mjs   (spawns its own `vite preview`)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9499;
const PREVIEW_PORT = 4199;
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

const DRIVE_TOWARD_SNIPPET = `
window.__driveToward = function (targetX, targetZ, maxSteps, stopDist, throttle, gain) {
  function yawOf(q) {
    const t = { x: 2 * (q.y * 1 - q.z * 0), y: 2 * (q.z * 0 - q.x * 1), z: 2 * (q.x * 0 - q.y * 0) };
    const fwd = { x: 0 + q.w*t.x + (q.y*t.z - q.z*t.y), y: 0 + q.w*t.y + (q.z*t.x - q.x*t.z), z: 1 + q.w*t.z + (q.x*t.y - q.y*t.x) };
    return Math.atan2(fwd.x, fwd.z);
  }
  function wrap(a){ while(a>Math.PI)a-=2*Math.PI; while(a<-Math.PI)a+=2*Math.PI; return a; }
  let i = 0;
  for (; i < maxSteps; i++) {
    const t = window.__GAME__.telemetry, p = t.chassisPos;
    if (Math.hypot(p.x-targetX, p.z-targetZ) < stopDist) break;
    const err = wrap(Math.atan2(targetX-p.x, targetZ-p.z) - yawOf(t.chassisQuat));
    window.__GAME__.setInput({ throttle, brake: 0, steer: Math.max(-1,Math.min(1,-err*gain)), handbrake: false });
    window.__GAME__.stepN(1);
  }
  const f = window.__GAME__.telemetry;
  return { steps: i, finalPos: f.chassisPos, speedKmh: f.speedKmh };
};
'ok';
`;

async function main() {
	console.log('[verify-materials-truth] starting vite preview...');
	const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
	preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
	preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
	await waitForHttp(URL);
	console.log('[verify-materials-truth] preview up at', URL);

	const browser = spawn(
		BROWSER,
		[
			'--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
			'--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
			'--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
			'--window-size=1280,720', '--force-device-scale-factor=1',
			'--user-data-dir=/tmp/game-verify-materials-truth-brave-profile', 'about:blank',
		],
		{ stdio: 'ignore' },
	);

	const consoleErrors = [];
	const pageErrors = [];
	const evalExceptions = [];
	const report = {};
	let exitCode = 0;
	try {
		const c = cdp(await getWsUrl(CDP_PORT));
		await c.ready;
		await c.send('Page.enable');
		await c.send('Runtime.enable');
		await c.send('Log.enable');
		c.ws.addEventListener('message', (ev) => {
			const m = JSON.parse(ev.data);
			if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
			if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
		});
		await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
		await c.send('Page.navigate', { url: URL });
		const evalExpr = (expr) =>
			c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
				if (r?.exceptionDetails) {
					const desc = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
					console.error('[verify-materials-truth] EVAL EXCEPTION:', desc);
					evalExceptions.push(desc);
				}
				return r?.result?.value;
			});
		const shoot = async (name) => {
			await sleep(500);
			const s = await c.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(path.join(OUT_DIR, `screenshot-materials-truth-${name}.png`), Buffer.from(s.data, 'base64'));
			console.log(`[verify-materials-truth] wrote screenshot-materials-truth-${name}.png`);
		};

		let ok = false;
		for (let i = 0; i < 60; i++) {
			if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__GAME__.ready never became true');
		console.log('[verify-materials-truth] game ready');

		report.bodyCount = await evalExpr('window.__GAME__.features.buildings.totalPieceCount()');
		report.brokenBefore = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
		await sleep(1500);
		await evalExpr(DRIVE_TOWARD_SNIPPET);

		// Intact CLOSE-UP of the standing brick wall (x=68,z=20): pull up ~4m in front of it and frame it
		// with the chase cam (looks forward along the car's heading, i.e. straight at the wall) so the
		// real-sized bricks (194x92x57mm) read clearly.
		report.drive1 = await evalExpr('window.__driveToward(68, 15.5, 420, 4.5, 0.5, 1.5)');
		await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); window.__GAME__.stepN(30); "ok"');
		await evalExpr('window.__GAME__.setFixedAngle(null); window.__GAME__.setOrbitView({ radius: 8, height: 3.2, targetHeight: 0.8 }); "ok"');
		await shoot('intact');

		// Ram the wall (crisp cracking). Retry up to 4x until >15 mortar joints crack.
		await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
		report.drive2 = await evalExpr('window.__driveToward(68, 20, 340, 1.5, 0.85, 1.6)');
		let broken = await evalExpr('window.__GAME__.features.buildings.brokenJointCountFor("brick-wall")');
		for (let a = 0; a < 4 && !(broken > 15); a++) {
			await evalExpr('window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(90); "ok"');
			await evalExpr('window.__driveToward(68, 20, 150, 0.5, 0.9, 2)');
			broken = await evalExpr('window.__GAME__.features.buildings.brokenJointCountFor("brick-wall")');
		}
		report.brickBrokenAfterRam = broken;
		console.log('[verify-materials-truth] brick-wall broken joints after ram:', broken);
		await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); "ok"');
		await evalExpr('window.__GAME__.setOrbitView({ radius: 11, height: 4.5, targetHeight: 1 }); window.__GAME__.setFixedAngle(0.785); "ok"');
		await shoot('breach');

		// SETTLE: coast a full second, sample brick displacements, coast ~4s more, sample again.
		// If debris kept spinning/rolling forever, the two samples would differ a lot; settled debris is
		// (nearly) identical between them.
		await evalExpr('window.__GAME__.stepN(60); "ok"');
		const dispsA = await evalExpr('window.__GAME__.features.buildings.pieceDisplacements("brick-wall")');
		await evalExpr('window.__GAME__.stepN(300); "ok"'); // ~5s
		const dispsB = await evalExpr('window.__GAME__.features.buildings.pieceDisplacements("brick-wall")');
		let maxDelta = 0, moved = 0;
		for (let i = 0; i < Math.min(dispsA.length, dispsB.length); i++) {
			if (dispsB[i] > 0.3) moved++;
			maxDelta = Math.max(maxDelta, Math.abs(dispsB[i] - dispsA[i]));
		}
		report.settle = { movedBricks: moved, maxDisplacementDeltaOver5s: maxDelta };
		console.log(`[verify-materials-truth] SETTLE: movedBricks=${moved} maxDispDeltaOver5s=${maxDelta.toFixed(3)}m (small => debris has come to rest)`);
		await shoot('settled');

		// RESET (Shift+R equiv) then let it stand a second -- must not spontaneously collapse (issue #6).
		await evalExpr('window.__GAME__.resetWorld(); "ok"');
		report.brokenAfterReset = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
		await evalExpr('window.__GAME__.stepN(120); "ok"'); // ~2s standing untouched
		report.brokenAfterResetStanding = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
		report.bodyCountAfterReset = await evalExpr('window.__GAME__.features.buildings.totalPieceCount()');
		console.log(`[verify-materials-truth] after reset: broken=${report.brokenAfterReset} -> after 2s standing=${report.brokenAfterResetStanding} (expect 0/0) bodyCount=${report.bodyCountAfterReset}`);
		await evalExpr('window.__GAME__.setOrbitView({ radius: 20, height: 11, targetHeight: 1.5 }); window.__GAME__.setFixedAngle(-2.85); "ok"');
		await shoot('reset');

		c.ws.close();

		// ---- ASSERTIONS ----
		if (report.bodyCount < 200 || report.bodyCount > 260) throw new Error(`buildings body count ${report.bodyCount} outside 200-260`);
		if (report.brokenBefore !== 0) throw new Error(`expected 0 broken before crash, got ${report.brokenBefore}`);
		if (!(report.brickBrokenAfterRam > 15)) throw new Error(`expected >15 brick joints cracked, got ${report.brickBrokenAfterRam}`);
		if (!(report.settle.maxDisplacementDeltaOver5s < 0.75)) throw new Error(`debris still moving 5s after crash (maxDelta=${report.settle.maxDisplacementDeltaOver5s}m) -- did not settle`);
		if (report.brokenAfterReset !== 0) throw new Error(`expected 0 broken after reset, got ${report.brokenAfterReset}`);
		if (report.brokenAfterResetStanding !== 0) throw new Error(`structure collapsed after reset (issue #6): ${report.brokenAfterResetStanding} joints broke standing untouched`);
		if (report.bodyCountAfterReset !== report.bodyCount) throw new Error(`body count changed after reset`);
	} catch (err) {
		console.error('[verify-materials-truth] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log('[verify-materials-truth] console errors:', consoleErrors.length, 'page exceptions:', pageErrors.length);
	consoleErrors.forEach((e, i) => console.log(`  err[${i}] ${e}`));
	pageErrors.forEach((e, i) => console.log(`  exc[${i}] ${e}`));
	writeFileSync(path.join(OUT_DIR, 'console-report-materials-truth.json'), JSON.stringify({ ...report, consoleErrors, pageErrors, evalExceptions, timestamp: new Date().toISOString() }, null, 2));
	if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}
main();
