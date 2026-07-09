// Verification for the 'buildings' WorldFeature: loads the game, drives the car (via
// window.__GAME__'s existing setInput/stepN/telemetry hooks, same proportional pursuit-steering
// helper as verify/shoot-world.mjs's __driveToward()) out to the east-side structures (x>+30),
// screenshots an intact wide shot, then crashes into the brick wall and screenshots mid-breach.
// Same headless-Brave CDP harness pattern as verify/shoot.mjs.
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

// Injected once into the page -- reused verbatim from verify/shoot-world.mjs's own
// DRIVE_TOWARD_SNIPPET (a small proportional steering controller toward an (x,z) waypoint).
const DRIVE_TOWARD_SNIPPET = `
window.__rotateVec = function (q, v) {
  const t = { x: 2 * (q.y * v.z - q.z * v.y), y: 2 * (q.z * v.x - q.x * v.z), z: 2 * (q.x * v.y - q.y * v.x) };
  return { x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y), y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z), z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x) };
};
window.__driveToward = function (targetX, targetZ, maxSteps, chunkSteps) {
  let steps = 0;
  while (steps < maxSteps) {
    const tel = window.__GAME__.telemetry;
    const pos = tel.chassisPos;
    const fwd = window.__rotateVec(tel.chassisQuat, { x: 0, y: 0, z: 1 });
    const desiredAngle = Math.atan2(targetX - pos.x, targetZ - pos.z);
    const currentAngle = Math.atan2(fwd.x, fwd.z);
    let diff = desiredAngle - currentAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const steer = Math.max(-0.45, Math.min(0.45, diff * 1.3));
    window.__GAME__.setInput({ throttle: 1, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(chunkSteps);
    steps += chunkSteps;
    const dist = Math.hypot(targetX - pos.x, targetZ - pos.z);
    if (dist < 2.5) break;
  }
  return window.__GAME__.telemetry;
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

    bodyCountBefore = await evalExpr("window.__GAME__.features.buildings.totalPieceCount()");
    console.log('[verify-buildings] buildings feature body count:', bodyCountBefore);
    brokenBeforeCrash = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    console.log('[verify-buildings] broken joints before any crash (expect 0):', brokenBeforeCrash);

    // Let a handful of real frames render first (shadow map, PMREM, textures settle).
    await sleep(1500);
    await evalExpr(DRIVE_TOWARD_SNIPPET);

    // ---- (a) intact wide shot: drive out to a vantage point just south of the brick wall
    // (BRICK_WALL_CENTER x=68,z=20 -- see world/features/buildings/tuning.ts), stopping short so
    // nothing has been touched yet. ----
    await evalExpr('window.__driveToward(68, 10, 700, 15); "ok"');
    await evalExpr(`window.__GAME__.setFixedAngle(${-Math.PI / 2}); 'ok'`);
    await sleep(700);
    telemetryIntact = await evalExpr('window.__GAME__.telemetry');
    let shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-buildings-intact.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-buildings] wrote screenshot-buildings-intact.png, pos=', JSON.stringify(telemetryIntact.chassisPos));

    // ---- (b) mid-breach: full-throttle straight into the brick wall, screenshot while debris is
    // still flying (before it settles). ----
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); "ok"');
    await evalExpr('window.__GAME__.stepN(70); "ok"');
    brokenAfterCrash = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    telemetryBreach = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-buildings] mid-breach pos=', JSON.stringify(telemetryBreach.chassisPos), 'brokenJoints=', brokenAfterCrash);
    await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 4}); 'ok'`);
    await sleep(500);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-buildings-breach.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-buildings] wrote screenshot-buildings-breach.png');

    // ---- (c) world reset restores the structures (Shift+R equivalent). ----
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
    if (!(brokenAfterCrash > 0)) throw new Error(`expected broken joints after crashing into the brick wall, got ${brokenAfterCrash}`);
    if (brokenAfterReset !== 0) throw new Error(`expected 0 broken joints after resetWorld(), got ${brokenAfterReset}`);
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
      { consoleErrors, consoleWarnings, pageErrors, bodyCountBefore, brokenBeforeCrash, brokenAfterCrash, telemetryIntact, telemetryBreach, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
