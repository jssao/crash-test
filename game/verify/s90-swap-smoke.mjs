// SPDX-License-Identifier: MIT
//
// S90 SWAP EYES-ON SMOKE (2026-07-11 integration task, S7). Same headless-Brave CDP pattern as
// verify/crash-lab.mjs: loads crash-lab.html, drives the NHTSA full-frontal 56 km/h protocol
// deterministically, and captures:
//   1. S90 pristine side view (before any run) -- confirms the car loads/renders correctly.
//   2. Post-crash side + front-3/4 with the barrier hidden (__LAB__.setRigVisible(false)) --
//      structural crush + hood tent should be visible on the S90's own geometry.
//   3. An interior close-up (pristine, before the crash run) showing the 4 dummies seated in the
//      S90's actual seat positions (occupants/tuning.ts's re-derived SEAT_LOCAL).
//
// Usage: node verify/s90-swap-smoke.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9457;
const PREVIEW_PORT = 4197;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const OUT_DIR = path.join(__dirname, 's90-swap-smoke');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {}
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
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); });
  return { ready, send, ws };
}

async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {}
    await sleep(500);
  }
  throw new Error('no devtools page target');
}

async function main() {
  console.log('[s90-smoke] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);

  console.log('[s90-smoke] launching headless Brave...');
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-s90-smoke-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
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
    await c.send('Page.navigate', { url: URL });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    let ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('window.__LAB__.ready never became true');
    console.log('[s90-smoke] lab ready');
    await sleep(1000);

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
      console.log(`[s90-smoke] wrote ${name}`);
    };

    // ---- 1. Pristine side view (before any run) ----
    await evalExpr("window.__LAB__.selectProtocol('nhtsa-frontal-56'); 'ok'");
    await sleep(300);
    await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
    await sleep(500);
    await shot('01-pristine-side.png');

    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await sleep(500);
    await shot('02-pristine-3q.png');

    // ---- Interior close-up (pristine, dummies seated) ----
    // Positioned to peer down/through the side glass into the cabin -- same convention as
    // verify/feature-occupants.mjs's cabin-closeup shot (setOrbitView radius/height/targetHeight).
    await evalExpr('window.__LAB__.setOrbitView({ radius: 3.2, height: 2.6, targetHeight: 0.85 }); "ok"');
    await sleep(600);
    await shot('03-interior-dummies-seated.png');

    // ---- 2. NHTSA-56 crash, settle, hide the barrier rig, then structural shots ----
    await evalExpr("window.__LAB__.run('nhtsa-frontal-56'); 'ok'");
    await evalExpr('window.__LAB__.stepN(600); "ok"'); // 10s @ 60Hz, well past settle
    const readout = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
    const runState = await evalExpr('window.__LAB__.runState');
    console.log('[s90-smoke] post-crash readout:', JSON.stringify(readout));
    console.log('[s90-smoke] runState:', runState);

    await evalExpr('window.__LAB__.setRigVisible(false); "ok"');
    await sleep(300);

    await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
    await sleep(500);
    await shot('04-postcrash-side-nobarrier.png');

    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await sleep(500);
    await shot('05-postcrash-3q-nobarrier.png');

    // FRONT-facing close-up for the hood-tent/crush detail. The lab's '3q' preset deliberately stays
    // on the car's APPROACH side (fixedAngle=-PI/3, negative sin) so it never looks straight through
    // the (normally opaque) barrier rig -- see main.ts's applyCameraPreset() doc comment -- which means
    // it frames a REAR three-quarter (crushed nose receding into the distance), not the front. Now
    // that the barrier is hidden (setRigVisible(false) above), a POSITIVE fixedAngle is safe and gives
    // a true front three-quarter of the crushed nose/hood-tent.
    await evalExpr('window.__LAB__.setFixedAngle(Math.PI / 3); "ok"');
    await evalExpr('window.__LAB__.setOrbitView({ radius: 4.5, height: 1.6, targetHeight: 0.7 }); "ok"');
    await sleep(500);
    await shot('06-postcrash-nose-closeup.png');

    // Same positive-angle flip for a wider front-3q shot (mirrors 05, but showing the front).
    await evalExpr('window.__LAB__.setOrbitView({ radius: 12, height: 4, targetHeight: 0.6 }); "ok"');
    await sleep(500);
    await shot('07-postcrash-front3q-nobarrier.png');

    const structM = await evalExpr('window.__LAB__.maxStructuralOffsetM()');
    console.log('[s90-smoke] maxStructuralOffsetM:', structM);

    c.ws.close();

    writeFileSync(
      path.join(OUT_DIR, 'readout.json'),
      JSON.stringify({ readout, runState, structM, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2),
    );
  } catch (err) {
    console.error('[s90-smoke] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[s90-smoke] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 20).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 20).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
