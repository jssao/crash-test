// SPDX-License-Identifier: MIT
//
// Crash Lab verification harness (docs/build-log/specs/crash-deformation-reference.md +
// game/src/lab/**). Same headless-Brave CDP pattern as verify/shoot.mjs and
// verify/crash-realism/shoot-matrix.mjs: loads crash-lab.html, runs the NHTSA full-frontal 56 km/h
// protocol deterministically (window.__LAB__.stepN), asserts the readout lands in the reference-spec
// bands, and screenshots TOP/SIDE/THREE-QUARTER for an eyes-on check.
//
// Reference bands: crash-deformation-reference.md's per-class table only tabulates 40/64/80/120 km/h
// full-frontal; 56 km/h (NHTSA NCAP's actual speed) sits between the 40 km/h (~0.18-0.35m) and 80 km/h
// (~0.45-0.56m) rows. The lab's OWN crush probe (src/lab/instrumentation.ts) measures over the real
// GLB shell geometry, not the headless sim harness's synthetic grid-plane proxy, so its absolute number
// won't exactly match game/sim/crash-realism-harness.mjs's -- the band below (0.18-0.50m) is set wide
// enough to comfortably straddle both neighboring rows while still being a real, falsifiable check
// (measured directly against a throwaway sim-harness run at 56 km/h before writing this: crush=0.330m,
// hood broken, both doors attached -- see this task's dispatch notes).
//
// Usage: node verify/crash-lab.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9433;
const PREVIEW_PORT = 4179;
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
  console.log('[crash-lab] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);

  console.log('[crash-lab] launching headless Brave...');
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-crash-lab-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
  const assertions = [];
  let exitCode = 0;

  const assert = (label, cond, detail) => {
    assertions.push({ label, pass: !!cond, detail });
    console.log(`[crash-lab] ${cond ? 'PASS' : 'FAIL'} — ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
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
    console.log('[crash-lab] lab ready');
    await sleep(1000);

    // Protocol list sanity: the 7 protocols the spec asked for are all present.
    const protocolIds = await evalExpr('window.__LAB__.protocols.map(p => p.id)');
    const expectedIds = ['nhtsa-frontal-56', 'iihs-moderate-64', 'iihs-small-64', 'side-mdb-50', 'side-pole-32', 'rear-80', 'free'];
    assert('all 7 protocols present', expectedIds.every((id) => protocolIds.includes(id)), protocolIds);

    // Run the NHTSA full-frontal 56 km/h protocol deterministically (stepN, no real-time animation
    // dependency), then read the instrumentation.
    await evalExpr("window.__LAB__.run('nhtsa-frontal-56'); 'ok'");
    await evalExpr('window.__LAB__.stepN(600); "ok"'); // 10s of physics @ 60Hz -- comfortably past this run's settle window
    const readout = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
    const runState = await evalExpr('window.__LAB__.runState');
    console.log('[crash-lab] readout:', JSON.stringify(readout));

    assert('run settled after 600 fixed steps', runState === 'settled', runState);
    assert('front crush within reference band [0.18, 0.50]', readout.crush.front.depthM > 0.18 && readout.crush.front.depthM < 0.5, readout.crush.front);
    assert('hood shows damage (loosened or broken)', readout.panelStates.hood === 'loosened' || readout.panelStates.hood === 'broken', readout.panelStates.hood);
    // Reference spec's universal invariant (crash-deformation-reference.md): a door may loosen/jam in a
    // frontal, it must never BREAK/DETACH ("struck door JAMMED, ATTACHED", never "detaches") -- checked
    // against panelStates directly (not a stricter "still fully attached") since the shared damage
    // model's exact loosen/break threshold is live-tuned by a concurrent work-stream this same wave
    // (game/src/damage/**, game/src/vehicle/tuning.ts) and can legitimately shift within this invariant.
    assert('neither door BREAKS/detaches (frontal, direction-aware weld model)', readout.panelStates.doorL !== 'broken' && readout.panelStates.doorR !== 'broken', readout.panelStates);
    // Same loosen-vs-break relaxation as the door check above: the trunk lid is only vulnerable to
    // REAR hits by direction (damage-tuning.ts's PANEL_VULNERABILITY signed gate), so a frontal should
    // give it ~zero stress structurally regardless of scalar retuning -- but the reference table itself
    // doesn't tabulate a trunk row at all, so "never even loosens" isn't a documented requirement the
    // way "doors never break" is. Assert the same never-detaches invariant, not full non-loosening.
    assert('trunk does not BREAK/detach (frontal)', readout.panelStates.trunk !== 'broken', readout.panelStates.trunk);
    assert('dented vertex count > 0', readout.dentedVertexCount > 0, readout.dentedVertexCount);
    assert('4 occupant seats reported', readout.occupants.length === 4, readout.occupants.length);

    // Crush M2: MECHANICAL structural readout (vehicle/segments.ts telemetry via the lab HUD).
    // Band: the sim-harness 56 km/h frontal measures mech crush 0.382m (sim/segment-yield.test.mjs's
    // logged baseline); the lab's protocol adds approach/guide dynamics, so straddle generously while
    // staying falsifiable (a dead mechanism reads ~0.1, a runaway one 0.58).
    assert('mechanical front crush within [0.25, 0.52]', readout.mechCrushFrontM > 0.25 && readout.mechCrushFrontM < 0.52, readout.mechCrushFrontM);
    assert('mechanical rear crush ~0 in a frontal', readout.mechCrushRearM < 0.05, readout.mechCrushRearM);
    assert('intrusion readout present and under the 0.15m leg-injury line at 56', readout.intrusionM >= 0 && readout.intrusionM < 0.15, readout.intrusionM);

    // Export report hook returns a well-formed, JSON-serializable object.
    const report = await evalExpr('JSON.stringify(window.__LAB__.exportReport())').then((s) => JSON.parse(s));
    assert('export report carries the run protocol id', report.protocol.id === 'nhtsa-frontal-56', report.protocol.id);
    assert('export report carries the mechanical segment telemetry', report.segments && typeof report.segments.intrusionM === 'number', Object.keys(report.segments ?? {}));

    // Screenshots: TOP / SIDE / THREE-QUARTER, same convention as crash-realism/shoot-matrix.mjs.
    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
      console.log(`[crash-lab] wrote ${name}`);
    };
    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await sleep(500);
    await shot('crash-lab-3q.png');
    await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
    await sleep(500);
    await shot('crash-lab-side.png');
    await evalExpr("window.__LAB__.setCameraPreset('top'); 'ok'");
    await sleep(500);
    await shot('crash-lab-top.png');

    // ---- Crush M2 gate: IIHS moderate-overlap 64 -- the struck side's hard structure must
    // MECHANICALLY shorten while the intact side stays pristine (segments telemetry), with a TOP
    // screenshot for the eyes-on review. ----
    await evalExpr("window.__LAB__.run('iihs-moderate-64'); 'ok'");
    await evalExpr('window.__LAB__.stepN(600); "ok"');
    const offsetReport = await evalExpr('JSON.stringify(window.__LAB__.exportReport())').then((s) => JSON.parse(s));
    const core = offsetReport.segments?.coreRetreatFrontM ?? { pos: 0, neg: 0 };
    const struckRetreat = Math.max(core.pos, core.neg);
    const intactRetreat = Math.min(core.pos, core.neg);
    console.log('[crash-lab] offset segments:', JSON.stringify(offsetReport.segments));
    assert('offset64: struck-side core collapses (>0.15m)', struckRetreat > 0.15, core);
    assert('offset64: intact-side core stays (<0.05m)', intactRetreat < 0.05, core);
    const w = offsetReport.segments?.weldCrushM ?? {};
    const struckCells = core.pos >= core.neg ? [w.cellFL, w.cellRL] : [w.cellFR, w.cellRR];
    const intactCells = core.pos >= core.neg ? [w.cellFR, w.cellRR] : [w.cellFL, w.cellRL];
    assert('offset64: struck-side rail mechanically shortened (front cell >0.08m)', struckCells[0] > 0.08, struckCells);
    assert('offset64: intact-side rail cells pristine (<0.02m)', intactCells.every((v) => v < 0.02), intactCells);
    await evalExpr("window.__LAB__.setCameraPreset('top'); 'ok'");
    await sleep(500);
    await shot('crash-lab-offset-top.png');

    c.ws.close();
  } catch (err) {
    console.error('[crash-lab] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[crash-lab] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  const failed = assertions.filter((a) => !a.pass);
  writeFileSync(path.join(OUT_DIR, 'console-report-crash-lab.json'), JSON.stringify({ assertions, failed, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2));
  console.log(`[crash-lab] assertions: ${assertions.length - failed.length}/${assertions.length} passed`);

  if (consoleErrors.length > 0 || pageErrors.length > 0 || failed.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
