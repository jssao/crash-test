// Shared CDP + vite-preview harness for the playtest-r3 battery/soak (game/verify/playtest-r3/*.mjs).
// Same raw-CDP-over-headless-Brave pattern as verify/playtest/lib.mjs (read-only sibling, not edited
// here) with two deltas this run's brief specifically calls for:
//   1. Audio-on throughout: launches with --autoplay-policy=no-user-gesture-required (same standard
//      E2E flag verify/audio-check.mjs validated) and dispatches one synthetic keydown right after
//      ready so engine.ts's attachResumeOnGesture() resolves the AudioContext to 'running' -- so every
//      scenario's window.__GAME__.audioDebug() reads real live-node counts, not a permanently-suspended
//      context.
//   2. Coordinates are the CURRENT compound-in-forest layout (terrain/heightfield.ts,
//      world/tuning.ts, features/buildings/tuning.ts, features/trees/tuning.ts) -- see battery.mjs's
//      header comment for the exact constants ported into this dir's scenarios.
//
// Usage: import { launchHarness, DRIVE_TOWARD_SNIPPET, ... } from './lib.mjs'
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const gameRoot = path.resolve(__dirname, '../..');
export const OUT_DIR = path.join(gameRoot, 'verify', 'playtest-r3');
mkdirSync(OUT_DIR, { recursive: true });

