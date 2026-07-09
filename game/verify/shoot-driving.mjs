// Driving verification: loads the game, drives it deterministically via window.__GAME__.stepN()
// (not wall-clock waiting -- SwiftShader software rendering is slow, and stepN advances the fixed
// physics timestep directly regardless of render frame rate), screenshots the result, and asserts
// zero console errors. Same headless-Brave CDP harness pattern as verify/shoot.mjs, extended
// minimally for driving.
//
// Usage: node verify/shoot-driving.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9423;
const PREVIEW_PORT = 4174;
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
  console.log('[verify-driving] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-driving] preview server up at', URL);

  console.log('[verify-driving] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-driving-brave-profile',
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
  let yawBeforeSteer = null;
  let yawAfterSteer = null;

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
    console.log('[verify-driving] game ready');

    // Let a handful of real frames render first (shadow map, PMREM, textures settle) -- matches
    // shoot.mjs's pattern -- before driving deterministically.
    await sleep(1500);

    telemetryBefore = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-driving] telemetry before:', JSON.stringify(telemetryBefore));

    // Full throttle for 3 simulated seconds (180 steps @ 60Hz), driven via setInput + stepN --
    // deterministic, independent of SwiftShader's slow real-time render rate.
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(180); "ok"');

    telemetryAfter = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-driving] telemetry after 3s full throttle:', JSON.stringify(telemetryAfter));

    // GATE FIX (adversarial-verifier gap): the throttle-only assertions above never actually drove the
    // car in a curve -- add a steering segment and assert yaw genuinely changed, not just speed.
    // yawOf() derives a heading angle from chassisQuat (rotate local +Z by the quaternion, same
    // formula as verify/shoot-world.mjs's driveToward()/lib.mjs's forwardOf()) rather than reading
    // yawRateRadS (an instantaneous rate, not a cumulative turn amount).
    const yawOfSnippet = `
      window.__yawOf = function (q) {
        const t = { x: 2 * (q.y * 1 - q.z * 0), y: 2 * (q.z * 0 - q.x * 1), z: 2 * (q.x * 0 - q.y * 0) };
        const fwd = { x: 0 + q.w * t.x + (q.y * t.z - q.z * t.y), y: 0 + q.w * t.y + (q.z * t.x - q.x * t.z), z: 1 + q.w * t.z + (q.x * t.y - q.y * t.x) };
        return Math.atan2(fwd.x, fwd.z);
      };
      'ok';
    `;
    await evalExpr(yawOfSnippet);
    yawBeforeSteer = await evalExpr('window.__yawOf(window.__GAME__.telemetry.chassisQuat)');

    // Steer 0.25 for ~2s (120 steps @ 60Hz), still under throttle so the car keeps enough speed to
    // actually turn (not just scrub in place).
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0.25, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(120); "ok"');
    yawAfterSteer = await evalExpr('window.__yawOf(window.__GAME__.telemetry.chassisQuat)');
    console.log(`[verify-driving] yaw before steer=${yawBeforeSteer.toFixed(4)} after steer=${yawAfterSteer.toFixed(4)}`);

    // Render a few real frames at the now-advanced physics state before screenshotting.
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(800);

    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(OUT_DIR, 'screenshot-driving.png');
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    console.log('[verify-driving] wrote', outPath, `(${shot.data.length} b64 chars)`);

    c.ws.close();
  } catch (err) {
    console.error('[verify-driving] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-driving] console errors captured:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-driving] console warnings captured:', consoleWarnings.length);
  consoleWarnings.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-driving] uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  const speedBefore = telemetryBefore?.speedKmh ?? 0;
  const speedAfter = telemetryAfter?.speedKmh ?? 0;
  const droveForward = speedAfter > speedBefore + 5;
  console.log(`[verify-driving] speed before=${speedBefore?.toFixed?.(1)} after=${speedAfter?.toFixed?.(1)} droveForward=${droveForward}`);

  // Wrap to (-pi, pi] before taking the delta, so a turn that happens to straddle the atan2 branch cut
  // doesn't read as a near-2*pi jump.
  let yawDelta = (yawAfterSteer ?? 0) - (yawBeforeSteer ?? 0);
  while (yawDelta > Math.PI) yawDelta -= 2 * Math.PI;
  while (yawDelta < -Math.PI) yawDelta += 2 * Math.PI;
  const REQUIRED_YAW_DELTA_RAD = 0.15;
  const yawChanged = Math.abs(yawDelta) > REQUIRED_YAW_DELTA_RAD;
  console.log(
    `[verify-driving] yaw delta after 2s steer=0.25 turn: ${yawDelta.toFixed(4)} rad (REQUIRED >${REQUIRED_YAW_DELTA_RAD}): ${yawChanged ? 'PASS' : 'FAIL'}`,
  );

  writeFileSync(
    path.join(OUT_DIR, 'console-report-driving.json'),
    JSON.stringify(
      { consoleErrors, consoleWarnings, pageErrors, telemetryBefore, telemetryAfter, droveForward, yawBeforeSteer, yawAfterSteer, yawDelta, yawChanged, timestamp: new Date().toISOString() },
      null,
      2,
    ),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0 || !droveForward || !yawChanged) exitCode = 1;
  process.exit(exitCode);
}

main();
