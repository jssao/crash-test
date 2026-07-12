// FRACTURE eyes-on battery (docs/loom/d1-fracture-material-spec.md §F): drives the REAL game
// (headless Brave via CDP, same harness as verify/destruction-feel.mjs) into (A) a fence line, (B)
// the shed, and (C) the hero mid tree, and captures screenshots proving members actually SNAP into
// pieces (fence rail in two, shed plywood shattered into shards, mid trunk snapped into stump +
// fallen top). Numeric proof rides the new fracture hooks (buildings.totalFracturedPieceCount /
// fracturedPieceCountFor / liveFragmentCount, trees.fracturedMidCount + snapshot().mids[].fractured).
//
// Usage: node verify/fracture-eyeson.mjs   (spawns its own `vite preview` on 4193, CDP on 9453)
// Screenshots + report go to the session scratchpad (SCRATCH below), per the fracture brief.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9453;
const PREVIEW_PORT = 4193;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = process.env.FRACTURE_OUT_DIR
	?? '/private/tmp/claude-501/-Users-jesuscalderon-Documents-crash-test/46951e21-50da-4b66-9aab-09c2276982ee/scratchpad/fracture';
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

// Proportional heading controller with speed cap -- verbatim pattern from verify/feature-trees.mjs.
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
		// STUCK RECOVERY (run-3 lesson: the car wedged nose-first on a forest trunk at 0km/h and every
		// retry stayed pinned): after ~0.5s of no movement under throttle, back straight out (brake=1
		// at standstill engages this game's reverse) for ~0.9s, then resume steering to target.
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
'ok';
`;

async function main() {
	console.log('[fracture-eyeson] starting vite preview...');
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
			'--user-data-dir=/tmp/game-verify-fracture-brave-profile', 'about:blank',
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
					console.error('[fracture-eyeson] EVAL EXCEPTION:', r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
				}
				return r?.result?.value;
			});

		let ok = false;
		for (let i = 0; i < 90; i++) {
			if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
			await sleep(500);
		}
		if (!ok) throw new Error('window.__GAME__.ready never became true');
		console.log('[fracture-eyeson] game ready');
		await sleep(1500);
		await evalExpr(DRIVE_SNIPPET);

		async function shoot(name, radius, height, angle) {
			await evalExpr(`window.__GAME__.setOrbitView({ radius: ${radius}, height: ${height}, targetHeight: 0.8 }); 'ok'`);
			await evalExpr(`window.__GAME__.setFixedAngle(${angle}); 'ok'`);
			await sleep(700);
			const shot = await c.send('Page.captureScreenshot', { format: 'png' });
			writeFileSync(path.join(OUT_DIR, name), Buffer.from(shot.data, 'base64'));
			console.log('[fracture-eyeson] wrote', name);
		}

		// Drive one leg, then come to a FULL STOP so the next leg starts controllable (the first run of
		// this battery chained legs with carried momentum -- the car deflected off the brick wall-left
		// and careened out the gate, missing every target; see fracture-eyeson-report.json history).
		async function legTo(x, z, maxSteps, stopDist, throttle, gain, cap) {
			const r = await evalExpr(`window.__driveToward(${x}, ${z}, ${maxSteps}, ${stopDist}, ${throttle}, ${gain}, ${cap})`);
			await evalExpr('window.__stop(50); "ok"');
			return r;
		}

		// -------------------------------------------------------------------------------------------
		// (A) FENCE RAIL: hit fence-e3 (center 23,46, spans x in [20,26]) at ~40-45km/h via the WIDE
		// east corridor x=26 (clears wall-right's east face x=23.5 at z=20 by ~1.6m and the house
		// corner x>=30 by ~4m). RUN-2 LESSON (report history): the old west route clipped the SHED,
		// fracturing 17 pieces -> 42 live fragments >= the 40 cap -> fracture disabled at the fence,
		// which then weld-popped as legacy. This route touches nothing before the fence.
		// -------------------------------------------------------------------------------------------
		console.log('[fracture-eyeson] (A) fence rail...');
		report.fenceLeg1 = await legTo(26, 12, 500, 3, 0.5, 1.5, 38);
		report.fenceLeg2 = await legTo(26, 39, 500, 3, 0.5, 1.5, 35);
		report.fenceHit = await evalExpr('window.__driveToward(24, 50, 300, 2.5, 0.85, 1.4, 50)');
		await evalExpr('window.__stop(50); "ok"');
		const fenceCount = async () => {
			let n = 0;
			for (const id of ['fence-w3', 'fence-w2', 'fence-w1', 'fence-e1', 'fence-e2', 'fence-e3']) {
				n += await evalExpr(`window.__GAME__.features.buildings.fracturedPieceCountFor('${id}')`);
			}
			return n;
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			report.fenceFracturedTotal = await fenceCount();
			if (report.fenceFracturedTotal > 0) break;
			console.log(`[fracture-eyeson] fence retry ${attempt}: no FENCE piece fractured yet, ramming again...`);
			await legTo(24, 40, 300, 2.5, 0.55, 1.5, 35);
			await evalExpr('window.__driveToward(23, 51, 250, 2.5, 0.9, 1.4, 55); "ok"');
			await evalExpr('window.__stop(50); "ok"');
		}
		report.fenceFracturedByLine = {};
		for (const id of ['fence-w3', 'fence-w2', 'fence-w1', 'fence-e1', 'fence-e2', 'fence-e3']) {
			report.fenceFracturedByLine[id] = await evalExpr(`window.__GAME__.features.buildings.fracturedPieceCountFor('${id}')`);
		}
		report.fenceLiveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
		console.log('[fracture-eyeson] fence fractured:', JSON.stringify(report.fenceFracturedByLine), 'fragments:', report.fenceLiveFragments);
		await shoot('01-fence-rail-snapped-a.png', 8, 3, 2.6);
		await shoot('01-fence-rail-snapped-b.png', 9, 4.5, 4.0);

		// -------------------------------------------------------------------------------------------
		// (B) SHED PLYWOOD: reset, then plow the shed (center -30,34) from the south at ~60km/h.
		// -------------------------------------------------------------------------------------------
		console.log('[fracture-eyeson] (B) shed plywood...');
		await evalExpr('window.__GAME__.setFixedAngle(null); window.__GAME__.resetWorld(); "ok"');
		report.shedLeg1 = await legTo(-30, 8, 600, 3, 0.55, 1.5, 40);
		report.shedHit = await evalExpr('window.__driveToward(-30, 33, 350, 3, 0.85, 1.4, 62)');
		await evalExpr('window.__stop(60); "ok"');
		for (let attempt = 0; attempt < 3; attempt++) {
			report.shedFractured = await evalExpr("window.__GAME__.features.buildings.fracturedPieceCountFor('shed')");
			report.shedBrokenJoints = await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('shed')");
			if (report.shedFractured > 0) break;
			console.log(`[fracture-eyeson] shed retry ${attempt} (brokenJoints=${report.shedBrokenJoints})...`);
			await legTo(-30, 18, 350, 3, 0.55, 1.5, 35);
			await evalExpr('window.__driveToward(-30, 35, 300, 3, 0.85, 1.4, 60); "ok"');
			await evalExpr('window.__stop(60); "ok"');
		}
		report.shedLiveFragments = await evalExpr('window.__GAME__.features.buildings.liveFragmentCount()');
		console.log('[fracture-eyeson] shed fractured pieces:', report.shedFractured, 'brokenJoints:', report.shedBrokenJoints, 'fragments:', report.shedLiveFragments);
		await shoot('02-shed-plywood-shattered-a.png', 9, 4, 0.8);
		await shoot('02-shed-plywood-shattered-b.png', 11, 5.5, 2.4);

		// -------------------------------------------------------------------------------------------
		// (C) MID TREE: reset, then the hero mid tree at MID_SITES[0]=(-72,-40) via its guaranteed-
		// clear south runway (x=-72, z in [-60,-40]); needs >=~55km/h at impact to cross the fell/
		// fracture line, so the final leg caps at 72. Forest legs stay slow (cap 32) for control.
		// -------------------------------------------------------------------------------------------
		console.log('[fracture-eyeson] (C) mid tree...');
		await evalExpr('window.__GAME__.setFixedAngle(null); window.__GAME__.resetWorld(); "ok"');
		report.treeLeg1 = await legTo(-30, -25, 800, 4, 0.5, 1.5, 32);
		report.treeLeg2 = await legTo(-58, -50, 800, 4, 0.5, 1.5, 32);
		report.treeLeg3 = await legTo(-72, -62, 600, 3, 0.5, 1.5, 32);
		// Precision alignment crawl onto the runway centreline (RUN-2 LESSON: ramming at cap 72 from a
		// misaligned start orbits right past the 0.35m trunk -- final pos was 20m west of the tree).
		report.treeAlign = await legTo(-72, -57, 300, 1.2, 0.35, 2.0, 14);
		report.treeHit = await evalExpr('window.__driveToward(-72, -40, 350, 1.2, 1.0, 1.5, 62)');
		await evalExpr('window.__stop(60); "ok"');
		for (let attempt = 0; attempt < 4; attempt++) {
			report.fracturedMids = await evalExpr('window.__GAME__.features.trees.fracturedMidCount()');
			if (report.fracturedMids > 0) break;
			report.treeSnapshotMid0 = await evalExpr('window.__GAME__.features.trees.snapshot().mids[0]');
			console.log(`[fracture-eyeson] tree retry ${attempt} (mid0=${JSON.stringify(report.treeSnapshotMid0)}): re-approaching from the runway...`);
			await legTo(-72, -62, 500, 3, 0.5, 1.5, 30);
			await legTo(-72, -57, 300, 1.2, 0.35, 2.0, 14);
			await evalExpr(`window.__driveToward(-72, -40, 350, 1.2, 1.0, 1.5, ${62 + attempt * 4})`);
			await evalExpr('window.__stop(60); "ok"');
		}
		report.treeSnapshotMid0 = await evalExpr('window.__GAME__.features.trees.snapshot().mids[0]');
		console.log('[fracture-eyeson] fracturedMids:', report.fracturedMids, 'mid0:', JSON.stringify(report.treeSnapshotMid0));
		// Let the flying top piece land before the shot.
		await evalExpr('window.__GAME__.stepN(120); "ok"');
		await shoot('03-mid-tree-snapped-a.png', 11, 4, 5.2);
		await shoot('03-mid-tree-snapped-b.png', 13, 6, 0.9);

		c.ws.close();

		// ---- ASSERTIONS ----
		if (!(report.fenceFracturedTotal > 0)) throw new Error('no fence piece ever fractured');
		if (!(report.shedFractured > 0)) throw new Error('no shed piece ever fractured');
		if (!(report.fracturedMids > 0)) throw new Error('no mid tree ever fractured');
	} catch (err) {
		console.error('[fracture-eyeson] ERROR', err);
		exitCode = 1;
	} finally {
		browser.kill();
		preview.kill();
	}

	console.log('\n[fracture-eyeson] console errors:', consoleErrors.length);
	consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
	console.log('[fracture-eyeson] page exceptions:', pageErrors.length);
	pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

	writeFileSync(path.join(OUT_DIR, 'fracture-eyeson-report.json'), JSON.stringify({ consoleErrors, pageErrors, ...report, timestamp: new Date().toISOString() }, null, 2));
	if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
	process.exit(exitCode);
}

main();
