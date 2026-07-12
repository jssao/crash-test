// SPDX-License-Identifier: MIT
//
// Stream C slice C3 EYES-ON battery: multi-angle read of the new LATERAL structural field (scene/
// structuralCrush.ts) against the user's reference angles -- especially TOP VIEW. For each of
// side-mdb-50, side-pole-32, iihs-small-64 (+ regression: nhtsa-56, 161 km/h free-config straight
// frontal) captures TOP / struck-side-profile / a low "underside-ish" angle, barrier hidden. Same
// headless-Brave CDP pattern as verify/crash-lab.mjs and verify/door-sprung/shoot-door-sprung.mjs
// (deliberately a standalone twin, not a modification of the pinned 21/21-assertion crash-lab.mjs).
//
// Usage: node verify/side-fidelity/shoot-side-fidelity.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..', '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9471;
const PREVIEW_PORT = 4209;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const OUT_DIR = __dirname;
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
  console.log('[side-fidelity] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);

  console.log('[side-fidelity] launching headless Brave...');
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-side-fidelity-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
  let exitCode = 0;
  const measurements = {};
  // C3c REGRESSION GUARD: the C3b jam-fix (welds.ts doorLateralFraction gate) had a documented side
  // effect -- a door that jams instead of springing open keeps feeding the trolley's push into the
  // chassis/suspension longer, and side-mdb-50 tore off 3 of 4 wheels (fl/fr/rl) even though a real
  // 50 km/h side-MDB test never sheds a wheel. Fixed by damage-tuning.ts's
  // WHEEL_DETACH_JAMMED_DOOR_DEBOUNCE_STEPS (welds.ts part 3). Pinned here (the real guided-trolley/
  // pole lab rigs, not just the sim-harness static-wall proxy) rather than in verify/crash-lab.mjs
  // (kept at its existing 21/21 -- this is a standalone twin, see file header).
  const assertions = [];
  const assert = (label, cond, detail) => {
    assertions.push({ label, pass: !!cond, detail });
    console.log(`[side-fidelity] ${cond ? 'PASS' : 'FAIL'} -- ${label}`, detail !== undefined ? JSON.stringify(detail) : '');
  };

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
    console.log('[side-fidelity] lab ready');
    await sleep(1000);

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
      console.log(`[side-fidelity] wrote ${name}`);
    };

    async function battery(label, runExpr, opts = {}) {
      await evalExpr(runExpr);
      await evalExpr(`window.__LAB__.stepN(${opts.steps ?? 600}); "ok"`);
      const readout = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
      const struct = await evalExpr('window.__LAB__.maxStructuralOffsetM()');
      const dump = await evalExpr('JSON.stringify(window.__LAB__.dumpDeformables())').then((s) => JSON.parse(s));
      measurements[label] = { readout, maxStructuralOffsetM: struct };
      console.log(`[side-fidelity] ${label} panelStates=${JSON.stringify(readout.panelStates)} wheelStates=${JSON.stringify(readout.wheelStates)}`);
      console.log(`[side-fidelity] ${label} crush=${JSON.stringify(readout.crush)} maxStructuralOffsetM=${struct}`);
      const flankMeshes = dump.filter((d) => d.kind === 'chassis' && d.maxOffsetM > 0.02);
      console.log(`[side-fidelity] ${label} chassis meshes with real dent: ${flankMeshes.map((d) => `${d.id}:${d.maxOffsetM.toFixed(3)}`).join(', ')}`);

      await evalExpr("window.__LAB__.setRigVisible(false); 'ok'");
      await sleep(300);
      await evalExpr("window.__LAB__.setCameraPreset('top'); 'ok'");
      await sleep(500);
      await shot(`${label}-top.png`);
      await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
      await sleep(500);
      await shot(`${label}-struck-side.png`);
      // Low, close, upward-tilted "underside-ish" angle: camera clamps to a 0.4m minimum height (see
      // cameraOrbit.ts's createOrbitUpdater doc), aimed BELOW the car's own centerline so the rocker/
      // sill/underside reads as clearly as this rig allows.
      await evalExpr("window.__LAB__.setOrbitView({ radius: 4.2, height: -2, targetHeight: -0.35 }); 'ok'");
      await evalExpr('window.__LAB__.setFixedAngle(-Math.PI / 5); "ok"');
      await sleep(500);
      await shot(`${label}-lowangle.png`);
    }

    // ---- Genuine SIDE impacts: the primary ask (top view must show the cave-in silhouette). ----
    await battery('side-mdb-50', "window.__LAB__.run('side-mdb-50'); 'ok'");
    assert('side-mdb-50: all 4 wheels ATTACHED (C3c regression guard)', Object.values(measurements['side-mdb-50'].readout.wheelStates).every((s) => s === 'attached'), measurements['side-mdb-50'].readout.wheelStates);
    await battery('side-pole-32', "window.__LAB__.run('side-pole-32'); 'ok'");
    assert('side-pole-32: all 4 wheels ATTACHED', Object.values(measurements['side-pole-32'].readout.wheelStates).every((s) => s === 'attached'), measurements['side-pole-32'].readout.wheelStates);
    // ---- Small-overlap corner: crush concentration + struck-wheel/door read. ----
    await battery('iihs-small-64', "window.__LAB__.run('iihs-small-64'); 'ok'");
    // ---- Regression: pure frontal must be unaffected (lateral field inert -- no side hit at all). ----
    await battery('nhtsa-56', "window.__LAB__.run('nhtsa-frontal-56'); 'ok'");
    // ---- Regression: extreme-tier 161 km/h straight frontal (Stream C C2 territory) still reads clean
    // with the lateral field merged into the same StructuralCrushInputs object. ----
    await battery('free-161', "window.__LAB__.setFreeConfig({ speedKmh: 161, offsetM: 0, angleDeg: 0 }); window.__LAB__.run('free'); 'ok'", { steps: 500 });

    writeFileSync(path.join(OUT_DIR, 'side-fidelity-measurements.json'), JSON.stringify(measurements, null, 2));

    c.ws.close();
  } catch (err) {
    console.error('[side-fidelity] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  const failedAssertions = assertions.filter((a) => !a.pass);
  console.log(`\n[side-fidelity] assertions: ${assertions.length - failedAssertions.length}/${assertions.length} passed`);
  console.log(`[side-fidelity] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));
  if (consoleErrors.length > 0 || pageErrors.length > 0 || failedAssertions.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
