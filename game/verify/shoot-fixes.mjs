// SPDX-License-Identifier: MIT
//
// Visual evidence for the P013/P007/P012/P014/P004 damage-core fixes. Same headless-Brave CDP pattern
// as verify/crash-lab.mjs (SwiftShader WebGL, raw DevTools Protocol, its OWN vite preview -- never
// touches the dev server on :5173). Drives the crash-lab (__LAB__) protocols for the crash scenarios and
// the main game (__GAME__) for the hard-driving battery, and captures screenshots into the per-bug
// screenshots/*/sim/ folders. Usage: node verify/shoot-fixes.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const shotsRoot = path.resolve(gameRoot, '..', 'screenshots');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9447;
const PREVIEW_PORT = 4186;
const BASE = `http://localhost:${PREVIEW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); });
  return { ready, send, ws };
}
async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {} await sleep(500); }
  throw new Error('no devtools page target');
}

async function main() {
  console.log('[shoot-fixes] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', () => {});
  preview.stderr.on('data', () => {});
  await waitForHttp(`${BASE}/crash-lab.html`);

  console.log('[shoot-fixes] launching headless Brave...');
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-shootfixes-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const written = [];
  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
    const shot = async (dir, name) => {
      mkdirSync(dir, { recursive: true });
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(dir, name);
      writeFileSync(p, Buffer.from(s.data, 'base64'));
      written.push(p);
      console.log(`[shoot-fixes] wrote ${p}`);
    };

    // ---- Part A: crash-lab protocols ----
    await c.send('Page.navigate', { url: `${BASE}/crash-lab.html` });
    let ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('__LAB__.ready never became true');
    console.log('[shoot-fixes] lab ready');
    await sleep(800);

    const runLab = async (setup, stepN = 600) => {
      await evalExpr(setup);
      await evalExpr(`window.__LAB__.stepN(${stepN}); "ok"`);
      await sleep(300);
    };
    const labShots = async (dir, prefix, presets) => {
      for (const preset of presets) {
        await evalExpr(`window.__LAB__.setCameraPreset('${preset}'); 'ok'`);
        await sleep(600);
        await shot(dir, `${prefix}-${preset}.png`);
      }
    };

    // P004 side-mdb-50: deep flank/door intrusion (3q + side + top)
    await runLab("window.__LAB__.run('side-mdb-50'); 'ok'");
    const p004Readout = await evalExpr('JSON.stringify({lat: window.__LAB__.lateralInputs(), struct: window.__LAB__.maxStructuralOffsetM(), panels: window.__LAB__.readout.panelStates})');
    console.log('[shoot-fixes] P004 side-mdb-50:', p004Readout);
    await labShots(path.join(shotsRoot, 'P004_side-impact-damage', 'sim'), 'sim-side-mdb-50', ['3q', 'side', 'top']);
    // P007 (side half): the trunk stays intact in the side hit -- top view.
    await labShots(path.join(shotsRoot, 'P007_impact-dislodges-wrong-parts', 'sim'), 'sim-side-mdb-50-trunk-intact', ['top', '3q']);

    // P012 frontal 100 km/h: wheels stay attached.
    await runLab("window.__LAB__.setFreeConfig({ speedKmh: 100, offsetM: 0, angleDeg: 0 }); window.__LAB__.run('free'); 'ok'");
    const p012Readout = await evalExpr('JSON.stringify({wheels: window.__LAB__.readout.wheelStates, panels: window.__LAB__.readout.panelStates})');
    console.log('[shoot-fixes] P012 free-100:', p012Readout);
    await labShots(path.join(shotsRoot, 'P012_wheels-fly-off', 'sim'), 'sim-frontal-100', ['3q', 'side']);
    // P007 (frontal half): doors stay attached in a 100 km/h frontal.
    await labShots(path.join(shotsRoot, 'P007_impact-dislodges-wrong-parts', 'sim'), 'sim-frontal-100-doors-attached', ['3q']);

    // P014 catastrophic 340 km/h: front crushed to the A-pillar (3q + side + top).
    await runLab("window.__LAB__.setFreeConfig({ speedKmh: 340, offsetM: 0, angleDeg: 0 }); window.__LAB__.run('free'); 'ok'");
    const p014Readout = await evalExpr('JSON.stringify({front: window.__LAB__.readout.mechCrushFrontM, wheels: window.__LAB__.readout.wheelStates, panels: window.__LAB__.readout.panelStates})');
    console.log('[shoot-fixes] P014 free-340:', p014Readout);
    await labShots(path.join(shotsRoot, 'P014_340kmh-crash-deform', 'sim'), 'sim-340kmh', ['3q', 'side', 'top']);

    // ---- Part B: main game hard-driving battery (P013) ----
    await c.send('Page.navigate', { url: `${BASE}/` });
    let gok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('!!(window.__GAME__)')) === true) { gok = true; break; } await sleep(500); }
    if (!gok) throw new Error('__GAME__ never became available');
    console.log('[shoot-fixes] game ready');
    await sleep(800);
    await evalExpr('window.__GAME__.resetCar(); window.__GAME__.resetWorld(); "ok"');
    const drive = async (input, n) => { await evalExpr(`window.__GAME__.setInput(${JSON.stringify(input)}); window.__GAME__.stepN(${n}); "ok"`); };
    await drive({ throttle: 1, brake: 0, steer: 0, handbrake: false }, 110);
    await drive({ throttle: 1, brake: 0, steer: 0.7, handbrake: false }, 100);
    await drive({ throttle: 0, brake: 1, steer: -0.7, handbrake: false }, 100);
    await drive({ throttle: 1, brake: 0, steer: -0.6, handbrake: false }, 100);
    await drive({ throttle: 0.5, brake: 0, steer: 0.9, handbrake: true }, 100);
    await drive({ throttle: 0, brake: 1, steer: 0, handbrake: false }, 110);
    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(60); "ok"');
    const p013 = await evalExpr('JSON.stringify(window.__GAME__.damageTelemetry ? window.__GAME__.damageTelemetry() : {note:"no telemetry hook"})').catch(() => '{}');
    console.log('[shoot-fixes] P013 post-drive telemetry:', p013);
    const p013Dir = path.join(shotsRoot, 'P013_car-deformation-system', 'sim');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 8, height: 3, targetHeight: 0.8 }); "ok"');
    await sleep(1200); await shot(p013Dir, 'sim-hard-driving-pristine-a.png');
    await sleep(1600); await shot(p013Dir, 'sim-hard-driving-pristine-b.png');

    console.log(`[shoot-fixes] done, wrote ${written.length} screenshots`);
  } catch (e) {
    console.error('[shoot-fixes] ERROR', e);
  } finally {
    try { browser.kill(); } catch {}
    try { preview.kill(); } catch {}
  }
}
main();
