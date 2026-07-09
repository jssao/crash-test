// Visual verification for the 'trees' world feature's REDESIGNED visuals (photo-textured foliage
// cards + real bark PBR trunks, replacing the old flat-shaded cone canopy -- see
// game/src/world/features/trees/visuals.ts's module doc). This is a SCREENSHOT/eyes-on script, not
// a physics assertion suite (that's game/verify/feature-trees.mjs's job) -- it drives the car
// (deterministically, via window.__GAME__.setInput()+stepN(), same technique as
// verify/shoot-driving.mjs/feature-trees.mjs) from spawn out to the west forest zone
// (world/features/trees/tuning.ts's FOREST_SCATTER, x in [-172,-58]) using the same
// heading-proportional-controller technique feature-trees.mjs already validated, and captures four
// judgment screenshots:
//   1. trees-visual-forest-interior.png -- forest interior at driving height (default chase cam),
//      several trees in frame at once, en route to the large-tree waypoint below.
//   2. trees-visual-tree-closeup.png -- a single tree (a large tree, most detail) close up, via a
//      tight orbit view.
//   3. trees-visual-mid-felled.png -- a mid tree driven into hard enough to fell it (weld break).
//   4. trees-visual-sapling-snap.png -- a sapling driven into hard enough to snap its joint.
//
// TARGET COORDINATES: feature-trees.mjs's hardcoded targets ((-42,6), (-55,20)) predate the
// terrain-overhaul's forest relocation and no longer correspond to any real tuning.ts site (the
// FOREST_SCATTER zone is now x in [-172,-58], z in [-58,118] -- see tuning.ts's own doc comment).
// This script instead uses the ACTUAL deterministic scatter output (same scatterRng/scatterForest
// algorithm as tuning.ts, reproduced here read-only -- this file does not import tuning.ts's
// internals, it recomputes the same public, seeded, deterministic sequence to pick real waypoints):
// large[2] (a large tree reasonably close to spawn), its nearest mid tree, and its nearest sapling.
//
// Usage: node verify/trees-visual.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9700;
const PREVIEW_PORT = 4400;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = path.join(gameRoot, 'verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

// ---- Recompute the real current forest scatter (read-only reproduction of tuning.ts's own
// deterministic algorithm -- see that file's scatterRng/scatterForest/FOREST_SCATTER/LARGE_COUNT/
// MID_COUNT) so this script's driving waypoints track wherever the trees ACTUALLY are, instead of
// going stale like feature-trees.mjs's hardcoded targets did after the forest was relocated. ----
function scatterRng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function scatterForest(count) {
  const rng = scatterRng(0xf0e57);
  const xMin = -172, xMax = -58, zMin = -58, zMax = 118;
  const minDist2 = 6.5 * 6.5;
  const pts = [];
  let attempts = 0;
  while (pts.length < count && attempts < 40000) {
    attempts++;
    const x = xMin + rng() * (xMax - xMin);
    const z = zMin + rng() * (zMax - zMin);
    let ok = true;
    for (const p of pts) {
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < minDist2) { ok = false; break; }
    }
    if (ok) pts.push({ x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 });
  }
  return pts;
}
const FOREST_SCATTER = scatterForest(44);
const LARGE_COUNT = 7, MID_COUNT = 13;
const LARGE_SITES = FOREST_SCATTER.slice(0, LARGE_COUNT);
const MID_SITES = FOREST_SCATTER.slice(LARGE_COUNT, LARGE_COUNT + MID_COUNT);
const SAPLING_SITES = FOREST_SCATTER.slice(LARGE_COUNT + MID_COUNT);
function dist(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }
const LARGE_TARGET = LARGE_SITES[2]; // a large tree reasonably close to spawn (~78m)
const MID_TARGET = [...MID_SITES].sort((a, b) => dist(a, LARGE_TARGET) - dist(b, LARGE_TARGET))[0];
const SAPLING_TARGET = [...SAPLING_SITES].sort((a, b) => dist(a, LARGE_TARGET) - dist(b, LARGE_TARGET))[0];

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

// Same in-page heading-proportional drive-toward controller as feature-trees.mjs (see that file's
// doc comment for the full rationale/speed-cap history) -- reproduced here rather than imported
// since it is a small self-contained page-injected snippet, not a shared module.
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
    window.__GAME__.setInput({ throttle: effectiveThrottle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  const finalTelemetry = window.__GAME__.telemetry;
  return { steps: i, finalPos: finalTelemetry.chassisPos, speedKmh: finalTelemetry.speedKmh };
};

// Straight reverse (brake pedal doubles as reverse below REVERSE_ENGAGE_SPEED_MS -- see
// vehicle.ts's wantReverse) for a fixed step count, no steering -- used to buy enough straight-line
// runway to actually REACH a fell/break-threshold speed before charging back in (real 0-55km/h needs
// ~24m of runway given this car's tuned accel -- a tight close-up stop leaves no room otherwise).
window.__reverseStraight = function (steps) {
  for (let i = 0; i < steps; i++) {
    window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false });
    window.__GAME__.stepN(1);
  }
  window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false });
  window.__GAME__.stepN(20); // settle to a near-stop before charging forward
  const t = window.__GAME__.telemetry;
  return { pos: t.chassisPos, speedKmh: t.speedKmh };
};

