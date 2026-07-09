// Crash-damage verification: loads the game, spawns a test wall + crashes into it at 70 km/h via
// window.__GAME__.spawnTestWall()/crash() (G3 spec), steps through the impact deterministically via
// stepN() (not wall-clock waiting -- SwiftShader software rendering is slow), screenshots before/
// after (after must visibly show deformation/a detached panel), plus a slow post-crash orbit shot, and
// asserts zero console errors. Same headless-Brave CDP harness pattern as verify/shoot-driving.mjs,
// extended minimally for the damage system.
//
// Usage: node verify/shoot-crash.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9424;
const PREVIEW_PORT = 4175;
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

async function main() {
  console.log('[verify-crash] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-crash] preview server up at', URL);

  console.log('[verify-crash] launching headless Brave...');
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
      '--window-size=960,540',
      '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-crash-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let exitCode = 0;
  let telemetryBefore = null;
  let telemetryAfter = null;

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

    await c.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

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
    console.log('[verify-crash] game ready');

    // Let a handful of real frames render first (shadow map, PMREM, textures settle).
    await sleep(1500);

    // Same fixed 3/4-front angle as the "after" shot below, so before/after are a fair, directly
    // comparable view of the same part of the car (the front, where the crash damage lands).
    await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 3}); 'ok'`);
    await sleep(600);

    telemetryBefore = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-crash] telemetry before:', JSON.stringify(telemetryBefore.damage));

    const shotBefore = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-crash-before.png'), Buffer.from(shotBefore.data, 'base64'));
    console.log('[verify-crash] wrote screenshot-crash-before.png');

    // Spawn the test wall + crash at 70 km/h (G3 spec), then step through the impact deterministically.
    await evalExpr('window.__GAME__.spawnTestWall(25); "ok"');
    await evalExpr('window.__GAME__.crash(70); "ok"');
    await evalExpr('window.__GAME__.stepN(360); "ok"'); // 6s @ 60Hz -- reach the wall + settle

    telemetryAfter = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-crash] telemetry after crash:', JSON.stringify(telemetryAfter.damage));

    // "after" MUST visibly show deformation/a detached panel: the crash happens at the car's FRONT,
    // which the default chase camera (trailing behind, looking forward over the rear) never shows --
    // switch to a fixed 3/4-front orbit angle (carFocus now tracks the car's current position, see
    // main.ts, so this frames the car wherever it ended up post-crash, not just its spawn point).
    await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 3}); 'ok'`);
    await sleep(800);

    const shotAfter = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-crash-after.png'), Buffer.from(shotAfter.data, 'base64'));
    console.log('[verify-crash] wrote screenshot-crash-after.png');

    // Slow post-crash orbit shot: a different angle (front-left 3/4), showing the damage from another
    // side too.
    await evalExpr(`window.__GAME__.setFixedAngle(${(2 * Math.PI) / 3}); 'ok'`);
    await sleep(600);
    const shotOrbit = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-crash-orbit.png'), Buffer.from(shotOrbit.data, 'base64'));
    console.log('[verify-crash] wrote screenshot-crash-orbit.png');

    c.ws.close();
  } catch (err) {
    console.error('[verify-crash] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-crash] console errors captured:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-crash] console warnings captured:', consoleWarnings.length);
  consoleWarnings.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-crash] uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  const damageOccurred =
    telemetryAfter &&
    (Object.values(telemetryAfter.damage.panelStates).some((s) => s === 'loosened' || s === 'broken') || telemetryAfter.damage.dentedVertexCount > 0);
  console.log(`[verify-crash] damage occurred: ${damageOccurred}`);

  writeFileSync(
    path.join(OUT_DIR, 'console-report-crash.json'),
    JSON.stringify({ consoleErrors, consoleWarnings, pageErrors, telemetryBefore, telemetryAfter, damageOccurred, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0 || !damageOccurred) exitCode = 1;
  process.exit(exitCode);
}

main();
