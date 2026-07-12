// Diagnostic-only: inspect lateralInputs() + maxStructuralOffsetM() + xHalf-ish geometry directly for
// side-mdb-50, to understand why the field wasn't engaging in the real GLB run.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..', '..');
const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9482;
const PREVIEW_PORT = 4212;
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
    '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/probe-lateral-profile', 'about:blank',
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

    await evalExpr("window.__LAB__.run('side-mdb-50'); 'ok'");
    await evalExpr('window.__LAB__.stepN(600); "ok"');
    const lat = await evalExpr('JSON.stringify(window.__LAB__.lateralInputs())').then((s) => JSON.parse(s));
    const structM = await evalExpr('window.__LAB__.maxStructuralOffsetM()');
    const dump = await evalExpr('JSON.stringify(window.__LAB__.dumpDeformables())').then((s) => JSON.parse(s));
    console.log('=== side-mdb-50 lateral diagnostic ===');
    console.log('lateralInputs:', JSON.stringify(lat));
    console.log('maxStructuralOffsetM:', structM);
    const chassisMeshes = dump.filter((d) => d.kind === 'chassis');
    console.log('num chassis meshes:', chassisMeshes.length);
    console.log('max boundsRadius among chassis meshes:', Math.max(...chassisMeshes.map((d) => d.boundsRadius)));
    console.log('chassis meshes with maxOffsetM>0.05, sorted by centerLocal.x:');
    chassisMeshes.filter((d) => d.maxOffsetM > 0.05).sort((a, b) => Math.abs(b.centerLocal.x) - Math.abs(a.centerLocal.x)).slice(0, 15).forEach((d) => {
      console.log(`  ${d.id}: centerLocal.x=${d.centerLocal.x.toFixed(3)} boundsRadius=${d.boundsRadius.toFixed(3)} maxOffsetM=${d.maxOffsetM.toFixed(3)}`);
    });

    c.ws.close();
  } finally {
    browser.kill();
    preview.kill();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
