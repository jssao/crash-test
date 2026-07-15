// SPDX-License-Identifier: MIT
//
// BUG P006/P008 verification harness ("side barrier / rear barrier look like the car just magically
// gets hit -- there isn't a sled"). Same headless-Brave CDP pattern as verify/crash-lab.mjs: loads
// crash-lab.html, runs the two guided-trolley protocols (side-mdb-50, rear-80) deterministically via
// window.__LAB__.run()+stepN(), and for each:
//   (a) screenshots a MID-APPROACH frame (trolley displaced from spawn, still short of the car) --
//       proves a visible sled is actually flying toward the car, not parked at its spawn pose forever
//       (this file's whole reason to exist -- src/lab/barriers.ts's BarrierRig.transform fix).
//   (b) screenshots a POST-IMPACT frame.
//   (c) asserts window.__LAB__.rigSyncCheck() (added by the same fix) stays under 0.05m during the
//       approach -- the mesh is actually tracking the physics body, not frozen at spawn.
//   (d) asserts window.__LAB__.rigDisplacementFromSpawnM() (also added by the fix) shows the barrier
//       BODY itself actually traveled >=2m from its own spawn position -- the guided-trolley physics
//       side of this (launch velocity, re-pinning) was never actually broken (root-cause notes), this
//       just confirms that still holds so a future physics regression wouldn't slip through unnoticed.
//
// TIMING NOTE (found while writing this harness): this sandbox's headless Brave renders this scene via
// software (swiftshader) very slowly -- a single Page.captureScreenshot call was observed costing
// ~4-5 REAL seconds, during which the page's OWN wall-clock-driven requestAnimationFrame loop (main.ts's
// animate(), still registered via renderer.setAnimationLoop) keeps ticking and can inject dozens of
// EXTRA, uncontrolled doFixedStep() calls before the frame is actually captured -- enough to blow past
// the entire ~0.4-0.5s guided-approach window these two protocols have. window.__LAB__.renderNow()
// (added alongside rigSyncCheck()/rigDisplacementFromSpawnM() by this same fix, verify-harness-only)
// exists to solve exactly this: it snaps every tracked visual (including the barrier) to the CURRENT
// fixed-step sample at alpha=1, updates the camera, renders once, and permanently stops the ambient
// animation loop -- giving a bit-exact, deterministic screenshot of "wherever stepN() left the physics"
// with zero wall-clock coupling. Confirmed empirically: rigSyncCheck()==0 and unchanged after the
// subsequent screenshot, and screenshot capture time drops to ~1s once the loop is stopped.
//
// Usage: node verify/crash-lab-sled-sync.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const screenshotsRoot = path.resolve(gameRoot, '..', 'screenshots');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9510;
const PREVIEW_PORT = 4210;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-protocol output dirs (BUG_FIXES.md ids) -- matches the existing screenshots/P0xx_*/sim convention.
const OUT_DIRS = {
  'side-mdb-50': path.join(screenshotsRoot, 'P006_side-barrier-no-sled', 'sim'),
  'rear-80': path.join(screenshotsRoot, 'P008_rear-barrier-no-sled', 'sim'),
};
for (const dir of Object.values(OUT_DIRS)) mkdirSync(dir, { recursive: true });

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

// Protocols under test (src/lab/protocols.ts geometry: approachDistanceM/speedKmh). midApproachSteps
// is chosen well short of the nominal geometric arrival (distance/closing-speed in fixed steps) so the
// screenshot/checks land clearly mid-flight, not at/after contact. cameraPreset is chosen per-protocol
// so the barrier's orange "deformable face" (barriers.ts's trolleyVisual()) is actually in frame: the
// side trolley's leading face is the box's local +/-X face, which the 'side' preset's camera (offset
// purely along +X from the car) looks straight down the normal of instead of at it -- 'top' shows it
// clearly. The rear trolley's leading face is +Z, which the '3q' preset already frames well.
//
// postImpactSteps: chosen from a direct per-step telemetry probe (this task's dispatch notes) showing
// each protocol's crush/chassis-decel telemetry spikes and STABILIZES within a couple dozen fixed steps
// of first contact (side-mdb-50 ~step 20, rear-80 ~step 15) -- these guided trolleys are frictionless/
// undamped/gravity-disabled (barriers.ts's spawnBarrierRig doc comment) so AFTER the crash their
// residual momentum just coasts them away in a straight line forever with nothing to decelerate them;
// stepping all the way to settleSteps (this run's full ~5.4s settle window) leaves the trolley 46-200m
// downrange and out of frame -- a technically-"settled" but visually useless "post-impact" screenshot.
// postImpactSteps instead lands shortly after the crush telemetry has already stabilized, while the
// sled is still visibly adjacent to the car -- settleSteps is still used (numeric-only, no screenshot)
// to confirm the run eventually reaches 'settled'.
const CASES = [
  {
    id: 'side-mdb-50',
    label: 'Side MDB — 50 km/h',
    midApproachSteps: 12, // ~0.2s @ 13.9 m/s -> ~2.8m traveled, ~3.2m still to the nominal 6m gap
    postImpactSteps: 30, // ~0.5s -- crush/decel telemetry stabilized by ~step 20; sled still adjacent
    settleSteps: 600,
    cameraPreset: 'top',
  },
  {
    id: 'rear-80',
    label: 'Rear Impact — 80 km/h (trolley)',
    midApproachSteps: 10, // ~0.167s @ 22.2 m/s -> ~3.7m traveled, ~4.3m still to the nominal 8m gap
    postImpactSteps: 25, // ~0.417s -- crush/decel telemetry stabilized by ~step 15; sled still adjacent
    settleSteps: 600,
    cameraPreset: '3q',
  },
];

