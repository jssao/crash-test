// FRACTURE eyes-on battery, v3 (drive-to-align + boostTo for guaranteed impact speed): drives the
// REAL game (headless Brave via CDP). Uses the PROVEN driveToward controller (verbatim pattern from
// verify/feature-trees.mjs / v1's verify/fracture-eyeson.mjs) to STEER a short controlled approach up
// to each target -- steering itself is fine and necessary for aim -- then calls
// window.__GAME__.boostTo(speedKmh) to set the car's velocity DIRECTLY (no position change) right
// before the final few meters, guaranteeing the impact speed instead of trusting the traction/drag-
// limited drive controller to reach it (v1's mid-tree hit topped out ~32km/h that way, well under the
// ~70km/h fracture threshold). NOTE: an earlier version of this hook (launchAt) also TELEPORTED the
// car's position via Body.setTransform -- box3d's own docs flag that as a "teleport" with "undesirable
// behavior", and it was confirmed here to explode into a multi-hundred-km/h phantom velocity spike
// scaling with teleport distance. boostTo never touches position, only velocity, which is safe.
//
// Captures (A) a fence rail snapped in two, (B) shed plywood shattered, (C) a mid tree snapped into
// stump + fallen trunk -- with featureBodyCount() before/after each hit as fragment-accounting
// evidence, and multiple camera angles per target for the eyes-on read.
//
// Usage: node verify/fracture-launch-eyeson.mjs   (spawns its own `vite preview` on 4195, CDP on 9455)
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9455;
const PREVIEW_PORT = 4195;
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

