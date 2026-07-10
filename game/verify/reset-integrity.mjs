// RESET-INTEGRITY regression (browser-level, exit-gated).
//
// Guards the "wrecked hood/doors on a freshly-reset car" blocker: crashing hard loosens/breaks the
// panels (their visual meshes get reparented out to the scene root -- panelVisuals.ts's
// reparentPanelVisual()), and a subsequent R (car repair) / Shift+R (world repair) must put every
// panel visual back EXACTLY where it started. The original bug (fixed in panelVisuals.ts's
// repairPanelVisual()) re-parented each panel node to carRoot instead of its authored GLB parent
// ('BodyUnderside' / 'BodyRearPanelsColor1', both ~-90deg-about-X rotated), so the restored panels
// rendered ~90deg mis-posed even though EVERY physics hook (body counts, detachedCount, panel state,
// displacements) reported them pristine/attached -- the corruption lived purely in the VISUAL layer.
//
// WHY THE HARD GATE IS THE LOCAL (RELATIVE-TO-PARENT) POSE, NOT A WORLD-ABSOLUTE ONE: the real game
// runs a real-time rAF loop that keeps stepping physics between our scripted stepN() batches, and the
// rendered car.root pose (which drives the panel meshes' world matrices, minus a constant
// CHASSIS_ORIGIN_HEIGHT_M translateY) is the INTERPOLATED pose, one alpha-lerp behind the physics
// chassis body. So any world-space or chassis-body-relative panel measurement carries a
// whole-car render-vs-physics sampling offset (~10cm while the car is still settling) that is NOT a
// panel defect. The panel's pose ON the car is fully pinned by its LOCAL transform under its authored
// GLB parent (the parent chain above the panels -- car.root .. BodyUnderside -- is static baked
// geometry, never rebuilt on reset): if localPos/localQuat/localScale match the boot reference AND the
// parent node is the authored one, the panel renders in EXACTLY its boot pose relative to the visible
// car. That is the deterministic, artifact-free invariant this test gates on. The original bug
// (repairPanelVisual re-parenting to carRoot instead of BodyUnderside) is caught precisely: the local
// values were copied back correctly but under the WRONG parent, mis-posing the panel ~90deg. We ALSO
// assert the panel is attached/not-reparented/not-despawned and dentedVertexCount==0 (crumple geometry
// un-deformed), and log the chassis-relative world delta purely as diagnostic context.
//
// Ports are distinct from shoot.mjs (9422/4173) and panel-pose (9452/5219) so this can run alongside.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9467;
const PREVIEW_PORT = 4189;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = path.join(__dirname, 'reset-integrity');
const PANEL_KEYS = ['hood', 'doorL', 'doorR', 'trunk'];
const POS_TOL_M = 0.05; // 5 cm
const ANG_TOL_DEG = 5; // 5 deg
const RESET_WORLD_CYCLES = 5;
const RESET_CAR_CYCLES = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

// ---- tiny quat/vec helpers (arrays: v=[x,y,z], q=[x,y,z,w]) ----
function qConj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
function qRotate(q, v) {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qAngleDeg(a, b) { const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; return (2 * Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI; }
function vDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

/** Panel visual world pose (worldPos/worldQuat) expressed in the chassis body frame. */
function panelInChassisFrame(panel, chassis) {
  const invQ = qConj(chassis.quat);
  const dp = [panel.worldPos[0] - chassis.pos[0], panel.worldPos[1] - chassis.pos[1], panel.worldPos[2] - chassis.pos[2]];
  return { relPos: qRotate(invQ, dp), relQuat: qMul(invQ, panel.worldQuat) };
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); });
  return { ready, send, ws };
}
function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) { try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {} await sleep(300); }
      reject(new Error('preview server never came up'));
    })();
  });
}
async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const pg = tabs.find((t) => t.type === 'page'); if (pg?.webSocketDebuggerUrl) return pg.webSocketDebuggerUrl; } catch {} await sleep(500); }
  throw new Error('no devtools page target');
}

