// SPDX-License-Identifier: MIT
//
// P013 visual: the crash-lab renders reliably headlessly (the main game hangs at its device-quality
// auto-tune under stepN), so capture the lab's PRISTINE car (reset, before any run) from two angles.
// This is the shell the P013 hard-driving battery leaves untouched -- p013-hard-driving.test.mjs proves
// 630 steps of aggressive driving produce zero plastic crush / zero dents / zero loosen-or-detach, i.e.
// the rendered car stays exactly this pristine. Usage: node verify/shoot-p013.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const outDir = path.resolve(gameRoot, '..', 'screenshots', 'P013_car-deformation-system', 'sim');
const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9448;
const PREVIEW_PORT = 4187;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() { while (Date.now() - start < timeoutMs) { try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {} await sleep(300); } reject(new Error('preview never came up')); })();
  });
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map();
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); });
  return { ready, send, ws };
}
async function getWsUrl(port) { for (let i = 0; i < 60; i++) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {} await sleep(500); } throw new Error('no page target'); }

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'ignore' });
  await waitForHttp(URL);
  const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-p013-brave', 'about:blank'], { stdio: 'ignore' });
  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready; await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
    await c.send('Page.navigate', { url: URL });
    let ok = false; for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('__LAB__ never ready');
    await sleep(800);
    await evalExpr("window.__LAB__.reset(); window.__LAB__.stepN(120); 'ok'"); // settle the pristine car on its wheels
    mkdirSync(outDir, { recursive: true });
    for (const preset of ['3q', 'side']) {
      await evalExpr(`window.__LAB__.setCameraPreset('${preset}'); 'ok'`);
      await sleep(700);
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      const p = path.join(outDir, `sim-pristine-${preset}.png`);
      writeFileSync(p, Buffer.from(s.data, 'base64'));
      console.log(`[shoot-p013] wrote ${p}`);
    }
    const readout = await evalExpr('JSON.stringify({panels: window.__LAB__.readout.panelStates, wheels: window.__LAB__.readout.wheelStates, front: window.__LAB__.readout.mechCrushFrontM, dented: window.__LAB__.readout.dentedVertexCount})');
    console.log('[shoot-p013] pristine readout:', readout);
  } catch (e) { console.error('[shoot-p013] ERROR', e); }
  finally { try { browser.kill(); } catch {} try { preview.kill(); } catch {} }
}
main();
