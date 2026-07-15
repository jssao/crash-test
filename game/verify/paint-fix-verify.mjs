// SPDX-License-Identifier: MIT
//
// Visual verification for the R005 (car textures/paint render black) + R001 (paint doesn't read as
// paint; white speckled patches on hood/roof/trunk) + R002 (headlights plain white) fixes in
// scene/carMaterials.ts + src/assets/car-map.ts + scripts/analyze-car.mjs. Same raw-CDP-over-WebSocket
// headless-Brave pattern as verify/shoot.mjs / verify/crash-lab.mjs (no puppeteer): one `vite preview`
// server, one headless Brave instance, driven across all THREE pages this project ships
// (index.html/src/main.ts, crash-lab.html/src/lab/main.ts, model-viewer.html/src/model-viewer/main.ts)
// since all three share the exact same loadCar()->polishCarMaterials() pipeline (scene/car.ts).
//
// Screenshots are written once to this dir (verify/paint-fix/) and then copied into each relevant
// bug's screenshots/<BUG>/sim/ folder (a single shot can be evidence for more than one bug at once —
// e.g. a paint close-up proves both "not black" (R005) and "reads as glossy paint" (R001)).
//
// Usage: node verify/paint-fix-verify.mjs   (spawns `vite preview` itself; dist/ must already be built
// fresh via `npx vite build` — NOT `npm run build`, since that gates on a repo-wide `tsc --noEmit` that
// currently fails on files outside this task's ownership; see this run's final report).
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9461;
const PREVIEW_PORT = 4187;
const OUT_DIR = path.join(__dirname, 'paint-fix');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

const BUG_DIRS = {
  r005: path.join(repoRoot, 'screenshots', 'R005_car-textures-black', 'sim'),
  r001: path.join(repoRoot, 'screenshots', 'R001_paint-rendering', 'sim'),
  r002: path.join(repoRoot, 'screenshots', 'R002_headlights-white', 'sim'),
};
for (const d of Object.values(BUG_DIRS)) mkdirSync(d, { recursive: true });

function waitForHttp(url, timeoutMs = 30000) {
  const altUrl = url.replace('localhost', '127.0.0.1');
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {}
        try { const r2 = await fetch(altUrl); if (r2.ok) return resolve(true); } catch {}
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

async function main() {
  console.log('[paint-fix-verify] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(`http://localhost:${PREVIEW_PORT}/`);

  console.log('[paint-fix-verify] launching headless Brave...');
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-paint-fix-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
  const shots = []; // { name, path, bugs: [...] }
  let exitCode = 0;

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
    });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    async function shot(name, bugs) {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, `${name}.png`);
      writeFileSync(p, Buffer.from(s.data, 'base64'));
      for (const bug of bugs) copyFileSync(p, path.join(BUG_DIRS[bug], `${name}.png`));
      shots.push({ name, path: p, bugs });
      console.log(`[paint-fix-verify] wrote ${name}.png -> [${bugs.join(', ')}]`);
    }

    // ---- PAGE 1: index.html (main driving game). ?quality=medium forces the render tier — without
    // it main.ts's device auto-benchmark path can hang indefinitely under headless SwiftShader
    // stepping (same reason verify/car-paint.mjs always passes an explicit ?quality=). -------------
    await c.send('Page.navigate', { url: `http://localhost:${PREVIEW_PORT}/?quality=medium` });
    let ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('index.html: window.__GAME__.ready never became true');
    console.log('[paint-fix-verify] index.html ready');
    await sleep(800);

    await evalExpr('window.__GAME__.setOrbitView({ radius: 6.0, height: 1.8, targetHeight: 0.75 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(-0.9); "ok"');
    await sleep(900);
    await shot('index-overall-3q', ['r005', 'r001']);

    // Front 3/4: the car noses toward +Z, and the orbit places the camera at
    // (cos(a)*r, h, sin(a)*r) -- a POSITIVE-sin angle puts the camera on the nose side.
    await evalExpr('window.__GAME__.setOrbitView({ radius: 4.5, height: 1.3, targetHeight: 0.7 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(1.1); "ok"');
    await sleep(700);
    await shot('index-front-paint-headlight-closeup', ['r001', 'r002']);

    // ---- PAGE 2: crash-lab.html (pristine car, no protocol run — so speckle/headlight judgment isn't
    // confounded by crash deformation) ---------------------------------------------------------------
    await c.send('Page.navigate', { url: `http://localhost:${PREVIEW_PORT}/crash-lab.html` });
    ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('crash-lab.html: window.__LAB__.ready never became true');
    console.log('[paint-fix-verify] crash-lab.html ready');
    await sleep(800);

    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await sleep(700);
    await shot('crash-lab-3q-paint-headlights', ['r001', 'r002']);

    await evalExpr("window.__LAB__.setCameraPreset('top'); 'ok'");
    await sleep(700);
    await shot('crash-lab-top-hood-roof-trunk', ['r001']);

    // Nose-side closeup: the lab car noses toward +Z (its presets keep sin(angle)<=0 to stay on the
    // approach side of the barrier -- fine post-crash, wrong for a pristine-front-end shot). The
    // barrier preview spawns 14m ahead, so a positive-sin angle at 4m radius sits comfortably between
    // car and rig and actually faces the headlights.
    await evalExpr('window.__LAB__.setOrbitView({ radius: 4.0, height: 1.1, targetHeight: 0.6 }); "ok"');
    await evalExpr('window.__LAB__.setFixedAngle(Math.PI / 2.6); "ok"');
    await sleep(700);
    await shot('crash-lab-headlight-closeup', ['r002', 'r001']);

    // ---- PAGE 3: model-viewer.html (independent third page; same loadCar()/polishCarMaterials()) ---
    await c.send('Page.navigate', { url: `http://localhost:${PREVIEW_PORT}/model-viewer.html` });
    ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__VIEWER__ && window.__VIEWER__.count > 0')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('model-viewer.html: window.__VIEWER__ never populated');
    console.log('[paint-fix-verify] model-viewer.html ready, labels:', await evalExpr('window.__VIEWER__.labels'));
    await evalExpr('window.__VIEWER__.select(0); "ok"'); // 'Volvo S90 (full car)' is catalog entry 0
    await sleep(900);
    await evalExpr("window.__VIEWER__.preset('iso'); 'ok'");
    await sleep(700);
    await shot('model-viewer-iso', ['r005', 'r001', 'r002']);

    await evalExpr("window.__VIEWER__.preset('front'); 'ok'");
    await sleep(700);
    await shot('model-viewer-front', ['r002']);

    c.ws.close();
  } catch (err) {
    console.error('[paint-fix-verify] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[paint-fix-verify] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  writeFileSync(path.join(OUT_DIR, 'console-report.json'), JSON.stringify({ shots, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2));
  console.log(`[paint-fix-verify] shots: ${shots.length}`);

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