async function main() {
  console.log('[reset-integrity] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[reset-integrity] preview up at', URL);

  console.log('[reset-integrity] launching headless Brave...');
  const browser = spawn(
    BROWSER,
    ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--window-size=1280,720', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-reset-integrity-brave', 'about:blank'],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  const failures = [];
  let exitCode = 0;

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
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const ev = (e) => c.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }).then((r) => { if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r?.result?.value; });

    let ok = false;
    for (let i = 0; i < 60; i++) { if (await ev('window.__GAME__ && window.__GAME__.ready === true')) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    await sleep(1500);
    // Neutral input for the whole run (headless has no keyboard) + a close orbit for the screenshots.
    await ev('window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: 0 }); window.__GAME__.setOrbitView({ radius: 7, height: 2.6, targetHeight: 0.7 }); "ok"');

    async function shot(tag) {
      await ev(`window.__GAME__.setFixedAngle(${Math.PI / 2}); "ok"`); // front
      await sleep(450);
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, `${tag}.png`), Buffer.from(s.data, 'base64'));
      console.log(`[reset-integrity] wrote ${tag}.png`);
    }

    // Boot reference (pristine, before any crash), settled.
    await ev('window.__GAME__.stepN(60); "ok"');
    await sleep(300);
    const bootDump = await ev('window.__GAME__.dumpPanelVisuals()');
    const bootRef = {};
    for (const k of PANEL_KEYS) {
      const p = bootDump.panels[k];
      bootRef[k] = {
        localPos: p.localPos,
        localQuat: p.localQuat,
        localScale: p.localScale,
        parent: p.parent,
        chassisRel: panelInChassisFrame(p, bootDump.chassis), // diagnostic only
      };
    }
    await shot('boot-front');
    console.log('[reset-integrity] boot reference captured:', PANEL_KEYS.map((k) => `${k}@${bootRef[k].parent}`).join(' '));

    // Assert one post-reset dump against the boot reference. Records (does not throw) failures so all
    // panels/cycles are reported, then the run exit-gates on the collected list.
    function assertReset(label, dump) {
      let worstLocalPos = 0;
      let worstLocalAng = 0;
      let worstChassisRelPos = 0; // diagnostic only (whole-car render/physics settling offset)
      const dentedVertexCount = dump.dentedVertexCount;
      for (const k of PANEL_KEYS) {
        const p = dump.panels[k];
        const ref = bootRef[k];
        // HARD GATE: local pose relative to the authored parent (artifact-free -- see file header).
        const dLocalPos = vDist(p.localPos, ref.localPos);
        const dLocalAng = qAngleDeg(p.localQuat, ref.localQuat);
        const dScale = Math.max(Math.abs(p.localScale[0] - ref.localScale[0]), Math.abs(p.localScale[1] - ref.localScale[1]), Math.abs(p.localScale[2] - ref.localScale[2]));
        worstLocalPos = Math.max(worstLocalPos, dLocalPos);
        worstLocalAng = Math.max(worstLocalAng, dLocalAng);
        worstChassisRelPos = Math.max(worstChassisRelPos, vDist(panelInChassisFrame(p, dump.chassis).relPos, ref.chassisRel.relPos));
        const problems = [];
        if (p.parent !== ref.parent) problems.push(`parent '${p.parent}' != authored '${ref.parent}'`);
        if (dLocalPos > POS_TOL_M) problems.push(`localPos ${(dLocalPos * 100).toFixed(2)}cm > ${POS_TOL_M * 100}cm`);
        if (dLocalAng > ANG_TOL_DEG) problems.push(`localAng ${dLocalAng.toFixed(2)}deg > ${ANG_TOL_DEG}deg`);
        if (dScale > 0.01) problems.push(`scale drift ${dScale.toFixed(3)}`);
        if (p.reparented) problems.push('still reparented (mesh not returned under car group)');
        if (p.state !== 'attached') problems.push(`state '${p.state}' != attached`);
        if (p.despawned) problems.push('despawned');
        if (problems.length) failures.push(`[${label}] ${k}: ${problems.join('; ')}`);
      }
      if (dentedVertexCount !== 0) failures.push(`[${label}] dentedVertexCount ${dentedVertexCount} != 0 (crumple not repaired)`);
      console.log(
        `[reset-integrity] ${label}: worstLocalPos=${(worstLocalPos * 100).toFixed(2)}cm worstLocalAng=${worstLocalAng.toFixed(2)}deg dented=${dentedVertexCount} (diag: chassisRelPos=${(worstChassisRelPos * 100).toFixed(1)}cm)`,
      );
    }

    // One crash->reset cycle. `resetFn` is 'resetWorld' or 'resetCar'.
    async function cycle(label, resetFn, tag) {
      await ev('window.__GAME__.spawnTestWall(12); "ok"');
      await ev('window.__GAME__.crash(120); "ok"');
      await ev('window.__GAME__.stepN(180); "ok"'); // ~3s: reach wall, break panels, scatter, settle
      await sleep(300);
      // Sanity: the crash must actually have damaged the car, else the reset isn't being exercised.
      const crashed = await ev('window.__GAME__.dumpPanelVisuals()');
      const anyDamaged = PANEL_KEYS.some((k) => crashed.panels[k].state !== 'attached' || crashed.panels[k].reparented);
      if (!anyDamaged) failures.push(`[${label}] crash did not damage any panel -- scenario not exercising reset`);
      await ev(`window.__GAME__.${resetFn}(); "ok"`);
      await ev('window.__GAME__.stepN(90); "ok"'); // settle the fresh car (spawn pose, zero velocity)
      await sleep(300);
      const dump = await ev('window.__GAME__.dumpPanelVisuals()');
      dump.dentedVertexCount = await ev('window.__GAME__.telemetry.damage.dentedVertexCount');
      assertReset(label, dump);
      await shot(tag);
    }

    for (let i = 1; i <= RESET_WORLD_CYCLES; i++) await cycle(`resetWorld #${i}`, 'resetWorld', `world-cy${i}-reset-front`);
    for (let i = 1; i <= RESET_CAR_CYCLES; i++) await cycle(`resetCar #${i}`, 'resetCar', `car-cy${i}-reset-front`);

    c.ws.close();
  } catch (err) {
    console.error('[reset-integrity] ERROR', err);
    failures.push(`harness error: ${err.message}`);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[reset-integrity] === SUMMARY ===');
  console.log('console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('assertion failures:', failures.length);
  failures.forEach((f) => console.log(`  FAIL ${f}`));

  writeFileSync(
    path.join(OUT_DIR, 'console-report-reset-integrity.json'),
    JSON.stringify({ failures, consoleErrors, pageErrors, tolerances: { POS_TOL_M, ANG_TOL_DEG }, cycles: { RESET_WORLD_CYCLES, RESET_CAR_CYCLES }, timestamp: new Date().toISOString() }, null, 2),
  );

  if (failures.length > 0 || consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  console.log(`[reset-integrity] ${exitCode === 0 ? 'PASS' : 'FAIL'}`);
  process.exit(exitCode);
}

main();