// Proportional heading controller with speed cap -- verbatim pattern from verify/feature-trees.mjs /
// v1's verify/fracture-eyeson.mjs (proven for the fence/shed approaches already).
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
// Guaranteed-speed dash: align is already done by driveToward (car pointed at target); this sets
// velocity DIRECTLY (window.__GAME__.boostTo, in-place -- no position teleport) then coasts forward
// (zero throttle so the drivetrain doesn't fight the injected velocity) for 'steps' fixed ticks.
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
	log('[launch-eyeson] starting vite preview...');
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
			'--user-data-dir=/tmp/game-verify-fracture-launch-brave-profile', 'about:blank',
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
					console.error('[launch-eyeson] EVAL EXCEPTION:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
				}
				return r?.result?.value;
			});

		let ok = false;
		for (let i = 0; i < 90; i++) {
			if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__GAME__.ready never became true');
		log('[launch-eyeson] game ready, boostTo hook present: ' + (await evalExpr('typeof window.__GAME__.boostTo')));
		await sleep(1000);
		await evalExpr(DRIVE_SNIPPET);

		async function shoot(name, radius, height, angle, targetHeight = 0.8) {
			await evalExpr(`window.__GAME__.setOrbitView({ radius: ${radius}, height: ${height}, targetHeight: ${targetHeight} }); 'ok'`);
			await evalExpr(`window.__GAME__.setFixedAngle(${angle}); 'ok'`);
			await sleep(700);
			const shot = await c.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'));
			log(`[launch-eyeson] wrote ${name}`);
		}

		async function legTo(x, z, maxSteps, stopDist, throttle, gain, cap) {
			const r = await evalExpr(`window.__driveToward(${x}, ${z}, ${maxSteps}, ${stopDist}, ${throttle}, ${gain}, ${cap})`);
			await evalExpr('window.__stop(30); "ok"');
			return r;
		}

		// -----------------------------------------------------------------------------------------
		// (A) FENCE RAIL: fence-e3 center (23,0,46), line runs along X. Approach via the wide east
		// corridor (x=26) that clears wall-right/shed, exactly like v1's proven route, then align to
		// x=24 a few meters short of the line and boostTo(48) to guarantee the impact speed.
		// -----------------------------------------------------------------------------------------
		log('[launch-eyeson] (A) fence rail...');
		report.fenceBodyCountBefore = await evalExpr('window.__GAME__.featureBodyCount()');
		await legTo(26, 12, 500, 3, 0.5, 1.5, 38);
		await legTo(26, 39, 500, 3, 0.5, 1.5, 35);
		report.fenceAlign = await legTo(24, 43, 300, 2.5, 0.5, 1.4, 25);
		// Short punch-through + IMMEDIATE hard brake -- a 2.5kg fence picket barely slows a ~1650kg car,
		// so minimizing dash distance and braking hard right away (rather than a long coast) is what
		// keeps the car's final rest position close to the wreckage for the photo.
		report.fenceDash = await evalExpr('window.__boostDash(48, 14)');
		await evalExpr('window.__stop(70); "ok"');
		report.fenceBodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
		async function fenceSum() {
			const byLine = {};
			for (const id of ['fence-w3', 'fence-w2', 'fence-w1', 'fence-e1', 'fence-e2', 'fence-e3']) {
				byLine[id] = await evalExpr(`window.__GAME__.features.buildings.fracturedPieceCountFor('${id}')`);
			}
			return byLine;
		}
		report.fenceFracturedByLine = await fenceSum();
		report.fenceLiveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
		let fenceSumTotal = Object.values(report.fenceFracturedByLine).reduce((a, b) => a + b, 0);
		log('[launch-eyeson] fence dash: ' + JSON.stringify(report.fenceDash) + ' fractured: ' + JSON.stringify(report.fenceFracturedByLine) + ' fragments: ' + report.fenceLiveFragments + ' bodyCount ' + report.fenceBodyCountBefore + '->' + report.fenceBodyCountAfter);
		for (let attempt = 0; attempt < 3 && fenceSumTotal === 0; attempt++) {
			log(`[launch-eyeson] fence retry ${attempt}: no piece fractured yet, re-approaching and dashing again...`);
			await legTo(24 + attempt, 40, 300, 2.5, 0.5, 1.4, 25);
			report.fenceDashRetry = await evalExpr(`window.__boostDash(${50 + attempt * 6}, 14)`);
			await evalExpr('window.__stop(70); "ok"');
			report.fenceFracturedByLine = await fenceSum();
			report.fenceLiveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
			report.fenceBodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
			fenceSumTotal = Object.values(report.fenceFracturedByLine).reduce((a, b) => a + b, 0);
			log('[launch-eyeson] fence retry result: ' + JSON.stringify(report.fenceFracturedByLine) + ' fragments: ' + report.fenceLiveFragments);
		}
		// Return to the fence's world coordinates for the photo -- the dash/retry momentum can carry
		// the car well past the wreckage, and the orbit camera always follows the CAR (createOrbitUpdater
		// takes the chassis position as its focus), never a fixed world point.
		await legTo(23, 45, 600, 3, 0.45, 1.5, 15);
		await shoot('01-fence-rail-snapped-a.png', 4.5, 1.8, 2.6, 0.5);
		await shoot('01-fence-rail-snapped-b.png', 5.5, 2.6, 4.0, 0.5);
		await shoot('01-fence-rail-snapped-c.png', 3.5, 1.4, 1.2, 0.4);

		// -----------------------------------------------------------------------------------------
		// (B) SHED PLYWOOD: reset, approach the shed (-30,0,34) from the south, align, boostTo(55).
		// -----------------------------------------------------------------------------------------
		log('[launch-eyeson] (B) shed plywood...');
		await evalExpr('window.__GAME__.setFixedAngle(null); window.__GAME__.resetWorld(); "ok"');
		report.shedBodyCountBefore = await evalExpr('window.__GAME__.featureBodyCount()');
		await legTo(-30, 8, 600, 3, 0.55, 1.5, 40);
		report.shedAlign = await legTo(-30, 29, 350, 2.5, 0.5, 1.4, 25);
		// Short punch-through (SHED_DEPTH_M=3, so a few extra meters clears the far wall) + immediate
		// hard brake, same rationale as the fence dash above.
		report.shedDash = await evalExpr('window.__boostDash(55, 22)');
		await evalExpr('window.__stop(70); "ok"');
		report.shedBodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
		report.shedFractured = await evalExpr("window.__GAME__.features.buildings.fracturedPieceCountFor('shed')");
		report.shedBrokenJoints = await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('shed')");
		report.shedLiveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
		log('[launch-eyeson] shed dash: ' + JSON.stringify(report.shedDash) + ' fractured pieces: ' + report.shedFractured + ' brokenJoints: ' + report.shedBrokenJoints + ' fragments: ' + report.shedLiveFragments + ' bodyCount ' + report.shedBodyCountBefore + '->' + report.shedBodyCountAfter);
		if (!(report.shedFractured > 0)) {
			log('[launch-eyeson] shed retry: no fracture yet, dashing again...');
			report.shedDashRetry = await evalExpr('window.__boostDash(60, 22)');
			await evalExpr('window.__stop(70); "ok"');
			report.shedFractured = await evalExpr("window.__GAME__.features.buildings.fracturedPieceCountFor('shed')");
			report.shedBrokenJoints = await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('shed')");
			report.shedLiveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
			report.shedBodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
			log('[launch-eyeson] shed retry result: fractured ' + report.shedFractured + ' joints ' + report.shedBrokenJoints + ' fragments ' + report.shedLiveFragments);
		}
		// Return to the shed's world coordinates for the photo (see fence's identical comment above).
		await legTo(-30, 33, 600, 3, 0.45, 1.5, 15);
		await shoot('02-shed-plywood-shattered-a.png', 5, 2.4, 0.8, 0.9);
		await shoot('02-shed-plywood-shattered-b.png', 6.5, 3.4, 2.4, 0.9);
		await shoot('02-shed-plywood-shattered-c.png', 4, 1.8, -0.6, 0.7);

		// -----------------------------------------------------------------------------------------
		// (C) MID TREE: reset, drive the SAME proven alignment crawl onto the runway centreline at
		// MID_HERO (-72,-40) as v1 (needed for the ~0.35m trunk's precision), then boostTo(88) --
		// well above the ~70km/h fracture threshold, GUARANTEED by direct velocity (not driving).
		// -----------------------------------------------------------------------------------------
		log('[launch-eyeson] (C) mid tree...');
		await evalExpr('window.__GAME__.setFixedAngle(null); window.__GAME__.resetWorld(); "ok"');
		report.treeBodyCountBefore = await evalExpr('window.__GAME__.featureBodyCount()');
		await legTo(-30, -25, 800, 4, 0.5, 1.5, 32);
		await legTo(-58, -50, 800, 4, 0.5, 1.5, 32);
		await legTo(-72, -62, 600, 3, 0.5, 1.5, 32);
		report.treeAlign = await legTo(-72, -57, 300, 1.2, 0.35, 2.0, 14);
		report.treeDash = await evalExpr('window.__boostDash(88, 90)');
		report.treeSpeedAtImpactArea = report.treeDash.speedKmh;
		await evalExpr('window.__GAME__.stepN(120); "ok"'); // let the flying top piece land
		report.treeBodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
		report.fracturedMids = await evalExpr('window.__GAME__.features.trees.fracturedMidCount()');
		report.treeSnapshotMid0 = await evalExpr('window.__GAME__.features.trees.snapshot().mids[0]');
		log('[launch-eyeson] tree dash: ' + JSON.stringify(report.treeDash) + ' fracturedMids: ' + report.fracturedMids + ' mid0: ' + JSON.stringify(report.treeSnapshotMid0) + ' bodyCount ' + report.treeBodyCountBefore + '->' + report.treeBodyCountAfter);
		// The narrow (~0.35m) trunk makes this hit flaky run-to-run (observed: succeeds sometimes,
		// misses others, with IDENTICAL scripted inputs -- box3d's own non-determinism/settle timing,
		// not something this script controls) -- retry several times, nudging speed and re-alignment
		// x slightly each attempt, rather than trusting a single try.
		for (let attempt = 0; attempt < 3 && !(report.fracturedMids > 0); attempt++) {
			log(`[launch-eyeson] tree retry ${attempt}: re-aligning and dashing again...`);
			await legTo(-72, -62, 500, 3, 0.5, 1.5, 30);
			report.treeAlignRetry = await legTo(-72 + (attempt - 1) * 0.15, -57, 300, 1.2, 0.35, 2.0, 14);
			report.treeDashRetry = await evalExpr(`window.__boostDash(${90 + attempt * 5}, 90)`);
			await evalExpr('window.__GAME__.stepN(120); "ok"');
			report.fracturedMids = await evalExpr('window.__GAME__.features.trees.fracturedMidCount()');
			report.treeSnapshotMid0 = await evalExpr('window.__GAME__.features.trees.snapshot().mids[0]');
			report.treeBodyCountAfter = await evalExpr('window.__GAME__.featureBodyCount()');
			log('[launch-eyeson] tree retry result: fracturedMids ' + report.fracturedMids + ' mid0 ' + JSON.stringify(report.treeSnapshotMid0));
		}
		// Return near the impact area for the photo, if the car ended up far from it.
		await evalExpr('window.__stop(30); "ok"');
		await shoot('03-mid-tree-snapped-a.png', 9, 4.5, 5.2, 1.2);
		await shoot('03-mid-tree-snapped-b.png', 8, 4, 0.9, 1.0);
		await shoot('03-mid-tree-snapped-c.png', 7, 3.2, 1.7, 0.9);

		c.ws.close();
	} catch (err) {
		console.error('[launch-eyeson] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log('\n[launch-eyeson] console errors:', consoleErrors.length);
	consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
	console.log('[launch-eyeson] page exceptions:', pageErrors.length);
	pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

	writeFileSync(path.join(OUT_DIR, 'fracture-launch-eyeson-report.json'), JSON.stringify({ consoleErrors, pageErrors, ...report, timestamp: new Date().toISOString() }, null, 2));
	if (pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}

main();