// Aims PAST (targetX,targetZ) by overshootM (computed once, from the CURRENT position, at call
// time) so the heading-proportional controller never decelerates/steers-corrects AT the target --
// it just charges straight through the impact point at full commanded throttle. Runs the full
// maxSteps (no early stop) since the whole point is to guarantee a real high-speed impact.
window.__driveThrough = function (targetX, targetZ, overshootM, maxSteps, throttle, gain, speedCapKmh) {
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
  const p0 = window.__GAME__.telemetry.chassisPos;
  const dx = targetX - p0.x, dz = targetZ - p0.z;
  const d0 = Math.hypot(dx, dz) || 1;
  const aimX = targetX + (dx / d0) * overshootM;
  const aimZ = targetZ + (dz / d0) * overshootM;
  let closestDist = Infinity;
  let i = 0;
  for (; i < maxSteps; i++) {
    const t = window.__GAME__.telemetry;
    const p = t.chassisPos;
    closestDist = Math.min(closestDist, Math.hypot(p.x - targetX, p.z - targetZ));
    const desiredYaw = Math.atan2(aimX - p.x, aimZ - p.z);
    const currentYaw = yawOf(t.chassisQuat);
    const err = wrap(desiredYaw - currentYaw);
    const steer = Math.max(-1, Math.min(1, -err * gain));
    const effectiveThrottle = t.speedKmh > cap ? 0 : throttle;
    window.__GAME__.setInput({ throttle: effectiveThrottle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  const finalTelemetry = window.__GAME__.telemetry;
  return { steps: i, finalPos: finalTelemetry.chassisPos, speedKmh: finalTelemetry.speedKmh, closestDist, aim: { aimX, aimZ } };
};
'ok';
`;

async function main() {
  console.log('[trees-visual] waypoints:', JSON.stringify({ LARGE_TARGET, MID_TARGET, SAPLING_TARGET }));
  console.log('[trees-visual] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[trees-visual] preview server up at', URL);

  console.log('[trees-visual] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-trees-visual-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let exitCode = 0;
  const report = { waypoints: { LARGE_TARGET, MID_TARGET, SAPLING_TARGET } };

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

    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
      if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r?.result?.value;
    });

    let ok = false;
    for (let i = 0; i < 60; i++) {
      const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true').catch(() => false);
      if (r === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[trees-visual] game ready, quality =', await evalExpr('window.__GAME__.quality'));

    await sleep(1500); // let real frames render first (shadow map/PMREM/textures settle)
    await evalExpr(DRIVE_TOWARD_SNIPPET);

    // ---- Screenshot 1: forest interior, driving height, default chase cam ----
    console.log('[trees-visual] phase 1: driving toward the large tree, stopping short for an establishing shot...');
    report.drivePhase1 = await evalExpr(`window.__driveToward(${LARGE_TARGET.x}, ${LARGE_TARGET.z}, 900, 22, 0.55, 1.6, 50)`);
    console.log('[trees-visual] phase 1 result:', JSON.stringify(report.drivePhase1));
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(30); "ok"');
    await sleep(600);
    report.renderStatsForestInterior = await evalExpr(`({
      renderCalls: window.__GAME__.renderer.info.render.calls,
      triangles: window.__GAME__.renderer.info.render.triangles,
    })`);
    const shot1 = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'trees-visual-forest-interior.png'), Buffer.from(shot1.data, 'base64'));
    console.log('[trees-visual] wrote trees-visual-forest-interior.png, renderStats:', JSON.stringify(report.renderStatsForestInterior));

    // ---- Screenshot 2: single tree close-up (tight orbit on the same large tree) ----
    console.log('[trees-visual] phase 2: closing in on the large tree for a close-up...');
    report.drivePhase2 = await evalExpr(`window.__driveToward(${LARGE_TARGET.x}, ${LARGE_TARGET.z}, 300, 6, 0.4, 1.8, 30)`);
    console.log('[trees-visual] phase 2 result:', JSON.stringify(report.drivePhase2));
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(30); "ok"');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 9, height: 4, angularSpeed: 0, targetHeight: 2.5 }); "ok"');
    await sleep(700);
    const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'trees-visual-tree-closeup.png'), Buffer.from(shot2.data, 'base64'));
    console.log('[trees-visual] wrote trees-visual-tree-closeup.png');

    // ---- Screenshot 3: mid tree felled ----
    // A tight close-up stop leaves no runway to reach fell speed (MID_FORCE_THRESHOLD_N needs
    // ~55km/h, which needs ~24m of straight runway given this car's tuned accel) -- back straight
    // away first (brake pedal doubles as reverse below REVERSE_ENGAGE_SPEED_MS, see vehicle.ts),
    // then charge through with an aim point PAST the tree (__driveThrough) so the controller never
    // decelerates/steers-corrects right at the impact point.
    console.log('[trees-visual] phase 3: backing up for runway, then ramming the nearest mid tree...');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 120, height: 70, angularSpeed: 0, targetHeight: 0 }); "ok"'); // back off while approaching
    report.reverse3 = await evalExpr('window.__reverseStraight(90)');
    console.log('[trees-visual] reverse result:', JSON.stringify(report.reverse3));
    report.drivePhase3 = await evalExpr(`window.__driveThrough(${MID_TARGET.x}, ${MID_TARGET.z}, 25, 260, 1.0, 2.2, 90)`);
    console.log('[trees-visual] phase 3 result:', JSON.stringify(report.drivePhase3));
    let treesSnap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    for (let attempt = 0; attempt < 3 && !treesSnap.mids.some((m) => m.broken); attempt++) {
      console.log(`[trees-visual] phase 3 retry ${attempt}: mid tree not yet broken, backing up + ramming again...`);
      await evalExpr('window.__reverseStraight(90)');
      const retry = await evalExpr(`window.__driveThrough(${MID_TARGET.x}, ${MID_TARGET.z}, 25, 260, 1.0, 2.2, 90)`);
      console.log('[trees-visual] retry result:', JSON.stringify(retry));
      treesSnap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    }
    report.treesSnapshotAfterMid = treesSnap;
    console.log('[trees-visual] trees snapshot after mid approach:', JSON.stringify(treesSnap));
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(60); "ok"');
    // Bring the camera back in close (the radius:120/height:70 pull-back above was only meant to
    // avoid a distracting close view WHILE ramming) for a proper close-in "after" shot.
    await evalExpr('window.__GAME__.setOrbitView({ radius: 13, height: 5, angularSpeed: 0, targetHeight: 1.5 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI / 4); "ok"');
    await sleep(700);
    const shot3 = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'trees-visual-mid-felled.png'), Buffer.from(shot3.data, 'base64'));
    console.log('[trees-visual] wrote trees-visual-mid-felled.png');

    // ---- Screenshot 4: sapling snap aftermath ----
    // Saplings snap at a much lower threshold (SAPLING_FORCE_THRESHOLD_N, ~30km/h+) but the same
    // back-up-then-ram technique is used for consistency/reliability.
    console.log('[trees-visual] phase 4: backing up for runway, then ramming the nearest sapling...');
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    report.reverse4 = await evalExpr('window.__reverseStraight(70)');
    console.log('[trees-visual] reverse result:', JSON.stringify(report.reverse4));
    report.drivePhase4 = await evalExpr(`window.__driveThrough(${SAPLING_TARGET.x}, ${SAPLING_TARGET.z}, 20, 260, 0.85, 2.2, 70)`);
    console.log('[trees-visual] phase 4 result:', JSON.stringify(report.drivePhase4));
    treesSnap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    for (let attempt = 0; attempt < 3 && !treesSnap.saplings.some((s) => s.broken); attempt++) {
      console.log(`[trees-visual] phase 4 retry ${attempt}: sapling not yet broken, backing up + ramming again...`);
      await evalExpr('window.__reverseStraight(70)');
      const retry = await evalExpr(`window.__driveThrough(${SAPLING_TARGET.x}, ${SAPLING_TARGET.z}, 20, 260, 0.85, 2.2, 70)`);
      console.log('[trees-visual] retry result:', JSON.stringify(retry));
      treesSnap = await evalExpr('window.__GAME__.features.trees.snapshot()');
    }
    report.treesSnapshotAfterSapling = treesSnap;
    console.log('[trees-visual] trees snapshot after sapling approach:', JSON.stringify(treesSnap));
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(40); "ok"');
    // setFixedAngle(null) alone does NOT reset a previously-set orbit radius/height (only clears the
    // fixed azimuth) -- explicitly re-frame close for this shot too (see the shot3 fix above).
    await evalExpr('window.__GAME__.setOrbitView({ radius: 8, height: 3.5, angularSpeed: 0, targetHeight: 1 }); "ok"');
    await sleep(700);
    const shot4 = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'trees-visual-sapling-snap.png'), Buffer.from(shot4.data, 'base64'));
    console.log('[trees-visual] wrote trees-visual-sapling-snap.png');

    c.ws.close();
  } catch (err) {
    console.error('[trees-visual] ERROR', err);
    report.error = String((err && err.message) || err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  report.consoleErrors = consoleErrors;
  report.consoleWarnings = consoleWarnings;
  report.pageErrors = pageErrors;
  report.timestamp = new Date().toISOString();
  console.log('\n[trees-visual] console errors:', consoleErrors.length, 'warnings:', consoleWarnings.length, 'page exceptions:', pageErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [err ${i}] ${e}`));
  pageErrors.forEach((e, i) => console.log(`  [exc ${i}] ${e}`));

  writeFileSync(path.join(OUT_DIR, 'console-report-trees-visual.json'), JSON.stringify(report, null, 2));

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