export const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function waitForHttp(url, timeoutMs = 30000) {
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
 * Spawns `vite preview` + headless Brave with CDP (audio-unlocked -- see header comment), waits for
 * window.__GAME__.ready, and returns a harness object: { evalExpr, screenshot(name), consoleErrors,
 * consoleWarnings, pageErrors, close(), send }.
 */
export async function launchHarness({ previewPort, cdpPort, width = 1280, height = 720, label = 'playtest-r3' }) {
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

  const args = [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
    '--mute-audio', // silences the OS audio device only -- WebAudio node graph still runs (audio-check.mjs)
    '--autoplay-policy=no-user-gesture-required', // standard E2E flag -- lets the AudioContext resume
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    `--user-data-dir=/tmp/game-${label}-brave-profile`,
    'about:blank',
  ];

  console.log(`[${label}] launching headless Brave (audio-unlocked)...`);
  const browser = spawn(BROWSER, args, { stdio: 'ignore' });

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];

  const c = cdp(await getWsUrl(cdpPort));
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

  // Real (trusted) keydown -- unlocks the AudioContext via engine.ts's own attachResumeOnGesture() path
  // (the --autoplay-policy flag above only makes that resume ALLOWED in this automated harness).
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft' });
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft' });
  await sleep(300);

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

/** true iff every numeric leaf in obj is a finite number (recursively) -- NaN/Infinity/undefined-as-
 * number all fail. */
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

export function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Proportional-heading-controller drive-toward-a-point technique, same algorithm as
 * verify/structural-collapse.mjs's DRIVE_TOWARD_SNIPPET / verify/playtest-soak/run1's copy -- ported
 * here verbatim (each verify script in this codebase keeps its own copy by convention) plus a
 * speedCapKmh throttle-cutoff and optional onStep sampling every `sampleEvery` steps. Inject once via
 * evalExpr(DRIVE_TOWARD_SNIPPET), then call window.__driveToward(...). */
export const DRIVE_TOWARD_SNIPPET = `
window.__driveToward = function (targetX, targetZ, maxSteps, stopDist, throttle, gain, speedCapKmh, sampleEvery) {
  const cap = speedCapKmh === undefined ? Infinity : speedCapKmh;
  const every = sampleEvery || 25;
  function yawOf(q) {
    const t = { x: 2 * (q.y * 1 - q.z * 0), y: 2 * (q.z * 0 - q.x * 1), z: 2 * (q.x * 0 - q.y * 0) };
    const fwd = {
      x: 0 + q.w * t.x + (q.y * t.z - q.z * t.y),
      y: 0 + q.w * t.y + (q.z * t.x - q.x * t.z),
      z: 1 + q.w * t.z + (q.x * t.y - q.y * t.x),
    };
    return Math.atan2(fwd.x, fwd.z);
  }
  function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
  let i = 0;
  const samples = [];
  let maxSpeed = 0;
  let error = null;
  for (; i < maxSteps; i++) {
    let t;
    try {
      t = window.__GAME__.telemetry;
    } catch (err) {
      error = { message: String(err && err.message || err), atStep: i };
      break;
    }
    const p = t.chassisPos;
    const dist = Math.hypot(p.x - targetX, p.z - targetZ);
    if (dist < stopDist) break;
    const desiredYaw = Math.atan2(targetX - p.x, targetZ - p.z);
    const currentYaw = yawOf(t.chassisQuat);
    const err = wrap(desiredYaw - currentYaw);
    const steer = Math.max(-1, Math.min(1, -err * gain));
    const effectiveThrottle = t.speedKmh > cap ? 0 : throttle;
    maxSpeed = Math.max(maxSpeed, t.speedKmh);
    if (i % every === 0) samples.push({ i, x: +p.x.toFixed(1), z: +p.z.toFixed(1), steer: +steer.toFixed(2), speedKmh: +t.speedKmh.toFixed(1) });
    try {
      window.__GAME__.setInput({ throttle: effectiveThrottle, brake: 0, steer, handbrake: false });
      window.__GAME__.stepN(1);
    } catch (err) {
      error = { message: String(err && err.message || err), atStep: i };
      break;
    }
  }
  let finalTelemetry = null;
  try { finalTelemetry = window.__GAME__.telemetry; } catch (err) { error = error || { message: String(err && err.message || err), atStep: i }; }
  return { steps: i, finalPos: finalTelemetry ? finalTelemetry.chassisPos : null, speedKmh: finalTelemetry ? finalTelemetry.speedKmh : null, maxSpeedKmh: maxSpeed, samples, error };
};
'ok';
`;

/** Drives with a CONSTANT input (no steering toward a point) for N steps -- for straight runway
 * build-up / U-turns via a fixed steer constant. */
export const STRAIGHT_RUN_SNIPPET = `
window.__straightRun = function (steps, throttle, steer, brake) {
  let i = 0;
  let error = null;
  let maxSpeed = 0;
  for (; i < steps; i++) {
    try {
      const t = window.__GAME__.telemetry;
      maxSpeed = Math.max(maxSpeed, t.speedKmh);
      window.__GAME__.setInput({ throttle, brake: brake || 0, steer, handbrake: false });
      window.__GAME__.stepN(1);
    } catch (err) {
      error = { message: String(err && err.message || err), atStep: i };
      break;
    }
  }
  let finalTelemetry = null;
  try { finalTelemetry = window.__GAME__.telemetry; } catch {}
  return { steps: i, finalPos: finalTelemetry ? finalTelemetry.chassisPos : null, speedKmh: finalTelemetry ? finalTelemetry.speedKmh : null, maxSpeedKmh: maxSpeed, error };
};
'ok';
`;

export async function fpsNum(evalExpr) {
  const txt = await evalExpr("document.getElementById('hud-perf') ? document.getElementById('hud-perf').textContent : null");
  const m = txt && /fps\s+(\d+)/.exec(txt);
  return m ? Number(m[1]) : null;
}

export async function heapMB(h) {
  await h.send('HeapProfiler.collectGarbage').catch(() => {});
  const v = await h.evalExpr('performance.memory ? performance.memory.usedJSHeapSize : -1');
  return v > 0 ? v / (1024 * 1024) : null;
}

/** Least-squares slope of ys vs xs, ignoring non-finite pairs. Returns null if fewer than 3 usable
 * points. Same technique as verify/playtest-soak/run2's inline slope(). */
export function slope(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => y !== null && y !== undefined && Number.isFinite(y));
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s, [x]) => s + x, 0) / n;
  const my = pts.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0,
    den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}
