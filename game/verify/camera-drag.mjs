// Headless-WebGL verification for the click-drag/wheel orbit camera control (cameraOrbit.ts's
// UserOrbitController + input/pointer.ts). Same raw-CDP-over-headless-Brave pattern as verify/
// shoot.mjs (see that file's header comment for why) -- own CDP/preview ports so it can run
// concurrently with the other verify/*.mjs scripts and the user's live `vite preview` on :4173.
//
// Drives REAL synthetic mouse events via Input.dispatchMouseEvent (mousePressed/mouseMoved/
// mouseReleased/mouseWheel) at the OS/CDP level -- not JS-dispatched DOM events -- so this exercises
// the actual browser pointer-event pipeline the game's input/pointer.ts listens to.
//
// Asserts (via window.__GAME__.cameraDebug(), a read-only verify hook -- see main.ts):
//   1. Dragging switches cameraMode to 'orbit' and activates the user-orbit controller.
//   2. Azimuth and polar both change measurably after a diagonal drag.
//   3. Wheel-up (deltaY>0) increases radius (zooms out), wheel-down decreases it (zooms in).
//   4. Radius stays clamped inside [4, 25] even after an extreme wheel delta.
//   5. Releasing the drag (mouseReleased, no further mousemove) keeps the orbit view -- the camera
//      does not revert to auto-spin or chase.
//
// Usage: node verify/camera-drag.mjs   (spawns its own `vite preview` instance)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9430;
const PREVIEW_PORT = 4177;
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
      '--user-data-dir=/tmp/game-verify-camera-drag-profile',
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
    for (let i = 0; i < 60; i++) {
      const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true');
      if (r === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify] game ready');

    await sleep(1500); // let a handful of real frames render first

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const outPath = path.join(OUT_DIR, `screenshot-camera-drag-${name}.png`);
      writeFileSync(outPath, Buffer.from(s.data, 'base64'));
      console.log('[verify] wrote', outPath, `(${s.data.length} b64 chars)`);
    };

    // ---- Baseline: chase mode, auto-spin orbit never touched ----
    const before = await evalExpr('window.__GAME__.cameraDebug()');
    console.log('[verify] before:', JSON.stringify(before));
    assert(before.mode === 'chase', `starts in chase mode (got ${before.mode})`);
    assert(before.userOrbitActive === false, 'user-orbit inactive before any drag');
    await shot('before');

    // ---- Drag: mousedown at center, several incremental mousemoves (right + up), mouseup ----
    const CX = 640, CY = 360;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: CX, y: CY, button: 'left', buttons: 1, clickCount: 1 });
    const STEPS = 12;
    for (let i = 1; i <= STEPS; i++) {
      const x = CX + (300 * i) / STEPS; // drag right
      const y = CY - (150 * i) / STEPS; // drag up
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(16);
    }
    const dragEndX = CX + 300, dragEndY = CY - 150;
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragEndX, y: dragEndY, button: 'left', buttons: 0, clickCount: 1 });

    await sleep(1200); // let the damped controller fully settle (tau=0.15s, ~8 time-constants here)
    const afterDrag = await evalExpr('window.__GAME__.cameraDebug()');
    console.log('[verify] afterDrag:', JSON.stringify(afterDrag));
    await shot('after-drag');

    assert(afterDrag.mode === 'orbit', `drag switches to orbit mode (got ${afterDrag.mode})`);
    assert(afterDrag.userOrbitActive === true, 'user-orbit active after a drag');
    const azimuthDelta = Math.abs(afterDrag.azimuth - before.azimuth);
    assert(azimuthDelta > 0.15, `azimuth changed measurably (delta=${azimuthDelta.toFixed(3)})`);
    const polarDelta = Math.abs(afterDrag.polar - before.polar);
    assert(polarDelta > 0.05, `polar changed measurably (delta=${polarDelta.toFixed(3)})`);

    // ---- Release keeps the orbit view: wait some more with NO further input, mode/pose must hold ----
    await sleep(500);
    const afterRelease = await evalExpr('window.__GAME__.cameraDebug()');
    assert(afterRelease.mode === 'orbit', 'still in orbit mode after release + settle');
    assert(afterRelease.userOrbitActive === true, 'user-orbit still active (not reverted to auto-spin) after release');
    const driftAfterRelease = Math.abs(afterRelease.azimuth - afterDrag.azimuth);
    assert(driftAfterRelease < 0.05, `camera holds still after release (drift=${driftAfterRelease.toFixed(4)})`);

    // ---- Wheel: zoom out (positive deltaY), then zoom in (negative deltaY) ----
    const radiusBeforeZoomOut = afterRelease.radius;
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: CX, y: CY, deltaX: 0, deltaY: 400 });
    await sleep(600);
    const afterZoomOut = await evalExpr('window.__GAME__.cameraDebug()');
    console.log('[verify] afterZoomOut:', JSON.stringify(afterZoomOut));
    assert(afterZoomOut.radius > radiusBeforeZoomOut, `wheel deltaY>0 zooms OUT (radius ${radiusBeforeZoomOut.toFixed(2)} -> ${afterZoomOut.radius.toFixed(2)})`);
    assert(afterZoomOut.radius <= 25 + 1e-6, `radius clamped to <=25m (got ${afterZoomOut.radius.toFixed(2)})`);
    await shot('after-zoom-out');

    // Extreme wheel delta must still clamp, not blow past the max.
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: CX, y: CY, deltaX: 0, deltaY: 5000 });
    await sleep(600);
    const afterExtremeZoomOut = await evalExpr('window.__GAME__.cameraDebug()');
    assert(afterExtremeZoomOut.radius <= 25 + 1e-6, `radius still clamped to <=25m after an extreme wheel delta (got ${afterExtremeZoomOut.radius.toFixed(2)})`);

    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: CX, y: CY, deltaX: 0, deltaY: -3000 });
    await sleep(600);
    const afterZoomIn = await evalExpr('window.__GAME__.cameraDebug()');
    console.log('[verify] afterZoomIn:', JSON.stringify(afterZoomIn));
    assert(afterZoomIn.radius < afterExtremeZoomOut.radius, `wheel deltaY<0 zooms IN (radius ${afterExtremeZoomOut.radius.toFixed(2)} -> ${afterZoomIn.radius.toFixed(2)})`);
    assert(afterZoomIn.radius >= 4 - 1e-6, `radius clamped to >=4m (got ${afterZoomIn.radius.toFixed(2)})`);
    await shot('after-zoom-in');

    // ---- C still toggles chase/orbit, and cycling back into orbit resumes auto-spin ----
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC' });
    await sleep(300);
    const afterCToChase = await evalExpr('window.__GAME__.cameraDebug()');
    assert(afterCToChase.mode === 'chase', `C toggles orbit -> chase (got ${afterCToChase.mode})`);

    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC' });
    await sleep(300);
    const afterCBackToOrbit = await evalExpr('window.__GAME__.cameraDebug()');
    assert(afterCBackToOrbit.mode === 'orbit', `C toggles chase -> orbit (got ${afterCBackToOrbit.mode})`);
    assert(afterCBackToOrbit.userOrbitActive === false, 'cycling back into orbit resumes auto-spin (user-orbit inactive)');

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
    path.join(OUT_DIR, 'console-report-camera-drag.json'),
    JSON.stringify({ consoleErrors, consoleWarnings, pageErrors, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
