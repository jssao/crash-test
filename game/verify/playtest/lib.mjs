// Shared CDP + vite-preview harness for the playtest battery (game/verify/playtest/*.mjs). Same
// pattern as verify/shoot-crash.mjs/shoot-driving.mjs, factored out so each scenario script doesn't
// re-implement the websocket/preview-server boilerplate.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const gameRoot = path.resolve(__dirname, '../..');
export const OUT_DIR = path.join(gameRoot, 'verify', 'playtest');
mkdirSync(OUT_DIR, { recursive: true });

export const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function waitForHttp(url, timeoutMs = 30000) {
  // Also tries the explicit 127.0.0.1 form of the same URL -- this sandbox has shown intermittent
  // IPv6-vs-IPv4 localhost resolution flakiness (fetch('http://localhost:PORT/') occasionally fails
  // even though the server is confirmed up via curl, which tries both address families) -- retrying
  // with both forms each poll is cheap and avoids a spurious "server never came up" failure.
  const altUrl = url.replace('localhost', '127.0.0.1');
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try {
          const r = await fetch(url);
          if (r.ok) return resolve(true);
        } catch {}
        try {
          const r2 = await fetch(altUrl);
          if (r2.ok) return resolve(true);
        } catch {}
        await sleep(300);
      }
      reject(new Error('preview server never came up'));
    })();
  });
}

export function cdp(wsUrl) {
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

export async function getWsUrl(port) {
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

/**
 * Spawns `vite preview` + headless (or headed) Brave with CDP, waits for window.__GAME__.ready, and
 * returns a harness object: { evalExpr, screenshot(name), consoleErrors, consoleWarnings, pageErrors,
 * close() }. `headed` (scenario 10 only) drops all the SwiftShader/headless flags and opens a real
 * window -- caller is responsible for knowing that's authorized.
 */
export async function launchHarness({ previewPort, cdpPort, width = 1280, height = 720, headed = false, label = 'playtest' }) {
  const URL = `http://localhost:${previewPort}/`;
  console.log(`[${label}] starting vite preview on ${previewPort}...`);
  const preview = spawn('npx', ['vite', 'preview', '--port', String(previewPort), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview:${previewPort}] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview:${previewPort}] ${d}`));
  await waitForHttp(URL);
  console.log(`[${label}] preview up at`, URL);

  const args = headed
    ? [
        `--remote-debugging-port=${cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${width},${height}`,
        '--force-device-scale-factor=1',
        `--user-data-dir=/tmp/game-${label}-brave-profile`,
        'about:blank',
      ]
    : [
        '--headless=new',
        `--remote-debugging-port=${cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
        '--hide-scrollbars',
        '--mute-audio',
        '--no-first-run',
        '--no-default-browser-check',
        `--window-size=${width},${height}`,
        '--force-device-scale-factor=1',
        `--user-data-dir=/tmp/game-${label}-brave-profile`,
        'about:blank',
      ];

  console.log(`[${label}] launching ${headed ? 'HEADED' : 'headless'} Brave...`);
  const browser = spawn(BROWSER, args, { stdio: 'ignore' });

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];

  const c = cdp(await getWsUrl(cdpPort));
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

  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await c.send('Page.navigate', { url: URL });

  const evalExpr = (expr) =>
    c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
      if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r?.result?.value;
    });

  let ok = false;
  for (let i = 0; i < 60; i++) {
    const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true').catch(() => false);
    if (r === true) {
      ok = true;
      break;
    }
    await sleep(500);
  }
  if (!ok) throw new Error('window.__GAME__.ready never became true');
  console.log(`[${label}] game ready`);
  await sleep(1200); // let a handful of real frames render first (shadow map/PMREM/textures settle)

  async function screenshot(name) {
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    const outPath = path.join(OUT_DIR, `${name}.png`);
    writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
    console.log(`[${label}] wrote ${outPath}`);
    return outPath;
  }

  async function close() {
    try {
      c.ws.close();
    } catch {}
    browser.kill();
    preview.kill();
  }

  return { evalExpr, screenshot, consoleErrors, consoleWarnings, pageErrors, close, send: c.send.bind(c) };
}

/**
 * In-page scripted-driving controller, run as ONE synchronous Runtime.evaluate call (so it can't
 * interleave with the real requestAnimationFrame loop -- see this repo's playtest notes: a long
 * synchronous script blocks rAF until it returns). Modes:
 *   'straight'  -- steer 0 always (used for the center wall / building speed in the open).
 *   'waypoint'  -- simple P line-follow toward opts.targetX (steerMultiplier flips sign per the
 *                  runtime steer-convention calibration -- see battery.mjs's calibrateSteer()).
 *   'figure8'   -- steer = sin(i/period)*amp, for the free-drive scenario.
 *   'turn'      -- constant steer = opts.steerConst, for deliberate U-turns to build a long
 *                  straight run-up (see battery.mjs's ramp-jump scenario doc comment).
 * Bang-bang speed control toward opts.targetSpeed the whole time. Stops early once
 * chassisPos.z >= opts.stopZ / |chassisPos.x| >= opts.stopX / the chassis's forward vector's z
 * component crosses opts.stopForwardZLte or opts.stopForwardZGte (heading-based stop for U-turns,
 * since there's no direct "heading angle" telemetry field -- forward is derived from chassisQuat the
 * same way vehicle.ts's chassisForward() does). Samples telemetry (+ wheelHeights when
 * opts.sampleWheels, + damage when opts.sampleDamage) every opts.sampleEvery steps.
 */
