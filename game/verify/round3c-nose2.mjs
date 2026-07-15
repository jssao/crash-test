// Round-3c: final nose micro-pass — hide the barrier rig for scuff close-ups; higher tree-nose angle.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');
const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9525, PREVIEW_PORT = 4225;
const LAB_URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForHttp(url, t = 30000) { return new Promise((res, rej) => { const s = Date.now(); (async function p() { while (Date.now() - s < t) { try { const r = await fetch(url); if (r.ok) return res(true); } catch {} await sleep(300); } rej(new Error('no preview')); })(); }); }
function cdp(wsUrl) { const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); }); ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } }); const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); }); return { ready, send, ws }; }
async function getWsUrl(port) { for (let i = 0; i < 60; i++) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {} await sleep(500); } throw new Error('no target'); }
let client;
async function evalExpr(expr) { const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page exception'); return r.result?.value; }
async function shot(bug, name) { await sleep(250); const r = await client.send('Page.captureScreenshot', { format: 'png' }); const dir = path.join(repoRoot, 'screenshots', bug, 'sim'); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, name), Buffer.from(r.data, 'base64')); console.log(`[shot] ${bug}/${name}`); }
async function navigate(url, readyExpr) { await client.send('Page.navigate', { url }); for (let i = 0; i < 120; i++) { await sleep(500); try { if (await evalExpr(readyExpr)) return; } catch {} } throw new Error('never ready'); }
const lab = async (e) => evalExpr(`window.__LAB__.${e}; 'ok'`);
const render = async () => evalExpr(`window.__LAB__.renderNow(); 'ok'`);
async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  await waitForHttp(LAB_URL);
  const brave = spawn(BROWSER, [`--remote-debugging-port=${CDP_PORT}`, '--headless=new', '--use-angle=swiftshader', '--window-size=1280,800', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  client = cdp(await getWsUrl(CDP_PORT)); await client.ready;
  await client.send('Page.enable'); await client.send('Runtime.enable');
  try {
    await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
    await lab(`run('nhtsa-frontal-56')`);
    await evalExpr(`window.__LAB__.stepN(400); 'ok'`);
    await lab(`setRigVisible(false)`);
    await lab(`setOrbitView({ radius: 4.2, height: 1.1, targetHeight: 0.7 })`);
    await lab(`setFixedAngle(${Math.PI / 2})`); await render();
    await shot('R004_no-paint-damage-hanging-parts', 'round3c-scuffs-nose-norig.png');
    await lab(`setOrbitView({ radius: 4.5, height: 2.8, targetHeight: 0.5 })`); await render();
    await shot('R004_no-paint-damage-hanging-parts', 'round3c-scuffs-hood-norig.png');
    await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
    await lab(`setFreeConfig({ speedKmh: 50, offsetM: 0, angleDeg: 0 })`);
    await lab(`setCrashTarget('tree-mid')`); await lab(`setCrashTargetDistance(14)`); await sleep(800);
    await lab(`run('free')`);
    await evalExpr(`window.__LAB__.stepN(300); 'ok'`);
    await lab(`setOrbitView({ radius: 6.5, height: 3.4, targetHeight: 0.4 })`);
    await lab(`setFixedAngle(${Math.PI / 2})`); await render();
    await shot('P002_deformation', 'round3c-nose-tree-high.png');
    console.log('[round3c] DONE');
  } finally { try { brave.kill(); } catch {}; try { preview.kill(); } catch {} }
}
main().catch((e) => { console.error('[round3c] FAILED:', e); process.exit(1); });
