// SPDX-License-Identifier: MIT
//
// Reverse-gear verification in the FULL laden browser game (heightfield terrain + welded cardetail +
// contact-resting occupants -- the differences the bare sim harness cannot model). Drives the car via
// window.__GAME__.setInput()/stepN() (deterministic fixed-step, independent of SwiftShader's slow
// render rate) and samples per-step telemetry to root-cause "S-key reverse produces zero backward
// motion" with numbers. Same headless-Brave CDP harness as verify/shoot-driving.mjs.
//
// Scenarios:
//   A. Fresh spawn -> immediately hold S (brake=1) 5s.  (no idle before)
//   B. Idle ~8s (let box3d sleep the car+welded parts) -> hold S 5s.  (exercises the wake path)
//   C. Forward 3s -> coast/brake to stop -> hold S 5s.  (drive-forward -> reverse transition)
//   D. Control: forward from fresh spawn 3s (must still work).
//
// Usage: node verify/reverse-check.mjs
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
  console.log('[reverse-check] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[reverse-check] preview server up at', URL);

  console.log('[reverse-check] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-reverse-check-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  let exitCode = 0;
  const results = {};

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Log.enable');

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
      c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
        if (r?.exceptionDetails) throw new Error('page eval threw: ' + JSON.stringify(r.exceptionDetails));
        return r?.result?.value;
      });

    let ok = false;
    for (let i = 0; i < 60; i++) {
      if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[reverse-check] game ready');
    await sleep(1500);

    // In-page helper: forward-axis projection of displacement + a driving routine that samples per step.
    // forwardOf(q): rotate local +Z by quaternion q (same formula as shoot-driving.mjs's yawOf setup).
    await evalExpr(`
      window.__fwdOf = function (q) {
        const t = { x: 2 * (q.y * 1 - q.z * 0), y: 2 * (q.z * 0 - q.x * 1), z: 2 * (q.x * 0 - q.y * 0) };
        return { x: 0 + q.w * t.x + (q.y * t.z - q.z * t.y), y: 0 + q.w * t.y + (q.z * t.x - q.x * t.z), z: 1 + q.w * t.z + (q.x * t.y - q.y * t.x) };
      };
      window.__runInput = function (state, steps, sampleEvery) {
        window.__GAME__.setInput(state);
        const t0 = window.__GAME__.telemetry;
        const p0 = { x: t0.chassisPos.x, y: t0.chassisPos.y, z: t0.chassisPos.z };
        const fwd0 = window.__fwdOf(t0.chassisQuat);
        const samples = [];
        for (let i = 0; i < steps; i++) {
          window.__GAME__.stepN(1);
          // Sample every step for the first 24 (the transient of interest), then at sampleEvery.
          const dense = i < 24;
          if (dense || (sampleEvery && (i % sampleEvery === 0 || i === steps - 1))) {
            const t = window.__GAME__.telemetry;
            const dx = t.chassisPos.x - p0.x, dz = t.chassisPos.z - p0.z;
            const alongFwd = dx * fwd0.x + dz * fwd0.z; // + = moved forward, - = moved backward
            const dbg = window.__GAME__.debugReverse ? window.__GAME__.debugReverse() : {};
            const dd = dbg.driveDebug || {};
            const df = dbg.deflection || {};
            const fwdNow = window.__fwdOf(t.chassisQuat);
            samples.push({
              i, alongFwd: +alongFwd.toFixed(3), spd: +t.speedKmh.toFixed(2),
              wRL: +t.wheelOmegas.rl.toFixed(1),
              rlTq: dd.rl ? Math.round(dd.rl.maxTorque) : null,
              gndKeys: dbg.grounded ? Object.entries(dbg.grounded).filter(([, v]) => v).map(([k]) => k).join('') : null,
              deflRL: df.rl != null ? +df.rl.toFixed(4) : null, deflFL: df.fl != null ? +df.fl.toFixed(4) : null,
              pitchDeg: +(Math.asin(Math.max(-1, Math.min(1, fwdNow.y))) * 180 / Math.PI).toFixed(2),
              upDot: +t.upDot.toFixed(4), auth: t.assistAuthority != null ? +t.assistAuthority.toFixed(2) : null,
            });
          }
        }
        const tE = window.__GAME__.telemetry;
        const dxE = tE.chassisPos.x - p0.x, dzE = tE.chassisPos.z - p0.z;
        const alongFwdE = dxE * fwd0.x + dzE * fwd0.z;
        return { displacementAlongForward: +alongFwdE.toFixed(3), totalXZ: +Math.hypot(dxE, dzE).toFixed(3), endSpeed: +tE.speedKmh.toFixed(2), endGear: tE.gear, samples };
      };
      'ok';
    `);

    // Rest-attitude + low-body scan: is a rear part propping the car up (contact interference)?
    await evalExpr(`
      window.__scanLow = function () {
        const out = { cardetailLowestY: [], panels: {}, occupantLowestY: null };
        try {
          const cd = window.__GAME__.features && window.__GAME__.features.cardetail;
          if (cd && cd.bodies) {
            const bs = cd.bodies(); const st = cd.states ? cd.states() : {};
            const ids = Object.keys(st);
            const arr = bs.map((b, i) => ({ id: ids[i] || ('#' + i), y: +b.getPosition().y.toFixed(3), z: +b.getPosition().z.toFixed(3) }));
            arr.sort((a, b) => a.y - b.y);
            out.cardetailLowestY = arr.slice(0, 8);
          }
        } catch (e) { out.cdErr = String(e); }
        try {
          const pv = window.__GAME__.dumpPanelVisuals();
          for (const [k, v] of Object.entries(pv.panels)) out.panels[k] = v && v.bodyPos ? +v.bodyPos[1].toFixed(3) : null;
        } catch (e) { out.pvErr = String(e); }
        try {
          const oc = window.__GAME__.features && window.__GAME__.features.occupants;
          if (oc) { for (const key of Object.keys(oc)) { if (typeof oc[key] === 'function') { const r = oc[key](); if (Array.isArray(r) && r[0] && r[0].pelvisPos) { out.occupantLowestY = Math.min(...r.map((e) => +e.pelvisPos.y.toFixed(3))); break; } } } }
        } catch (e) { out.ocErr = String(e); }
        const q = window.__GAME__.telemetry.chassisQuat; const f = window.__fwdOf(q);
        out.chassisPitchDeg = +(Math.asin(Math.max(-1, Math.min(1, f.y))) * 180 / Math.PI).toFixed(2);
        out.wheelHeights = window.__GAME__.wheelHeights();
        const dbg = window.__GAME__.debugReverse();
        out.deflection = dbg.deflection; out.upDot = +window.__GAME__.telemetry.upDot.toFixed(4);
        return out;
      };
      'ok';
    `);
    await evalExpr("window.__GAME__.resetCar(); window.__GAME__.setInput(null); 'ok'");
    await evalExpr('window.__GAME__.stepN(120); "ok"'); // settle fully at rest
    const restScan = JSON.parse(await evalExpr('JSON.stringify(window.__scanLow())'));
    console.log('[REST SCAN]', JSON.stringify(restScan, null, 1));

    const neutral = '{ throttle: 0, brake: 0, steer: 0, handbrake: false }';
    const runRev = (steps) => evalExpr(`JSON.stringify(window.__runInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }, ${steps}, 30))`);
    const runFwd = (steps) => evalExpr(`JSON.stringify(window.__runInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }, ${steps}, 30))`);
    const runNeutral = (steps) => evalExpr(`JSON.stringify(window.__runInput(${neutral}, ${steps}, 60))`);
    const resetCar = () => evalExpr("window.__GAME__.resetCar(); window.__GAME__.setInput(null); 'ok'");

    // ---- Scenario D (control): forward from fresh spawn ----
    await resetCar();
    await evalExpr(`window.__GAME__.stepN(20); 'ok'`); // settle grace
    results.D_forward_fresh = JSON.parse(await runFwd(180));
    console.log('[D forward-fresh] alongForward=%s endSpeed=%s endGear=%s', results.D_forward_fresh.displacementAlongForward, results.D_forward_fresh.endSpeed, results.D_forward_fresh.endGear);

    // ---- Scenario A: fresh spawn -> immediately reverse ----
    await resetCar();
    await evalExpr(`window.__GAME__.stepN(20); 'ok'`);
    results.A_reverse_fresh = JSON.parse(await runRev(240)); // exactly 4s -- the acceptance window
    console.log('[A reverse-fresh 4s] alongForward=%s (negative=reverse) endSpeed=%s endGear=%s', results.A_reverse_fresh.displacementAlongForward, results.A_reverse_fresh.endSpeed, results.A_reverse_fresh.endGear);
    console.table(results.A_reverse_fresh.samples);

    // ---- Scenario B: idle until asleep, then reverse ----
    await resetCar();
    const idle = JSON.parse(await runNeutral(600)); // 10s neutral -> should sleep
    results.B_idle = idle;
    console.log('[B idle-10s] endSpeed=%s lastAwake=%s', idle.endSpeed, idle.samples.at(-1)?.awake);
    results.B_reverse_after_idle = JSON.parse(await runRev(240)); // exactly 4s
    console.log('[B reverse-after-idle] alongForward=%s endSpeed=%s endGear=%s', results.B_reverse_after_idle.displacementAlongForward, results.B_reverse_after_idle.endSpeed, results.B_reverse_after_idle.endGear);
    console.table(results.B_reverse_after_idle.samples);

    // ---- Scenario C: forward -> stop -> reverse ----
    await resetCar();
    await evalExpr(`window.__GAME__.stepN(20); 'ok'`);
    await runFwd(180); // drive forward 3s
    const stopSeg = JSON.parse(await runRev(240)); // hold S: first brakes to stop, then should reverse
    results.C_forward_then_reverse = stopSeg;
    console.log('[C fwd->reverse] alongForward(from stop-start)=%s endSpeed=%s endGear=%s', stopSeg.displacementAlongForward, stopSeg.endSpeed, stopSeg.endGear);
    console.table(stopSeg.samples);

    c.ws.close();
  } catch (err) {
    console.error('[reverse-check] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[reverse-check] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[reverse-check] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  // Acceptance: reverse >= 8m backward in 4s (240 steps) from standstill.
  const revFresh = results.A_reverse_fresh?.displacementAlongForward ?? 0;
  const revIdle = results.B_reverse_after_idle?.displacementAlongForward ?? 0;
  const revTrans = results.C_forward_then_reverse?.displacementAlongForward ?? 0;
  const PASS_M = -8; // backward
  const passA = revFresh <= PASS_M;
  const passB = revIdle <= PASS_M;
  console.log(`\n[reverse-check] SUMMARY (negative = reversed backward):`);
  console.log(`  A fresh-spawn reverse:      ${revFresh} m  -> ${passA ? 'PASS' : 'FAIL'}`);
  console.log(`  B reverse-after-sleep:      ${revIdle} m  -> ${passB ? 'PASS' : 'FAIL'}`);
  console.log(`  C forward->stop->reverse:   ${revTrans} m`);
  console.log(`  D control forward:          ${results.D_forward_fresh?.displacementAlongForward} m (expect large +)`);

  writeFileSync(path.join(OUT_DIR, 'reverse-check-report.json'), JSON.stringify({ results, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2));

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  if (!passA || !passB) exitCode = 2;
  process.exit(exitCode);
}

main();