function driveScriptSource(opts) {
  return `(() => {
    const g = window.__GAME__;
    const opts = ${JSON.stringify(opts)};
    function forwardOf(q) {
      const vx = 0, vy = 0, vz = 1;
      const tx = 2 * (q.y * vz - q.z * vy);
      const ty = 2 * (q.z * vx - q.x * vz);
      const tz = 2 * (q.x * vy - q.y * vx);
      return {
        x: vx + q.w * tx + (q.y * tz - q.z * ty),
        y: vy + q.w * ty + (q.z * tx - q.x * tz),
        z: vz + q.w * tz + (q.x * ty - q.y * tx),
      };
    }
    const samples = [];
    let lastGoodTelemetry = null;
    let error = null;
    for (let i = 0; i < opts.maxSteps; i++) {
      let t;
      try {
        t = g.telemetry;
        lastGoodTelemetry = t;
        let steer = 0;
        if (opts.mode === 'figure8') {
          steer = (opts.bias || 0) + Math.sin(i / opts.period) * opts.steerAmp;
        } else if (opts.mode === 'waypoint') {
          const dynTargetX = opts.targetX + (opts.targetXOscAmp ? Math.sin(i / opts.targetXOscPeriod) * opts.targetXOscAmp : 0);
          const errX = dynTargetX - t.chassisPos.x;
          steer = (opts.steerMultiplier || 1) * Math.max(-1, Math.min(1, errX * opts.kp));
        } else if (opts.mode === 'turn') {
          steer = opts.steerConst;
        }
        let throttle = t.speedKmh < opts.targetSpeed ? 1 : 0;
        let brake = 0;
        if (t.speedKmh > opts.targetSpeed * 1.2) { throttle = 0; brake = 0.2; }
        g.setInput({ throttle, brake, steer, handbrake: false });
        g.stepN(1);
      } catch (err) {
        // PLAYTEST DIAGNOSTIC: catches the wasm 'memory access out of bounds' trap (or any other
        // exception) mid-loop instead of losing every sample collected so far -- records the exact
        // step index + last-known-good telemetry (damage state included) so a crash can be correlated
        // with what the car/world looked like right before it, per the QA brief's soak-test NaN/
        // exception guard.
        error = { message: String(err && err.message || err), atStep: i, lastGoodTelemetry };
        break;
      }
      if (i % opts.sampleEvery === 0 || i === opts.maxSteps - 1) {
        let t2;
        try {
          t2 = g.telemetry;
        } catch (err) {
          error = error || { message: String(err && err.message || err), atStep: i, lastGoodTelemetry, duringSample: true };
          break;
        }
        const fwd = forwardOf(t2.chassisQuat);
        const sample = {
          i, x: t2.chassisPos.x, y: t2.chassisPos.y, z: t2.chassisPos.z,
          speed: t2.speedKmh, roll: t2.rollAngleRad, up: t2.upDot, yaw: t2.yawRateRadS, fz: fwd.z,
        };
        if (opts.sampleWheels) sample.wh = g.wheelHeights();
        if (opts.sampleDamage) sample.damage = t2.damage;
        samples.push(sample);
      }
      if (opts.stopZ !== undefined && t.chassisPos.z >= opts.stopZ) break;
      if (opts.stopX !== undefined && Math.abs(t.chassisPos.x) >= opts.stopX) break;
      if (opts.stopForwardZLte !== undefined || opts.stopForwardZGte !== undefined) {
        const fwd = forwardOf(t.chassisQuat);
        if (opts.stopForwardZLte !== undefined && fwd.z <= opts.stopForwardZLte) break;
        if (opts.stopForwardZGte !== undefined && fwd.z >= opts.stopForwardZGte) break;
      }
    }
    let finalTelemetry = lastGoodTelemetry;
    try {
      g.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false });
      finalTelemetry = g.telemetry;
    } catch (err) {
      error = error || { message: String(err && err.message || err), atStep: -1, lastGoodTelemetry };
    }
    return { samples, finalTelemetry, error };
  })()`;
}

/** Lightweight post-crash health ping: does window.__GAME__.telemetry (a pure read) still work? Used
 * to decide whether a scenario's caught error left the wasm module merely in a bad DRIVING state
 * (readable, just can't step further) or truly wedged. */
export async function pingHealthy(evalExpr) {
  try {
    const t = await evalExpr('window.__GAME__.telemetry');
    return { readable: true, telemetry: t };
  } catch (err) {
    return { readable: false, error: String(err && err.message ? err.message : err) };
  }
}

/** Does a single stepN(1) still work? (distinguishes "can still read state" from "can still
 * advance physics" -- see this repo's playtest findings on the wasm OOB trap recurring on every
 * subsequent step once triggered.) */
export async function pingStepAlive(evalExpr) {
  try {
    await evalExpr('window.__GAME__.stepN(1); "ok"');
    return { stepOk: true };
  } catch (err) {
    return { stepOk: false, error: String(err && err.message ? err.message : err) };
  }
}

export async function drive(evalExpr, opts) {
  return evalExpr(driveScriptSource(opts));
}

/** true iff every numeric leaf in obj is a finite number (recursively) -- NaN/Infinity/undefined-as-
 * number all fail. Used for the soak's per-cycle NaN guard and scenario sanity checks. */
export function allFinite(obj, path = '$') {
  if (obj === null || obj === undefined) return true;
  if (typeof obj === 'number') return Number.isFinite(obj);
  if (typeof obj !== 'object') return true;
  for (const [k, v] of Object.entries(obj)) {
    if (!allFinite(v, `${path}.${k}`)) return false;
  }
  return true;
}

export function writeJson(name, obj) {
  const outPath = path.join(OUT_DIR, name);
  writeFileSync(outPath, JSON.stringify(obj, null, 2));
  return outPath;
}
