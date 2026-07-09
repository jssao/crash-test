// Scripted SCENARIO BATTERY for the box3d-js crash sandbox (Phase D extended playtest).
// Drives all 8 scenarios from the playtest brief via the SAME CDP-driving-headless-Brave pattern as
// verify/feature-trees.mjs (whose DRIVE_TOWARD_SNIPPET is copied verbatim below -- this file does not
// modify that script, just reuses its proven in-page heading-controller technique). Read-only against
// game/src/**: only calls window.__GAME__ hooks, never touches sim/production source.
//
// Usage: node verify/playtest-battery/battery.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..', '..');
const OUT_DIR = __dirname;

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9530;
const PREVIEW_PORT = 4230;
const URL = `http://localhost:${PREVIEW_PORT}/`;
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

// Copied verbatim from verify/feature-trees.mjs (same technique, not a shared import -- each verify
// script is self-contained per this project's convention).
const DRIVE_TOWARD_SNIPPET = `
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
  function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  let i = 0;
  const samples = [];
  for (; i < maxSteps; i++) {
    const t = window.__GAME__.telemetry;
    const p = t.chassisPos;
    const dist = Math.hypot(p.x - targetX, p.z - targetZ);
    if (dist < stopDist) break;
    const desiredYaw = Math.atan2(targetX - p.x, targetZ - p.z);
    const currentYaw = yawOf(t.chassisQuat);
    const err = wrap(desiredYaw - currentYaw);
    const steer = Math.max(-1, Math.min(1, -err * gain));
    const effectiveThrottle = t.speedKmh > cap ? 0 : throttle;
    if (i % 20 === 0) samples.push({ i, x: p.x, z: p.z, steer, speedKmh: t.speedKmh, effectiveThrottle });
    window.__GAME__.setInput({ throttle: effectiveThrottle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  const finalTelemetry = window.__GAME__.telemetry;
  return { steps: i, finalPos: finalTelemetry.chassisPos, speedKmh: finalTelemetry.speedKmh, samples };
};
window.__straightRun = function (steps, throttle, steer) {
  for (let i = 0; i < steps; i++) {
    window.__GAME__.setInput({ throttle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  return window.__GAME__.telemetry;
};
window.__pressKey = function (code, shiftKey) {
  const down = new KeyboardEvent('keydown', { code, shiftKey: !!shiftKey, bubbles: true });
  const up = new KeyboardEvent('keyup', { code, bubbles: true });
  window.dispatchEvent(down);
  window.dispatchEvent(up);
};
'ok';
`;