async function main() {
  console.log('[crash-lab-sled-sync] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);

  console.log('[crash-lab-sled-sync] launching headless Brave...');
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-crash-lab-sled-sync-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
  const assertions = [];
  let exitCode = 0;

  const assert = (label, cond, detail) => {
    assertions.push({ label, pass: !!cond, detail });
    console.log(`[crash-lab-sled-sync] ${cond ? 'PASS' : 'FAIL'} — ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
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
    console.log('[crash-lab-sled-sync] lab ready');
    await sleep(1000);

    let outDir; // set per-case, read by shot()
    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const filePath = path.join(outDir, name);
      writeFileSync(filePath, Buffer.from(s.data, 'base64'));
      console.log(`[crash-lab-sled-sync] wrote ${filePath}`);
    };

    for (const kase of CASES) {
      outDir = OUT_DIRS[kase.id];
      console.log(`\n[crash-lab-sled-sync] === ${kase.id} (${kase.label}) ===`);

      await evalExpr(`window.__LAB__.run('${kase.id}'); 'ok'`);
      await evalExpr(`window.__LAB__.setCameraPreset('${kase.cameraPreset}'); 'ok'`);

      const preElapsed = await evalExpr('window.__LAB__.runElapsedS');
      assert(`${kase.id}: run starts at t=0`, preElapsed === 0, preElapsed);

      // ---- Mid-approach: deterministic manual fixed steps, then renderNow() forces an exact,
      // wall-clock-independent sync of every visual (including the barrier) before screenshotting.
      await evalExpr(`window.__LAB__.stepN(${kase.midApproachSteps}); "ok"`);
      await evalExpr('window.__LAB__.renderNow(); "ok"');
      const midSync = await evalExpr('window.__LAB__.rigSyncCheck()');
      const midDisp = await evalExpr('window.__LAB__.rigDisplacementFromSpawnM()');
      console.log(`[crash-lab-sled-sync] ${kase.id}: mid-approach rigSyncCheck=${midSync}m, rigDisplacementFromSpawnM=${midDisp}m`);
      assert(`${kase.id}: rigSyncCheck() < 0.05m during approach (mesh tracks body)`, typeof midSync === 'number' && midSync < 0.05, midSync);
      assert(`${kase.id}: barrier body traveled >=2m from spawn mid-approach`, typeof midDisp === 'number' && midDisp >= 2, midDisp);

      await shot(`${kase.id}-01-mid-approach.png`);

      // ---- Post-impact: step to just past first contact (see CASES's postImpactSteps doc comment --
      // NOT all the way to the full settle window, which leaves this frictionless/undamped trolley
      // coasted 46-200m downrange and out of frame). renderNow() already stopped the ambient animation
      // loop, so these extra manual steps advance physics deterministically with no further drift risk.
      await evalExpr(`window.__LAB__.stepN(${kase.postImpactSteps - kase.midApproachSteps}); "ok"`);
      await evalExpr('window.__LAB__.renderNow(); "ok"');
      const postSync = await evalExpr('window.__LAB__.rigSyncCheck()');
      const postDisp = await evalExpr('window.__LAB__.rigDisplacementFromSpawnM()');
      const readout = JSON.parse(await evalExpr('JSON.stringify(window.__LAB__.readout)'));
      console.log(`[crash-lab-sled-sync] ${kase.id}: post-impact rigSyncCheck=${postSync}m, rigDisplacementFromSpawnM=${postDisp}m, chassisPeakDecelG=${readout.chassisPeakDecelG}`);
      // Past the guide's armedUntilS the trolley is a free body -- the assertion here is just that the
      // mesh is STILL tracking it (not that it's still being guided), same <0.05m bar applies.
      assert(`${kase.id}: rigSyncCheck() < 0.05m post-impact (mesh still tracks body)`, typeof postSync === 'number' && postSync < 0.05, postSync);
      assert(`${kase.id}: a real collision registered (chassis peak decel > 5g)`, readout.chassisPeakDecelG > 5, readout.chassisPeakDecelG);

      await shot(`${kase.id}-02-post-impact.png`);

      // ---- Numeric-only: confirm the run eventually reaches 'settled' (no screenshot -- by then this
      // frictionless trolley has coasted far downrange, see CASES's doc comment).
      await evalExpr(`window.__LAB__.stepN(${kase.settleSteps - kase.postImpactSteps}); "ok"`);
      const runState = await evalExpr('window.__LAB__.runState');
      assert(`${kase.id}: run reaches 'settled' by step ${kase.settleSteps}`, runState === 'settled', runState);
    }

    c.ws.close();
  } catch (err) {
    console.error('[crash-lab-sled-sync] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[crash-lab-sled-sync] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  const failed = assertions.filter((a) => !a.pass);
  writeFileSync(path.join(__dirname, 'console-report-crash-lab-sled-sync.json'), JSON.stringify({ assertions, failed, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2));
  console.log(`[crash-lab-sled-sync] assertions: ${assertions.length - failed.length}/${assertions.length} passed`);

  if (consoleErrors.length > 0 || pageErrors.length > 0 || failed.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
