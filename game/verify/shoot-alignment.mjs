// Promoted from game/verify/diag/diag-main.ts (was diagnostic-only, unasserted). Boots the same
// standalone vite entry (verify/diag/diag.html -> verify/diag/diag-main.ts, which assembles the SAME
// physics vehicle + SAME car visuals modules main.ts uses), drives headless Brave via CDP, and ASSERTS
// panel/wheel visual-vs-body alignment at spawn, after a full reset, and after a hard (90 km/h) crash
// once broken panels have settled. Exit code gates: 0 only if every assertion holds AND there were zero
// console errors / page exceptions.
//
// What "aligned" means here (see game/src/scene/panelVisuals.ts's module doc comment for the full
// root-cause writeup):
//   - ANGLE delta (visual mesh world rotation vs its physics body's world rotation) must stay under
//     ANGLE_TOL_DEG at every checkpoint, for all 5 panels and all 4 wheels. This is the direct
//     "is the mesh oriented the way its body actually is" check.
//   - POSITION delta is compared as a DEVIATION FROM THE SPAWN BASELINE, not an absolute distance from
//     the body's origin: a panel's physics body is centered on its measured bbox CENTROID (car-map.ts's
//     centerMm), which does not coincide with the GLB mesh's own authored pivot -- so even a perfectly
//     aligned, still-`attached` panel has a real, structural, non-zero raw position delta (measured
//     ~0.67-1.5m depending on the panel). That offset is fixed and expected, not a bug; what a bug looks
//     like is that offset CHANGING once the panel frees and starts moving on its own (the original
//     symptom: "hood posDelta (0.056,-3.135,-0.834)m after a 90 km/h crash", i.e. its offset from the
//     attached-state baseline blew up by ~3m). So this script captures each panel's posDelta magnitude
//     at spawn as ITS OWN baseline, then asserts every later checkpoint stays within POS_TOL_M of that
//     baseline -- exactly "the visual keeps tracking its body", the acceptance criterion's own phrasing.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9431;
const DEV_PORT = 5198;
const URL = `http://localhost:${DEV_PORT}/verify/diag/diag.html`;
const OUT_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANGLE_TOL_DEG = 5;
const POS_TOL_M = 0.05;
const WHEEL_LR_TOL_DEG = 2;

mkdirSync(OUT_DIR, { recursive: true });

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try {
          const r = await fetch(url);
          if (r.ok || r.status === 200) return resolve(true);
        } catch {}
        await sleep(300);
      }
      reject(new Error('dev server never came up'));
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