async function main() {
  console.log('[battery] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[battery] preview server up at', URL);

  console.log('[battery] launching headless Brave...');
  const browser = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,720',
      '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-battery-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const results = {};
  let exitCode = 0;

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Log.enable');

    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (m.params.type === 'error') consoleErrors.push(text);
        else consoleWarnings.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
      }
    });

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
    const shoot = async (name) => {
      await sleep(400);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(shot.data, 'base64'));
      console.log(`[battery] wrote ${name}.png`);
    };

    let ok = false;
    for (let i = 0; i < 60; i++) {
      const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true');
      if (r === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[battery] game ready');
    await sleep(1500);
    await evalExpr(DRIVE_TOWARD_SNIPPET);

    // ---------------------------------------------------------------------------------------
    // SCENARIO 1: sapling slalom (west, ~30-40km/h), snap >=2
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 1: sapling slalom ===');
    const saplingSites = [[-42, 6], [-48, 14], [-42, 22], [-48, 30], [-42, 38]];
    const s1drives = [];
    for (const [x, z] of saplingSites) {
      let r = await evalExpr(`window.__driveToward(${x}, ${z}, 420, 2.5, 0.45, 1.6, 40)`);
      // Retry once if the budget ran out well short of the target (P-controller occasionally needs a
      // second approach after a wide turn -- same bounded-retry idea as feature-trees.mjs).
      const distShort = Math.hypot(r.finalPos.x - x, r.finalPos.z - z);
      if (distShort > 6) r = await evalExpr(`window.__driveToward(${x}, ${z}, 260, 2.5, 0.45, 1.8, 40)`);
      s1drives.push(r);
    }
    const s1snap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI/6); "ok"');
    await shoot('scenario1-sapling-slalom');
    results.scenario1 = { drives: s1drives.map((d) => ({ steps: d.steps, speedKmh: d.speedKmh, finalPos: d.finalPos })), snapshot: s1snap };
    console.log('[battery] scenario1 saplings broken:', s1snap.saplings.filter((s) => s.broken).length, '/', s1snap.saplings.length);

    // ---------------------------------------------------------------------------------------
    // SCENARIO 2: mid-tree felling at speed; then drive into the falling trunk's path
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 2: mid-tree felling ===');
    await evalExpr('window.__GAME__.resetCar(); "ok"'); // fresh car (trees/world state untouched) so the approach starts unstuck
    await sleep(50);
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    const s2pre = await evalExpr('window.__GAME__.features.trees.snapshot()');
    let s2drive = await evalExpr('window.__driveToward(-55, 20, 380, 2, 0.6, 1.6, 75)');
    let s2snap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    for (let attempt = 0; attempt < 4 && !s2snap.mids.some((m) => m.broken); attempt++) {
      const dist = Math.hypot(s2drive.finalPos.x - -55, s2drive.finalPos.z - 20);
      console.log(`[battery] scenario2 retry ${attempt}: dist-to-target=${dist.toFixed(1)}m speed=${s2drive.speedKmh.toFixed(1)}km/h`);
      s2drive = await evalExpr('window.__driveToward(-55, 20, 200, 1, 0.65, 1.9, 75)');
      s2snap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    }
    const s2midBroken = s2snap.mids.some((m) => m.broken);
    // Continue straight ahead (same heading) to try to drive through the falling trunk's landing zone.
    const s2continue = await evalExpr('window.__straightRun(90, 0.5, 0)');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI/4); "ok"');
    await shoot('scenario2-mid-tree-felled');
    results.scenario2 = { pre: s2pre, drive: { steps: s2drive.steps, speedKmh: s2drive.speedKmh }, midBroken: s2midBroken, snapshot: s2snap, afterContinue: s2continue };
    console.log('[battery] scenario2 midBroken=', s2midBroken, 'speedAtImpact~', s2drive.speedKmh);

    // ---------------------------------------------------------------------------------------
    // SCENARIO 3: large tree full stop at 80-100km/h -- car should total
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 3: large-tree total ===');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    const s3occBefore = await evalExpr('window.__GAME__.features.occupants.seatStates()');
    const s3drive = await evalExpr('window.__driveToward(-66, 12, 340, 2, 0.9, 1.5, 95)');
    const s3damage = (await evalExpr('window.__GAME__.telemetry')).damage;
    const s3occAfter = await evalExpr('window.__GAME__.features.occupants.seatStates()');
    const s3featBodies = await evalExpr('window.__GAME__.featureBodyCount()');
    const s3treesSnap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    await evalExpr('window.__GAME__.stepN(40); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI/3); "ok"');
    await shoot('scenario3-large-tree-total');
    const s3ejectedCount = s3occAfter.filter((o) => o.ejected).length;
    results.scenario3 = { driveSpeedKmh: s3drive.speedKmh, damage: s3damage, ejectedCount: s3ejectedCount, featureBodyCount: s3featBodies, treesSnapshot: s3treesSnap };
    console.log('[battery] scenario3 impactSpeedKmh~', s3drive.speedKmh, 'ejected=', s3ejectedCount, 'damage=', JSON.stringify(s3damage));

    // ---------------------------------------------------------------------------------------
    // SCENARIO 4: buildings tour (east) -- shed, drywall corner, brick wall, fence line
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 4: buildings tour ===');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    const bStructBefore = await evalExpr('window.__GAME__.features.buildings.structures');
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    const bShed = await evalExpr('window.__driveToward(42, 20, 300, 2, 0.6, 1.5, 60)');
    await shoot('scenario4a-shed-hit');
    const bCorner = await evalExpr('window.__driveToward(55, 20, 260, 2, 0.5, 1.6, 60)');
    await shoot('scenario4b-corner-breach');
    const bBrick = await evalExpr('window.__driveToward(68, 20, 300, 2, 0.95, 1.6, 85)');
    await shoot('scenario4c-brick-wall');
    const bFenceNear = await evalExpr('window.__driveToward(80, 14, 260, 2, 0.5, 1.6, 55)');
    await shoot('scenario4d-fence-near');
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    const bFenceFar = await evalExpr('window.__driveToward(80, 30, 260, 2, 0.5, 1.6, 55)');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI/6); "ok"');
    await shoot('scenario4e-fence-far');
    const bAfter = {
      totalBroken: await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()'),
      totalPieces: await evalExpr('window.__GAME__.features.buildings.totalPieceCount()'),
      brokenPerStruct: {},
    };
    for (const s of bStructBefore) {
      bAfter.brokenPerStruct[s.id] = await evalExpr(`window.__GAME__.features.buildings.brokenJointCountFor(${JSON.stringify(s.id)})`);
    }
    results.scenario4 = {
      structuresBefore: bStructBefore,
      drives: { shed: bShed.speedKmh, corner: bCorner.speedKmh, brick: bBrick.speedKmh, fenceNear: bFenceNear.speedKmh, fenceFar: bFenceFar.speedKmh },
      finalPos: { shed: bShed.finalPos, corner: bCorner.finalPos, brick: bBrick.finalPos, fenceNear: bFenceNear.finalPos, fenceFar: bFenceFar.finalPos },
      after: bAfter,
    };
    console.log('[battery] scenario4 broken joints:', JSON.stringify(bAfter.brokenPerStruct));

    // ---------------------------------------------------------------------------------------
    // SCENARIO 5: kicker jump at speed -- airborne rotation preserved, occupants jostle on landing
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 5: kicker jump ===');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    const s5occBefore = await evalExpr('window.__GAME__.features.occupants.seatStates()');
    // Approach lane x=0 clear straight ahead per world/tuning.ts; kicker backZ=43.
    const s5approach = await evalExpr('window.__driveToward(0, 40, 260, 1, 1.0, 1.2, 130)');
    // Sample wheelHeights + telemetry across the jump itself (raw stepping, straight input, no steering).
    const s5airSamples = await evalExpr(`
      (function(){
        const out = [];
        for (let i = 0; i < 90; i++) {
          window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
          window.__GAME__.stepN(1);
          if (i % 5 === 0) {
            const t = window.__GAME__.telemetry;
            const wh = window.__GAME__.wheelHeights();
            out.push({ i, y: t.chassisPos.y, quat: t.chassisQuat, wheelHeights: wh });
          }
        }
        return out;
      })()
    `);
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI/8); "ok"');
    await shoot('scenario5-kicker-airborne-or-landed');
    const s5occAfter = await evalExpr('window.__GAME__.features.occupants.seatStates()');
    results.scenario5 = { approachSpeedKmh: s5approach.speedKmh, airSamples: s5airSamples, occBefore: s5occBefore.map((o) => o.pelvisPos), occAfter: s5occAfter.map((o) => o.pelvisPos) };
    console.log('[battery] scenario5 approachSpeedKmh~', s5approach.speedKmh, 'maxY=', Math.max(...s5airSamples.map((s) => s.y)));

    // ---------------------------------------------------------------------------------------
    // SCENARIO 6: MAX CHAOS -- spawnTestWall + crash(140) frontal, then resetWorld, confirm pristine
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 6: MAX CHAOS ===');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    const preErrCount = consoleErrors.length;
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__GAME__.spawnTestWall(25); "ok"');
    await evalExpr('window.__GAME__.crash(140); "ok"');
    await evalExpr('window.__GAME__.stepN(120); "ok"');
    const s6damage = (await evalExpr('window.__GAME__.telemetry')).damage;
    const s6cardetail = { detachedCount: await evalExpr('window.__GAME__.features.cardetail.detachedCount()') };
    const s6occ = await evalExpr('window.__GAME__.features.occupants.seatStates()');
    const s6ejected = s6occ.filter((o) => o.ejected).length;
    const s6featBodies = await evalExpr('window.__GAME__.featureBodyCount()');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI/5); "ok"');
    await shoot('scenario6-max-chaos');
    const s6errCount = consoleErrors.length - preErrCount;
    console.log('[battery] scenario6 damage=', JSON.stringify(s6damage), 'ejected=', s6ejected, 'cardetailDetached=', s6cardetail.detachedCount, 'newConsoleErrors=', s6errCount);

    // Now resetWorld and confirm pristine.
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    const s6afterReset = {
      featureBodyCount: await evalExpr('window.__GAME__.featureBodyCount()'),
      destructibleDisplacements: await evalExpr('window.__GAME__.destructibleDisplacements()'),
      occSeatStates: await evalExpr('window.__GAME__.features.occupants.seatStates()'),
      cardetailDetached: await evalExpr('window.__GAME__.features.cardetail.detachedCount()'),
    };
    const maxDisp = Math.max(0, ...s6afterReset.destructibleDisplacements);
    const anyStillEjected = s6afterReset.occSeatStates.some((o) => o.ejected);
    results.scenario6 = {
      newConsoleErrors: s6errCount,
      damage: s6damage,
      ejectedCount: s6ejected,
      cardetailDetached: s6cardetail.detachedCount,
      featureBodyCountDuringChaos: s6featBodies,
      afterReset: { featureBodyCount: s6afterReset.featureBodyCount, maxDestructibleDisplacement: maxDisp, anyStillEjected, cardetailDetachedAfterReset: s6afterReset.cardetailDetached },
    };
    console.log('[battery] scenario6 afterReset maxDisp=', maxDisp, 'anyStillEjected=', anyStillEjected, 'cardetailDetachedAfterReset=', s6afterReset.cardetailDetached, 'featureBodyCount=', s6afterReset.featureBodyCount);

    // ---------------------------------------------------------------------------------------
    // SCENARIO 7: legacy destructibles regression -- barrel triangle, crate tower, block walls
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 7: legacy destructibles ===');
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    const s7crateDrive = await evalExpr('window.__driveToward(-16, 34, 260, 2, 0.7, 1.5, 60)');
    const s7dispAfterCrate = await evalExpr('window.__GAME__.destructibleDisplacements()');
    await shoot('scenario7a-crate-tower');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    const s7barrelDrive = await evalExpr('window.__driveToward(16, 34, 260, 2, 0.7, 1.5, 60)');
    const s7dispAfterBarrel = await evalExpr('window.__GAME__.destructibleDisplacements()');
    await shoot('scenario7b-barrel-triangle');
    const moved = (arr) => arr.filter((d) => d > 0.15).length;
    results.scenario7 = {
      crateDriveSpeedKmh: s7crateDrive.speedKmh,
      barrelDriveSpeedKmh: s7barrelDrive.speedKmh,
      bodiesMovedAfterCrate: moved(s7dispAfterCrate),
      bodiesMovedAfterBarrel: moved(s7dispAfterBarrel),
      totalDestructibleBodies: s7dispAfterBarrel.length,
    };
    console.log('[battery] scenario7 bodiesMovedAfterCrate=', results.scenario7.bodiesMovedAfterCrate, 'bodiesMovedAfterBarrel=', results.scenario7.bodiesMovedAfterBarrel, '/', s7dispAfterBarrel.length);

    // ---------------------------------------------------------------------------------------
    // SCENARIO 8: quality cycling + camera toggle + car-only reset, mid-chaos
    // ---------------------------------------------------------------------------------------
    console.log('[battery] === scenario 8: quality/camera/reset mid-chaos ===');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    await evalExpr('window.__GAME__.spawnTestWall(25); "ok"');
    await evalExpr('window.__GAME__.crash(120); "ok"');
    await evalExpr('window.__GAME__.stepN(30); "ok"');
    const preErr8 = consoleErrors.length;
    const qualityBefore = await evalExpr('window.__GAME__.quality');
    await evalExpr('window.__pressKey("KeyQ"); "ok"');
    await evalExpr('window.__GAME__.stepN(10); "ok"');
    await evalExpr('window.__pressKey("KeyQ"); "ok"');
    await evalExpr('window.__GAME__.stepN(10); "ok"');
    const qualityAfterCycle = await evalExpr('window.__GAME__.quality');
    await evalExpr('window.__pressKey("KeyC"); "ok"');
    await evalExpr('window.__GAME__.stepN(10); "ok"');
    await evalExpr('window.__pressKey("KeyR"); "ok"');
    await evalExpr('window.__GAME__.stepN(20); "ok"');
    const s8telemetryFinite = await evalExpr(`
      (function(){
        const t = window.__GAME__.telemetry;
        const vals = [t.chassisPos.x, t.chassisPos.y, t.chassisPos.z, t.speedKmh];
        return vals.every((v) => Number.isFinite(v));
      })()
    `);
    const s8errCount = consoleErrors.length - preErr8;
    await shoot('scenario8-quality-camera-reset-mid-chaos');
    results.scenario8 = { qualityBefore, qualityAfterCycle, telemetryFiniteAfter: s8telemetryFinite, newConsoleErrors: s8errCount };
    console.log('[battery] scenario8 qualityBefore=', qualityBefore, 'qualityAfterCycle=', qualityAfterCycle, 'telemetryFiniteAfter=', s8telemetryFinite, 'newConsoleErrors=', s8errCount);

    c.ws.close();
  } catch (err) {
    console.error('[battery] ERROR', err);
    pageErrors.push(String(err?.stack || err));
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[battery] TOTAL console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[battery] TOTAL console warnings:', consoleWarnings.length);
  console.log('[battery] TOTAL uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  writeFileSync(
    path.join(OUT_DIR, 'battery-report.json'),
    JSON.stringify({ consoleErrors, consoleWarnings, pageErrors, results, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
