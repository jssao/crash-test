// SPDX-License-Identifier: MIT
//
// Crash-realism comparison harness (docs/build-log/specs/crash-deformation-reference.md). Drives the
// REAL browser game through a scripted frontal-crash matrix (40 / 64 / 80 / 120 km/h) and screenshots
// each crash from THREE-QUARTER, SIDE and TOP, logging the damage telemetry (dented-vertex count +
// panel states) per run. The screenshots are opened and judged side-by-side against the reference
// spec's per-class descriptions. Numeric crush depth + the direction-aware door behaviour are asserted
// headlessly in game/sim/crash-realism.test.mjs; this harness is the EYES-ON half.
//
// Same headless-Brave CDP pattern as verify/shoot-crash.mjs. Usage: node verify/crash-realism/shoot-matrix.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..', '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9427;
const PREVIEW_PORT = 4178;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = __dirname;
const SPEEDS = [40, 64, 80, 120];
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
  console.log('[matrix] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);

  console.log('[matrix] launching headless Brave...');
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1200,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-matrix-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const consoleErrors = [];
  const pageErrors = [];
  const runs = [];
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
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    let ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('game never became ready');
    console.log('[matrix] game ready');
    await sleep(1500);

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
      console.log(`[matrix] wrote ${name}`);
    };
    // Three view presets (orbit camera tracks the car's current position post-crash).
    const viewThreeQuarter = async () => { await evalExpr(`window.__GAME__.setOrbitView({radius:8,height:3,targetHeight:0.6}); window.__GAME__.setFixedAngle(${Math.PI / 3}); 'ok'`); await sleep(500); };
    const viewSide = async () => { await evalExpr(`window.__GAME__.setOrbitView({radius:7.5,height:1.4,targetHeight:0.6}); window.__GAME__.setFixedAngle(${Math.PI / 2}); 'ok'`); await sleep(500); };
    const viewTop = async () => { await evalExpr(`window.__GAME__.setOrbitView({radius:1.2,height:15,targetHeight:0.3}); window.__GAME__.setFixedAngle(${Math.PI / 4}); 'ok'`); await sleep(500); };

    // Baseline (pristine) three-quarter shot for reference.
    await evalExpr('window.__GAME__.resetCar(); window.__GAME__.resetWorld(); "ok"');
    await sleep(400);
    await viewThreeQuarter();
    await shot('matrix-00-baseline-3q.png');

    for (const speed of SPEEDS) {
      // Repair, then spawn wall + crash at this speed, step deterministically through the impact.
      await evalExpr('window.__GAME__.resetCar(); window.__GAME__.resetWorld(); "ok"');
      await sleep(300);
      await evalExpr('window.__GAME__.spawnTestWall(12); "ok"');
      await evalExpr(`window.__GAME__.crash(${speed}); "ok"`);
      await evalExpr('window.__GAME__.stepN(360); "ok"');
      const tel = await evalExpr('JSON.stringify(window.__GAME__.telemetry.damage)');
      const dmg = JSON.parse(tel);
      runs.push({ speed, damage: dmg });
      console.log(`[matrix] ${speed}km/h dented=${dmg.dentedVertexCount} panels=${JSON.stringify(dmg.panelStates)}`);
      const tag = `matrix-${String(speed).padStart(3, '0')}`;
      await viewThreeQuarter(); await shot(`${tag}-3q.png`);
      await viewSide(); await shot(`${tag}-side.png`);
      await viewTop(); await shot(`${tag}-top.png`);
    }
    c.ws.close();
  } catch (err) {
    console.error('[matrix] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[matrix] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  // Report: doors must stay attached in every frontal run; deformation must be present.
  const doorFailures = runs.filter((r) => ['doorL', 'doorR'].some((k) => r.damage.panelStates[k] === 'broken'));
  const noDamage = runs.filter((r) => r.damage.dentedVertexCount === 0);
  writeFileSync(path.join(OUT_DIR, 'console-report-matrix.json'), JSON.stringify({ runs, doorFailures, noDamage, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2));
  console.log(`[matrix] frontal door detachments (must be 0): ${doorFailures.length}`);

  if (consoleErrors.length > 0 || pageErrors.length > 0 || doorFailures.length > 0 || noDamage.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
