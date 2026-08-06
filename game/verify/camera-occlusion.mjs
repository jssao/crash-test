// Headless-WebGL verification for the Tier-2 camera-occlusion pullback (src/camera/occlusion.ts,
// wired into camera/chase.ts's ChaseCamera and scene/cameraOrbit.ts's UserOrbitController). Same raw-
// CDP-over-headless-Brave pattern as verify/camera-drag.mjs (see that file's header comment for why)
// -- own CDP/preview ports so it can run concurrently with the other verify/*.mjs scripts and the
// user's live `vite preview` on :4173.
//
// SCENARIO (stationary, deterministic -- no driving needed): the car never moves off its spawn pose,
// so window.__GAME__.spawnTestWall(distanceAhead) -- a static box placed at
// vehicle.spawnPosition + forward*distanceAhead, the SAME playtest hook damage/scenario.ts already
// exposes for wall-impact tests -- can drop a real (untagged) obstacle at an EXACT, repeatable spot
// relative to the car by using a NEGATIVE distanceAhead (i.e. behind the car, along -forward): this is
// exactly where the chase camera sits (carPosition - forward*distanceBack + up*heightUp), and exactly
// what a shed/tree/building would occlude in the real game. distanceAhead=-4 lands the wall between
// the car (z=0) and the chase camera's desired position (~z=-6), guaranteeing occlusion; spawning a
// second wall far away (distanceAhead=2000) replaces it (spawnTestWall's own "replace" semantics --
// main.ts's testWallBody doc comment) with nothing in the way, so the SAME live camera can be watched
// recovering smoothly, not just reset.
//
// Asserts (via window.__GAME__.cameraDebug() + .telemetry.chassisPos):
//   1. Chase mode: with a wall behind the car, camera-to-car distance shortens vs. the unoccluded
//      baseline, and cameraDebug().occluded reports true.
//   2. Chase mode: moving the wall away lets the distance recover back out near the baseline, and
//      occluded reports false again.
//   3. Orbit mode (drag-activated user-orbit, per the brief's "clamp against occlusion so drag-orbit
//      doesn't clip into the shed"): with the SAME wall back in place and the orbit radius zoomed out
//      well past the wall, the RENDERED camera distance stays clamped short of the (much larger)
//      dragged radius, and recovers to it once the wall is moved away again.
//
// Usage: node verify/camera-occlusion.mjs   (spawns its own `vite preview` instance)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9432;
const PREVIEW_PORT = 4179;
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

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log('[verify] OK:', msg);
}

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

