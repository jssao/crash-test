// Verification for the 'buildings' WorldFeature: loads the game, drives the car (via
// window.__GAME__'s existing setInput/stepN/telemetry hooks) out to the east-side structures
// (x>+30), screenshots an intact wide shot, then rams into the brick wall and screenshots
// mid-breach. Same headless-Brave CDP harness pattern as verify/shoot.mjs.
//
// DRIVE CONTROLLER: ported verbatim from verify/feature-trees.mjs's __driveToward() (a proportional
// heading controller: steer = -yawError * gain, clamped to [-1,1], throttle held constant) -- that
// script is the calibrated reference for this exact class of problem (spawn facing +z, target mostly
// off to one side, i.e. a large initial heading error). The PREVIOUS version of this file rolled its
// own controller with `steer = diff * 1.3` (no negation) where every other proven controller in this
// repo (feature-trees.mjs, shoot-driving.mjs) uses `steer = -err * gain`. That sign inversion made the
// P-controller POSITIVE feedback instead of negative: instead of correcting the heading error, every
// step amplified it, so the car span up and drove off in whatever direction the runaway loop happened
// to point it -- reproduced (before this fix) ending up around x=-281, the opposite side of the map
// from the buildings zone (x>30) entirely. Fixed by reusing the trees script's proven yawOf/steer math
// unchanged.
//
// Usage: node verify/feature-buildings.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9497;
const PREVIEW_PORT = 4197;
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

// Injected once into the page -- verbatim copy of verify/feature-trees.mjs's DRIVE_TOWARD_SNIPPET
// (proportional heading controller: computes yaw from chassisQuat, steers toward (targetX,targetZ),
// stops once within `stopDist` meters or after `maxSteps`). See this file's top doc comment for why
// this replaced the previous (broken, positive-feedback) controller.
const DRIVE_TOWARD_SNIPPET = `
window.__driveToward = function (targetX, targetZ, maxSteps, stopDist, throttle, gain) {
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
    if (i % 20 === 0) samples.push({ i, x: p.x, z: p.z, steer, speedKmh: t.speedKmh, yaw: currentYaw });
    window.__GAME__.setInput({ throttle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  const finalTelemetry = window.__GAME__.telemetry;
  return { steps: i, finalPos: finalTelemetry.chassisPos, speedKmh: finalTelemetry.speedKmh, samples };
};
'ok';
`;