function vecLen(v) {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Checks one pose dump (dumpPoses() output) against tolerances. `baseline` (posDelta magnitude per
 * panel, captured at spawn) is null for the spawn checkpoint itself (nothing to compare against yet --
 * spawn instead just asserts angle==0-ish, which trivially holds if attached tracking is correct). */
function checkPoses(label, poses, baseline, failures) {
  for (const key of Object.keys(poses.panels)) {
    const p = poses.panels[key];
    if (p.despawnedOrMissing) continue; // nothing to check once despawned
    if (p.angleDeltaDeg > ANGLE_TOL_DEG) {
      failures.push(`[${label}] panel "${key}" angleDeltaDeg=${p.angleDeltaDeg.toFixed(2)} exceeds ${ANGLE_TOL_DEG}deg (state=${p.state})`);
    }
    const mag = vecLen(p.posDelta);
    if (baseline && baseline[key] !== undefined) {
      const drift = Math.abs(mag - baseline[key]);
      if (drift > POS_TOL_M) {
        failures.push(
          `[${label}] panel "${key}" posDelta magnitude drifted ${drift.toFixed(3)}m from its spawn baseline ` +
            `(baseline=${baseline[key].toFixed(3)}m, now=${mag.toFixed(3)}m, state=${p.state}) -- exceeds ${POS_TOL_M}m`,
        );
      }
    }
  }
  for (const key of Object.keys(poses.wheels)) {
    const w = poses.wheels[key];
    if (w.angleDeltaDeg > WHEEL_LR_TOL_DEG) {
      failures.push(`[${label}] wheel "${key}" angleDeltaDeg=${w.angleDeltaDeg.toFixed(2)} exceeds ${WHEEL_LR_TOL_DEG}deg (should be upright at rest)`);
    }
  }
  // FL/FR (and RL/RR) should be visually symmetric -- both near-zero angleDeltaDeg (see above) already
  // implies this, but check the explicit pairwise difference too per the FIX spec's own wording.
  const flfr = Math.abs(poses.wheels.fl.angleDeltaDeg - poses.wheels.fr.angleDeltaDeg);
  if (flfr > WHEEL_LR_TOL_DEG) failures.push(`[${label}] FL/FR wheel angleDeltaDeg mismatch=${flfr.toFixed(2)} exceeds ${WHEEL_LR_TOL_DEG}deg`);
  const rlrr = Math.abs(poses.wheels.rl.angleDeltaDeg - poses.wheels.rr.angleDeltaDeg);
  if (rlrr > WHEEL_LR_TOL_DEG) failures.push(`[${label}] RL/RR wheel angleDeltaDeg mismatch=${rlrr.toFixed(2)} exceeds ${WHEEL_LR_TOL_DEG}deg`);
}

async function main() {
  console.log('[shoot-alignment] starting vite dev server...');
  const dev = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  dev.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  dev.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForHttp(`http://localhost:${DEV_PORT}/`);
  console.log('[shoot-alignment] dev server up');

  console.log('[shoot-alignment] launching headless Brave...');
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
      '--window-size=1024,768',
      '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-alignment-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  const failures = [];
  let exitCode = 0;
  const results = {};

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

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const evalExpr = (expr) =>
      c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
        if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r?.result?.value;
      });

    let ok = false;
    for (let i = 0; i < 60; i++) {
      const r = await evalExpr('window.__DIAG__ && window.__DIAG__.ready === true');
      if (r === true) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__DIAG__.ready never became true');
    console.log('[shoot-alignment] scene ready');

    // ---- Spawn: settle a few steps, dump poses, capture per-panel posDelta baseline ----
    await evalExpr('window.__DIAG__.stepN(30); "ok"');
    results.spawn = await evalExpr('window.__DIAG__.dumpPoses("spawn")');
    const baseline = {};
    for (const key of Object.keys(results.spawn.panels)) baseline[key] = vecLen(results.spawn.panels[key].posDelta);
    checkPoses('spawn', results.spawn, null, failures);
    console.log('[shoot-alignment] spawn baseline posDelta magnitudes:', JSON.stringify(baseline));

    for (const view of ['front', 'side']) {
      await evalExpr(`window.__DIAG__.setCamera('${view}'); window.__DIAG__.render(); 'ok'`);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, `alignment-spawn-${view}.png`), Buffer.from(shot.data, 'base64'));
      console.log(`[shoot-alignment] wrote alignment-spawn-${view}.png`);
    }

    // ---- Full reset (mirrors R key / doCarRepair) ----
    await evalExpr('window.__DIAG__.doFullReset(); "ok"');
    await evalExpr('window.__DIAG__.stepN(5); "ok"');
    results.afterReset = await evalExpr('window.__DIAG__.dumpPoses("afterReset")');
    checkPoses('afterReset', results.afterReset, baseline, failures);

    // ---- Hard crash: wall 12m ahead, 90 km/h, step through impact + settle ----
    await evalExpr('window.__DIAG__.spawnTestWall(12); "ok"');
    await evalExpr('window.__DIAG__.crash(90); "ok"');
    await evalExpr('window.__DIAG__.stepN(240); "ok"'); // 4s @ 60Hz -- reach the wall + settle
    results.afterHardCrash = await evalExpr('window.__DIAG__.dumpPoses("afterHardCrash")');
    results.afterHardCrashTelemetry = await evalExpr('window.__DIAG__.telemetry()');
    checkPoses('afterHardCrash', results.afterHardCrash, baseline, failures);
    console.log('[shoot-alignment] afterHardCrash telemetry:', JSON.stringify(results.afterHardCrashTelemetry.panelStates));

    for (const view of ['front', 'side', 'rear3q']) {
      await evalExpr(`window.__DIAG__.setCamera('${view}'); window.__DIAG__.render(); 'ok'`);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, `alignment-crash-${view}.png`), Buffer.from(shot.data, 'base64'));
      console.log(`[shoot-alignment] wrote alignment-crash-${view}.png`);
    }

    c.ws.close();
  } catch (err) {
    console.error('[shoot-alignment] ERROR', err);
    failures.push(`harness error: ${err.message || err}`);
    exitCode = 1;
  } finally {
    browser.kill();
    dev.kill();
  }

  console.log('\n[shoot-alignment] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[shoot-alignment] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[shoot-alignment] assertion failures:', failures.length);
  failures.forEach((f, i) => console.log(`  [${i}] ${f}`));

  writeFileSync(
    path.join(OUT_DIR, 'console-report-alignment.json'),
    JSON.stringify({ results, consoleErrors, pageErrors, failures, timestamp: new Date().toISOString() }, null, 2),
  );
  console.log('[shoot-alignment] wrote console-report-alignment.json');

  if (consoleErrors.length > 0 || pageErrors.length > 0 || failures.length > 0) exitCode = 1;
  console.log(`[shoot-alignment] ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(exitCode);
}

main();
