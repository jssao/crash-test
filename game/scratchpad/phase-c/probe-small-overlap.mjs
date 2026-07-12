// Diagnostic-only (not part of the deliverable): measure current iihs-small-64 wheel/door outcomes
// via the crash lab, BEFORE any wheel/door-specific tweak.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..', '..');
const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9481;
const PREVIEW_PORT = 4211;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {}
        await sleep(300);
      }
      reject(new Error('preview never up'));
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
  throw new Error('no target');
}

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'ignore' });
  await waitForHttp(URL);
  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/probe-small-overlap-profile', 'about:blank',
  ], { stdio: 'ignore' });
  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Page.navigate', { url: URL });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
    let ok = false;
    for (let i = 0; i < 60; i++) { if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('lab never ready');
    await sleep(500);

    await evalExpr("window.__LAB__.run('iihs-small-64'); 'ok'");
    await evalExpr('window.__LAB__.stepN(600); "ok"');
    const readout = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
    const stress = await evalExpr('JSON.stringify(window.__LAB__.panelStress())').then((s) => JSON.parse(s));
    const report = await evalExpr('JSON.stringify(window.__LAB__.exportReport())').then((s) => JSON.parse(s));
    console.log('=== iihs-small-64 (BEFORE any wheel/door tweak) ===');
    console.log('panelStates:', JSON.stringify(readout.panelStates));
    console.log('wheelStates:', JSON.stringify(readout.wheelStates));
    console.log('panelStress:', JSON.stringify(stress));
    console.log('segments:', JSON.stringify(report.segments));
    console.log('mechCrushFrontM:', readout.mechCrushFrontM, 'crush:', JSON.stringify(readout.crush));

    c.ws.close();
  } finally {
    browser.kill();
    preview.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
