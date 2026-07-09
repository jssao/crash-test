// EYES-ON browser verification for airborne round 3 (asymmetric-launch honesty): drive the REAL
// game (dist, vite preview) HALF-ON the kicker ramp at speed, capture a mid-flight screenshot
// sequence that must show SUSTAINED roll (not the pre-fix "corrects itself flat"), plus landing.
// CDP/Brave harness pattern copied from game/verify/shoot.mjs (see its header for provenance).
//
// Usage: node verify/asymmetric-launch/shoot-asym.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..', '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9427;
const PREVIEW_PORT = 4179;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LANE_X = 1.2; // kicker right edge: right wheels on the ramp, left wheels on flat ground
const TARGET_SPEED_MS = 26; // push: laden real-game car needs a faster entry than the sim-unladen flip threshold

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
  console.log('[verify:asym] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);

  console.log('[verify:asym] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-brave-asym-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  const flightTelemetry = [];
  let exitCode = 0;

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

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const evalExpr = (expr) =>
      c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    let ok = false;
    for (let i = 0; i < 60; i++) {
      if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify:asym] game ready');
    await sleep(1500);

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(OUT_DIR, `${name}.png`);
      writeFileSync(p, Buffer.from(s.data, 'base64'));
      console.log('[verify:asym] wrote', p);
    };

    const readState = () =>
      evalExpr(`(() => {
        const t = window.__GAME__.telemetry;
        const q = t.chassisQuat;
        const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
        return {
          x: t.chassisPos.x, y: t.chassisPos.y, z: t.chassisPos.z, yaw,
          speedKmh: t.speedKmh, rollAngleRad: t.rollAngleRad, upDot: t.upDot,
          grounded: t.groundedWheelCount, authority: t.assistAuthority,
        };
      })()`);

    // Front-ish fixed camera so roll (rotation about the travel axis) reads clearly in the frames.
    await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 2}); 'ok'`);
    await sleep(300);
    await shot('asym-00-approach-start');

    // Phase 0: back up ~35m first (S doubles as reverse) -- the spawn-to-kicker run-up alone caps
    // the LADEN real-game car at ~42km/h entry, below the measured flip threshold; a player lining
    // up a big hit does exactly this.
    console.log('[verify:asym] reversing for a longer run-up...');
    const tRev = Date.now();
    while (Date.now() - tRev < 45000) {
      const s = await readState();
      if (s.z <= -75) break;
      await evalExpr(`window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'`);
      await sleep(50);
    }
    await evalExpr(`window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'`);
    console.log('[verify:asym] run-up secured:', JSON.stringify(await readState()));

    // Drive half-on: node-side control loop @ ~30Hz -- lane-keep to LANE_X, bang-bang hold
    // TARGET_SPEED_MS, lift once past the ramp base (z>41). Same control shape as
    // game/sim/asymmetric-launch.test.mjs.
    console.log('[verify:asym] driving half-on toward the kicker...');
    let state = await readState();
    let reachedRamp = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 45000) {
      state = await readState();
      flightTelemetry.push({ phase: 'approach', ...state });
      if (state.z >= 42.5) {
        reachedRamp = true;
        break;
      }
      // Stronger position gain than the sim test's 0.01: the sim spawns already ON the lane (hold
      // only), while the real-game car spawns at x~0 and must CAPTURE the lane 1.2m to the side
      // during the run-up (yaw term x5 still dominates as the damping/inner loop).
      const steer = Math.max(-0.3, Math.min(0.3, state.yaw * 5 + (state.x - LANE_X) * 0.08));
      const throttle = state.z < 42.5 && state.speedKmh / 3.6 < TARGET_SPEED_MS ? 1 : 0;
      await evalExpr(`window.__GAME__.setInput({ throttle: ${throttle}, brake: 0, steer: ${steer}, handbrake: false }); 'ok'`);
      await sleep(33);
    }
    if (!reachedRamp) throw new Error(`never reached ramp: ${JSON.stringify(state)}`);
    await evalExpr(`window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'`);
    console.log('[verify:asym] AT RAMP', JSON.stringify(state));

    // Burst from the ramp onward: 6 shots ~160ms apart with telemetry alongside each -- these
    // frames are the eyes-on evidence of what the launch actually does (sustained roll, authority
    // pinned at 0 while airborne).
    for (let i = 1; i <= 6; i++) {
      const s = await readState();
      flightTelemetry.push({ phase: 'flight', ...s });
      console.log(
        `[verify:asym] flight[${i}] x=${s.x.toFixed(2)} z=${s.z.toFixed(1)} y=${s.y.toFixed(2)} roll=${((s.rollAngleRad * 180) / Math.PI).toFixed(1)}deg upDot=${s.upDot.toFixed(2)} auth=${s.authority} grounded=${s.grounded}`,
      );
      await shot(`asym-0${i}-flight`);
      await sleep(160);
    }

    // Wait for it to come to rest, then the landing shot.
    await sleep(2500);
    const final = await readState();
    flightTelemetry.push(final);
    console.log(`[verify:asym] FINAL upDot=${final.upDot.toFixed(3)} roll=${((final.rollAngleRad * 180) / Math.PI).toFixed(1)}deg z=${final.z.toFixed(1)}`);
    await shot('asym-06-landed');

    c.ws.close();
  } catch (err) {
    console.error('[verify:asym] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('[verify:asym] console errors:', consoleErrors.length, 'page exceptions:', pageErrors.length);
  writeFileSync(
    path.join(OUT_DIR, 'console-report-asymmetric-launch.json'),
    JSON.stringify({ consoleErrors, pageErrors, flightTelemetry, timestamp: new Date().toISOString() }, null, 2),
  );
  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