async function main() {
  console.log('[verify] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify] preview server up at', URL);

  console.log('[verify] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-camera-occlusion-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let exitCode = 0;

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await c.send('Input.setIgnoreInputEvents', { ignore: false });

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

    let ok = false;
    // 90s budget: a cold SwiftShader boot of the FULL game (25MB GLB + HDRI env bake + world build)
    // measures ~28-30s on this machine -- the old 30s budget made ready-or-not a coin flip.
    for (let i = 0; i < 180; i++) {
      const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true');
      if (r === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify] game ready');

    await sleep(1000); // let a handful of real frames render + the chase camera settle first

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(OUT_DIR, `screenshot-camera-occlusion-${name}.png`);
      writeFileSync(outPath, Buffer.from(s.data, 'base64'));
      console.log('[verify] wrote', outPath, `(${s.data.length} b64 chars)`);
    };

    const carToCameraDist = async () => {
      const [dbg, chassisPos] = await Promise.all([
        evalExpr('window.__GAME__.cameraDebug()'),
        evalExpr('window.__GAME__.telemetry.chassisPos'),
      ]);
      return { dbg, dist: dist3(dbg.position, [chassisPos.x, chassisPos.y, chassisPos.z]) };
    };

    // Headless rAF timing is noisier than a real display (occasionally throttled/coalesced), so the
    // damped recovery's exact wall-clock settle time varies run to run. Poll for convergence instead
    // of trusting one fixed sleep -- same intent as a fixed wait, just robust to that jitter.
    const waitUntilClose = async (targetOf, maxWaitMs, tolerance) => {
      const start = Date.now();
      let last = await carToCameraDist();
      while (Date.now() - start < maxWaitMs) {
        if (Math.abs(last.dist - targetOf(last)) < tolerance) return last;
        await sleep(300);
        last = await carToCameraDist();
      }
      return last;
    };

    // ==== Phase 1: chase-mode occlusion pullback + recovery ====

    const baseline = await carToCameraDist();
    console.log('[verify] chase baseline:', JSON.stringify(baseline));
    assert(baseline.dbg.mode === 'chase', `starts in chase mode (got ${baseline.dbg.mode})`);
    assert(baseline.dbg.occluded === false, 'unoccluded baseline: cameraDebug().occluded is false');
    assert(baseline.dist > 5.5 && baseline.dist < 7, `unoccluded chase distance is the nominal ~6.3m (back 6m + up 2m) (got ${baseline.dist.toFixed(2)})`);
    await shot('chase-clear-before');

    console.log('[verify] spawning a wall 4m behind the car (between car and chase camera)...');
    await evalExpr('window.__GAME__.spawnTestWall(-4)');
    await sleep(1500); // occlusion pull-in (fast) + chase spring settle

    const occludedChase = await carToCameraDist();
    console.log('[verify] chase occluded:', JSON.stringify(occludedChase));
    assert(occludedChase.dbg.occluded === true, 'cameraDebug().occluded is true with a wall behind the car');
    assert(occludedChase.dist < baseline.dist - 1.0, `camera distance shortens with the wall in the way (${baseline.dist.toFixed(2)}m -> ${occludedChase.dist.toFixed(2)}m)`);
    assert(occludedChase.dist > 1.0, `pulled-in distance still clears the car itself, not zero (got ${occludedChase.dist.toFixed(2)}m)`);
    await shot('chase-occluded-inside-the-gap');

    console.log('[verify] moving the wall far away (path clears)...');
    await evalExpr('window.__GAME__.spawnTestWall(2000)');
    // Damped recovery is deliberately SLOWER than pull-in (no jitter/yo-yo on a briefly-cleared path)
    // -- poll for it rather than trust one fixed sleep (headless rAF timing is noisier than a real
    // display).
    const recoveredChase = await waitUntilClose(() => baseline.dist, 8000, 0.5);
    console.log('[verify] chase recovered:', JSON.stringify(recoveredChase));
    assert(recoveredChase.dbg.occluded === false, 'cameraDebug().occluded returns to false once the wall clears');
    assert(Math.abs(recoveredChase.dist - baseline.dist) < 0.5, `camera distance recovers back near the unoccluded baseline (${baseline.dist.toFixed(2)}m vs recovered ${recoveredChase.dist.toFixed(2)}m)`);
    await shot('chase-clear-after');

    // ==== Phase 2: drag-orbit occlusion clamp ====
    // Re-place the wall (still 4m behind spawn -- the car hasn't moved), then take over the camera
    // with a near-zero drag: the user-orbit controller SEEDS its azimuth from the chase camera's
    // live pose (main.ts's "TAKEOVER SEED" fix, sphericalFromCameraPose()) -- which is already
    // pointing straight back along -forward, the SAME axis the wall sits on -- so a negligible drag
    // activates orbit mode without meaningfully changing that azimuth.
    console.log('[verify] spawning the wall again, then taking over with a drag (near-zero delta)...');
    await evalExpr('window.__GAME__.spawnTestWall(-4)');
    await sleep(300);
    const CX = 640, CY = 360;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: CX, y: CY, button: 'left', buttons: 1, clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: CX + 1, y: CY, button: 'left', buttons: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: CX + 1, y: CY, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(400);

    const afterTakeover = await evalExpr('window.__GAME__.cameraDebug()');
    assert(afterTakeover.mode === 'orbit', `drag switches to orbit mode (got ${afterTakeover.mode})`);
    assert(afterTakeover.userOrbitActive === true, 'user-orbit active after the takeover drag');

    console.log('[verify] zooming way out (radius should end up well past the wall)...');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: CX, y: CY, deltaX: 0, deltaY: 3000 });
    await sleep(1000);

    const orbitOccluded = await carToCameraDist();
    console.log('[verify] orbit occluded:', JSON.stringify(orbitOccluded));
    assert(orbitOccluded.dbg.radius > 15, `zoomed-out target radius is well past the wall (got ${orbitOccluded.dbg.radius.toFixed(2)}m)`);
    assert(orbitOccluded.dbg.occluded === true, 'cameraDebug().occluded is true once the dragged radius exceeds the wall distance');
    assert(orbitOccluded.dist < orbitOccluded.dbg.radius - 2, `rendered orbit camera distance stays clamped short of the dragged radius (radius=${orbitOccluded.dbg.radius.toFixed(2)}m, rendered=${orbitOccluded.dist.toFixed(2)}m)`);
    await shot('orbit-occluded-inside-the-gap');

    console.log('[verify] moving the wall away again (orbit path clears)...');
    await evalExpr('window.__GAME__.spawnTestWall(2000)');
    const orbitRecovered = await waitUntilClose((last) => last.dbg.radius, 8000, 0.5);
    console.log('[verify] orbit recovered:', JSON.stringify(orbitRecovered));
    assert(orbitRecovered.dbg.occluded === false, 'cameraDebug().occluded returns to false once the wall clears (orbit mode)');
    assert(Math.abs(orbitRecovered.dist - orbitRecovered.dbg.radius) < 0.5, `rendered orbit distance recovers back out to the dragged radius (radius=${orbitRecovered.dbg.radius.toFixed(2)}m, rendered=${orbitRecovered.dist.toFixed(2)}m)`);
    await shot('orbit-clear-after');

    c.ws.close();
  } catch (err) {
    console.error('[verify] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify] console errors captured:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify] console warnings captured:', consoleWarnings.length);
  consoleWarnings.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify] uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  writeFileSync(
    path.join(OUT_DIR, 'console-report-camera-occlusion.json'),
    JSON.stringify({ consoleErrors, consoleWarnings, pageErrors, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
