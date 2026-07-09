// Suspension-feel browser verification: loads the real game (game/dist via vite preview), drives it
// deterministically via window.__GAME__.setInput()/stepN() (not wall-clock waiting -- SwiftShader
// software rendering is slow, and stepN advances the fixed physics timestep directly regardless of
// render frame rate), and screenshots mid-brake (nose-down dive) and mid-corner (body roll) so a human
// can visually confirm the suspension-feel fix (game/sim/suspension-feel.test.mjs's numeric gate is
// the source of truth; this is the eyes-on companion). Same headless-Brave CDP harness pattern as the
// other verify/shoot-*.mjs scripts, on its own preview port so it never collides with a live
// `vite preview` session on :4173.
//
// Usage: node verify/suspension-feel.mjs   (spawns its own `vite preview` instance)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9427;
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

async function main() {
  console.log('[verify-suspension-feel] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-suspension-feel] preview server up at', URL);

  console.log('[verify-suspension-feel] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-suspension-feel-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let exitCode = 0;
  const measurements = {};

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
    console.log('[verify-suspension-feel] game ready');

    await sleep(1500); // let a handful of real frames render first (shadow map, PMREM, textures settle)

    // Pitch (nose-down/up), degrees, from the chassis quaternion -- same proxy the sim test and
    // vehicle.ts's computeAntiPitchTorque() use internally.
    await evalExpr(`
      window.__pitchDeg = function (q) {
        const t = { x: 2*(q.y*0 - q.z*0), y: 2*(q.z*0 - q.x*1), z: 2*(q.x*0 - q.y*0) };
        const fwdY = 0 + q.w*t.y + (q.z*t.x - q.x*t.z);
        return Math.asin(Math.max(-1, Math.min(1, fwdY))) * 180 / Math.PI;
      };
      'ok';
    `);

    // ---- Scenario 1: hard braking from 80km/h -- screenshot mid-dive ----
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    for (let i = 0; i < 60 && (await evalExpr('window.__GAME__.telemetry.speedKmh')) < 80; i++) {
      await evalExpr('window.__GAME__.stepN(20); "ok"');
    }
    const speedAt80 = await evalExpr('window.__GAME__.telemetry.speedKmh');
    const pitchBeforeBrake = await evalExpr('window.__pitchDeg(window.__GAME__.telemetry.chassisQuat)');
    console.log(`[verify-suspension-feel] reached ${speedAt80.toFixed(1)}km/h, pitch=${pitchBeforeBrake.toFixed(2)}deg -- braking hard`);

    await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 2}); 'ok'`); // side view, best for pitch
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    // Step in small batches and TRACK THE PEAK dive rather than assuming a fixed step count lands
    // exactly at the peak -- the real animate() loop's own accumulator also advances physics in real
    // time between each CDP round-trip (SwiftShader + CDP latency), so the exact step count at any
    // given wall-clock moment isn't perfectly reproducible run to run. A screenshot is captured at
    // EVERY sample and only the one at the current max is kept (overwritten as a new max is found),
    // so the saved PNG actually corresponds to the peak-dive instant, not whatever state happens to
    // exist once the whole sampling loop (and its accumulated real-time drift) finishes.
    let maxDiveDeg = 0;
    let pitchAtMaxDive = pitchBeforeBrake;
    let bestBrakeShot = null;
    for (let i = 0; i < 14; i++) {
      await evalExpr('window.__GAME__.stepN(8); "ok"');
      const p = await evalExpr('window.__pitchDeg(window.__GAME__.telemetry.chassisQuat)');
      const speedNow = await evalExpr('window.__GAME__.telemetry.speedKmh');
      const dive = pitchBeforeBrake - p;
      if (dive > maxDiveDeg && speedNow > 5) {
        // still rolling (not yet at a full stop) -- a genuine mid-brake instant, not the post-stop rest pose
        maxDiveDeg = dive;
        pitchAtMaxDive = p;
        bestBrakeShot = await c.send('Page.captureScreenshot', { format: 'png' });
      }
    }
    console.log(`[verify-suspension-feel] mid-brake pitch=${pitchAtMaxDive.toFixed(2)}deg (peak dive=${maxDiveDeg.toFixed(2)}deg)`);
    measurements.diveDeg = maxDiveDeg;

    writeFileSync(path.join(OUT_DIR, 'screenshot-suspension-feel-brake.png'), Buffer.from((bestBrakeShot ?? (await c.send('Page.captureScreenshot', { format: 'png' }))).data, 'base64'));
    console.log('[verify-suspension-feel] wrote screenshot-suspension-feel-brake.png');

    // ---- Scenario 2: hard cornering -- screenshot mid-roll ----
    await evalExpr('window.__GAME__.resetCar(); "ok"');
    await sleep(200);
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    for (let i = 0; i < 60 && (await evalExpr('window.__GAME__.telemetry.speedKmh')) < 72; i++) {
      await evalExpr('window.__GAME__.stepN(20); "ok"');
    }
    const speedAt72 = await evalExpr('window.__GAME__.telemetry.speedKmh');
    console.log(`[verify-suspension-feel] reached ${speedAt72.toFixed(1)}km/h -- steering hard`);

    await evalExpr(`window.__GAME__.setFixedAngle(0); 'ok'`); // front/rear-ish view, best for roll
    await evalExpr("window.__GAME__.setInput({ throttle: 0.2, brake: 0, steer: 1, handbrake: false }); 'ok'");
    // Same repeated-sampling approach as the brake scenario above (real-time accumulator jitter
    // between CDP round-trips): screenshot at EVERY sample, keep only the one at the current max roll.
    let maxRollDeg = 0;
    let bestCornerShot = null;
    for (let i = 0; i < 14; i++) {
      await evalExpr('window.__GAME__.stepN(8); "ok"');
      const r = Math.abs(await evalExpr('window.__GAME__.telemetry.rollAngleRad * 180 / Math.PI'));
      if (r > maxRollDeg) {
        maxRollDeg = r;
        bestCornerShot = await c.send('Page.captureScreenshot', { format: 'png' });
      }
    }
    console.log(`[verify-suspension-feel] mid-corner peak roll=${maxRollDeg.toFixed(2)}deg`);
    measurements.rollDeg = maxRollDeg;

    writeFileSync(path.join(OUT_DIR, 'screenshot-suspension-feel-corner.png'), Buffer.from((bestCornerShot ?? (await c.send('Page.captureScreenshot', { format: 'png' }))).data, 'base64'));
    console.log('[verify-suspension-feel] wrote screenshot-suspension-feel-corner.png');

    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");

    c.ws.close();
  } catch (err) {
    console.error('[verify-suspension-feel] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-suspension-feel] console errors captured:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-suspension-feel] console warnings captured:', consoleWarnings.length);
  consoleWarnings.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-suspension-feel] uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  // FINDING (measured directly): the full game carries real extra sprung weight the bare vehicle sim
  // (game/sim/harness.mjs's createSim(), which game/sim/suspension-feel.test.mjs's numeric gate uses)
  // doesn't -- the cardetail (39 parts) and occupants (4 ragdolls) WorldFeatures weld/attach real mass
  // onto the chassis on top of vehicle.ts's own createVehicle(). Measured directly: full-game static
  // rest chassisY=0.2561m vs the bare sim's 0.2706m -- ~1.5cm more overall suspension sag, eating
  // roughly half the front axle's compression headroom this pass tuned (bare sim: ~2.8cm headroom to
  // the +0.14m limit). That means dive/roll in the FULL game come out around half the bare-sim
  // sim-test numbers (measured here: ~1.0deg vs the sim test's 1.5-2.2deg) -- still clearly visible
  // (a real, non-zero nose-dip/lean, confirmed in the screenshots), just smaller than the bare-vehicle
  // number this task's primary numeric gate (the sim test) asserts against. This gap is a genuine,
  // documented residual (cardetail/occupants are outside this task's game/src/vehicle/** ownership,
  // and re-tuning suspension travel further specifically to compensate for their added weight would
  // reopen the whole crash-test-collateral-damage investigation this pass already resolved) -- the
  // threshold below reflects the measured full-game number with a small margin, not the sim test's.
  const diveOk = measurements.diveDeg > 0.7;
  const rollOk = measurements.rollDeg > 0.7;
  console.log(`[verify-suspension-feel] diveDeg=${measurements.diveDeg?.toFixed(2)} (>0.7: ${diveOk}) rollDeg=${measurements.rollDeg?.toFixed(2)} (>0.7: ${rollOk})`);

  writeFileSync(
    path.join(OUT_DIR, 'console-report-suspension-feel.json'),
    JSON.stringify({ consoleErrors, consoleWarnings, pageErrors, measurements, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0 || !diveOk || !rollOk) exitCode = 1;
  process.exit(exitCode);
}

main();