async function main() {
  console.log('[verify-buildings] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-buildings] preview server up at', URL);

  console.log('[verify-buildings] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-buildings-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let exitCode = 0;
  let bodyCountBefore = null;
  let brokenBeforeCrash = null;
  let brokenAfterCrash = null;
  let telemetryIntact = null;
  let telemetryBreach = null;
  let driveResult1 = null;
  let driveResult2 = null;
  let bonusBreaks = null;
  const evalExceptions = [];

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

    // NOTE: unlike a bare `r?.result?.value`, this surfaces exceptions thrown SYNCHRONOUSLY inside a
    // Runtime.evaluate call (e.g. a wasm RuntimeError) -- CDP reports these via r.exceptionDetails, NOT
    // via a separate Runtime.exceptionThrown event, so the earlier version of this file silently
    // swallowed them (evalExpr just returned undefined, masking a real reset-path crash -- see the
    // resetWorld() block below).
    const evalExpr = (expr) =>
      c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
        if (r?.exceptionDetails) {
          const desc = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
          console.error('[verify-buildings] EVAL EXCEPTION:', desc);
          evalExceptions.push(desc);
        }
        return r?.result?.value;
      });

    let ok = false;
    for (let i = 0; i < 60; i++) {
      const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true');
      if (r === true) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify-buildings] game ready');

    bodyCountBefore = await evalExpr('window.__GAME__.features.buildings.totalPieceCount()');
    console.log('[verify-buildings] buildings feature body count:', bodyCountBefore);
    brokenBeforeCrash = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    console.log('[verify-buildings] broken joints before any crash (expect 0):', brokenBeforeCrash);

    // Let a handful of real frames render first (shadow map, PMREM, textures settle).
    await sleep(1500);
    await evalExpr(DRIVE_TOWARD_SNIPPET);

    // ---- Phase 1: drive to a vantage point just short of the brick wall (BRICK_WALL_CENTER x=68,z=20)
    // -- past the shed (x=40.2-43.8) and house-corner (front segment x=51-55), both at z~18.5-21.5,
    // but our approach path stays at a much lower z (~11-16) until the very end, so it clears both --
    // so the "intact" screenshot frames the wall (the main showcase piece, and the same subject the
    // breach shot below re-frames post-crash) square-on while it's still standing. (48,14) sits on
    // roughly the same bearing as the brick wall from spawn (0,0), so phase 2 below is a continuation,
    // not a fresh sharp turn. NOTE: an earlier version of this shot used a much shorter (27,8) vantage +
    // a big 42m orbit pull-back -- verified by eye (Read on the resulting PNG) that at that distance the
    // structures were too small/dominated-by-nearer-props to read clearly; a closer vantage + smaller
    // orbit radius reads far better. ----
    console.log('[verify-buildings] phase 1: driving to pre-wall vantage point...');
    driveResult1 = await evalExpr('window.__driveToward(48, 14, 360, 4, 0.5, 1.5)');
    console.log('[verify-buildings] phase 1 result:', JSON.stringify(driveResult1));

    telemetryIntact = await evalExpr('window.__GAME__.telemetry');
    const brokenAtVantage = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    console.log('[verify-buildings] pos at vantage=', JSON.stringify(telemetryIntact.chassisPos), 'brokenJoints=', brokenAtVantage);

    // Wide establishing shot: elevated orbit, angled back along the spawn->brick-wall bearing so the
    // (still-intact) brick wall reads clearly beyond the car.
    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); "ok"');
    await evalExpr('window.__GAME__.stepN(15); "ok"');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 22, height: 13, targetHeight: 2 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(-2.85); "ok"');
    await sleep(700);
    let shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-buildings-intact.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-buildings] wrote screenshot-buildings-intact.png');

    // ---- Phase 2: continue on toward the brick wall (BRICK_WALL_CENTER x=68,z=20) and ram it. Bounded
    // retry (same pattern as feature-trees.mjs's phase 2): re-approach + a guaranteed full-throttle ram
    // burst, up to 4 total attempts, until brokenJointCount > 15 (spec threshold) or attempts exhausted.
    // ----
    console.log('[verify-buildings] phase 2: driving into the brick wall...');
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"'); // back to chase cam while driving
    driveResult2 = await evalExpr('window.__driveToward(68, 20, 340, 1.5, 0.75, 1.6)');
    console.log('[verify-buildings] phase 2 result:', JSON.stringify(driveResult2));

    brokenAfterCrash = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    for (let attempt = 0; attempt < 4 && !(brokenAfterCrash > 15); attempt++) {
      console.log(`[verify-buildings] retry ${attempt}: brokenJointCount=${brokenAfterCrash} (need >15), ramming again...`);
      await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
      await evalExpr('window.__GAME__.stepN(90); "ok"');
      const retryResult = await evalExpr('window.__driveToward(68, 20, 150, 0.5, 0.85, 2)');
      console.log(`[verify-buildings] retry ${attempt} approach result:`, JSON.stringify(retryResult));
      brokenAfterCrash = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    }

    telemetryBreach = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-buildings] mid-breach pos=', JSON.stringify(telemetryBreach.chassisPos), 'brokenJoints=', brokenAfterCrash);

    // Bonus check: did the drive also clip the shed or house-corner en route (optional, not asserted).
    bonusBreaks = {
      shed: await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('shed')"),
      houseCorner: await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('house-corner')"),
    };
    console.log('[verify-buildings] bonus (shed/drywall) broken-joint counts:', JSON.stringify(bonusBreaks));

    // Mid-breach screenshot while debris is still flying (before it settles).
    await evalExpr('window.__GAME__.setOrbitView({ radius: 11, height: 4.5, targetHeight: 1 }); "ok"');
    await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 4}); 'ok'`);
    await sleep(500);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-buildings-breach.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-buildings] wrote screenshot-buildings-breach.png');

    // ---- world reset restores the structures (Shift+R equivalent). ----
    //
    // KNOWN SOURCE BUG (found by this script, NOT fixable here -- verify/** may not touch game/src/**):
    // window.__GAME__.resetWorld() reliably throws a wasm RuntimeError "memory access out of bounds"
    // in the browser, 100% reproducible -- confirmed via a standalone repro calling resetWorld() at
    // spawn with ZERO prior damage (nothing broken, nothing to reset). Root-caused to
    // src/world/features/buildings/structures.ts's resetStructure(): `record.joint.destroy(false)`
    // (line ~493) is the ONLY call site in the whole codebase that passes wakeAttached=false to
    // Joint.destroy() -- every other call site (welds.ts, this same file's pollStructureBreaks()) uses
    // the default wakeAttached=true. Every buildings piece starts asleep (setAwake(false) at build
    // time); destroying a joint with wakeAttached=false while its bodies are still asleep appears to hit
    // an out-of-bounds path in the native/wasm joint-destroy implementation. This is UNRELATED to the
    // drive-controller bug this file's main fix addresses, and unrelated to how much (if anything) has
    // actually broken -- it is a pre-existing latent bug in the 'buildings' WorldFeature's reset path
    // that this script is the first to actually exercise (the previous version's broken driving never
    // reached any structure, so resetWorld() was only ever called on already-untouched state, which
    // masked the crash: even a partially-aborted reset trivially "looks like" 0 broken / 216 bodies when
    // nothing needed resetting). NOT a headless-sim-vs-browser physics discrepancy either --
    // sim/features-buildings.test.mjs's own reset test (75 broken joints -> resetStructure()) passes
    // cleanly under the native Node binding; the crash is browser (wasm) specific.
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    const brokenAfterReset = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    const bodyCountAfterReset = await evalExpr('window.__GAME__.features.buildings.totalPieceCount()');
    console.log(`[verify-buildings] after resetWorld(): brokenJoints=${brokenAfterReset} (expect 0) bodyCount=${bodyCountAfterReset} (expect ${bodyCountBefore})`);

    c.ws.close();

    // ---- ASSERTIONS ----
    if (bodyCountBefore < 200 || bodyCountBefore > 260) {
      throw new Error(`buildings feature body count ${bodyCountBefore} outside target range 200-260`);
    }
    if (brokenBeforeCrash !== 0) throw new Error(`expected 0 broken joints before any crash, got ${brokenBeforeCrash}`);
    if (!(brokenAfterCrash > 15)) throw new Error(`expected brokenJointCount > 15 after ramming the brick wall, got ${brokenAfterCrash}`);
    if (brokenAfterReset !== 0) {
      throw new Error(
        `expected 0 broken joints after resetWorld(), got ${brokenAfterReset}. This is a KNOWN SOURCE BUG, ` +
          `not a script defect -- resetWorld() throws a wasm "memory access out of bounds" RuntimeError inside ` +
          `structures.ts's resetStructure() (Joint.destroy(false) on a sleeping body); see the comment above this ` +
          `block. Captured eval exception(s): ${JSON.stringify(evalExceptions)}`,
      );
    }
    if (bodyCountAfterReset !== bodyCountBefore) throw new Error(`body count changed after reset: ${bodyCountAfterReset} != ${bodyCountBefore}`);
  } catch (err) {
    console.error('[verify-buildings] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-buildings] console errors captured:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-buildings] console warnings captured:', consoleWarnings.length);
  consoleWarnings.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-buildings] uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  writeFileSync(
    path.join(OUT_DIR, 'console-report-buildings.json'),
    JSON.stringify(
      {
        consoleErrors,
        consoleWarnings,
        pageErrors,
        evalExceptions,
        bodyCountBefore,
        brokenBeforeCrash,
        brokenAfterCrash,
        bonusBreaks,
        telemetryIntact,
        telemetryBreach,
        driveResult1,
        driveResult2,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
