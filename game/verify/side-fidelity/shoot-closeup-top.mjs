// SPDX-License-Identifier: MIT
//
// Follow-up to shoot-side-fidelity.mjs: the lab's 'top' camera preset (radius 1.2, height 16) is tuned
// for the wide multi-protocol HUD screenshot, not a legible close read of the struck flank's silhouette
// -- this captures a CLOSER top-down zoom (barrier hidden) for the three side/small-overlap protocols
// only, to actually judge the cave-in read the task asks for.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..', '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9472;
const PREVIEW_PORT = 4210;
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
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
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
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  await waitForHttp(URL);
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-closeup-top-profile', 'about:blank',
  ], { stdio: 'ignore' });
  let exitCode = 0;
  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
    let ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('lab never ready');
    await sleep(800);

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
      console.log(`[closeup-top] wrote ${name}`);
    };

    async function closeup(label, runExpr) {
      await evalExpr(runExpr);
      await evalExpr('window.__LAB__.stepN(600); "ok"');
      await evalExpr("window.__LAB__.setRigVisible(false); 'ok'");
      // Close, near-vertical top-down zoom: small radius, moderate height, small negative fixed angle
      // so the camera stays on the approach side of any (now-hidden) barrier.
      await evalExpr("window.__LAB__.setOrbitView({ radius: 0.6, height: 5.5, targetHeight: 0.25 }); 'ok'");
      await evalExpr('window.__LAB__.setFixedAngle(-Math.PI / 4); "ok"');
      await sleep(600);
      await shot(`${label}-closeup-top.png`);
    }

    await closeup('side-mdb-50', "window.__LAB__.run('side-mdb-50'); 'ok'");
    await closeup('side-pole-32', "window.__LAB__.run('side-pole-32'); 'ok'");
    await closeup('iihs-small-64', "window.__LAB__.run('iihs-small-64'); 'ok'");
    await closeup('nhtsa-56', "window.__LAB__.run('nhtsa-frontal-56'); 'ok'");

    c.ws.close();
  } catch (err) {
    console.error('[closeup-top] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }
  process.exit(exitCode);
}
main();
