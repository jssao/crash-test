// BUG R004 final verification — legible scuff/chip decals + hanging bumpers (shell split).
// Headless Brave CDP on ports 4243/9543 ONLY. Uses the Vite DEV server (serves current source, never a
// stale dist). Staging discipline mirrors verify/round3c-nose2.mjs: __LAB__.stepN + renderNow,
// setRigVisible(false) for nose/hang shots, setFixedAngle to face the target. Writes final-*.png into
// screenshots/R004_no-paint-damage-hanging-parts/sim/.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');
const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9543, PREVIEW_PORT = 4243;
const LAB_URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const OUT_DIR = path.join(repoRoot, 'screenshots', 'R004_no-paint-damage-hanging-parts', 'sim');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForHttp(url, t = 60000) { return new Promise((res, rej) => { const s = Date.now(); (async function p() { while (Date.now() - s < t) { try { const r = await fetch(url); if (r.ok) return res(true); } catch {} await sleep(400); } rej(new Error('no dev server')); })(); }); }
function cdp(wsUrl) { const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); }); ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } }); const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); }); return { ready, send, ws }; }
async function getWsUrl(port) { for (let i = 0; i < 80; i++) { try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {} await sleep(500); } throw new Error('no target'); }

let client;
async function evalExpr(expr) { const r = await client.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result?.value; }
async function shot(name) { await sleep(250); const r = await client.send('Page.captureScreenshot', { format: 'png' }); mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(path.join(OUT_DIR, name), Buffer.from(r.data, 'base64')); console.log(`[shot] ${name}`); }
async function navigate(url, readyExpr) { await client.send('Page.navigate', { url }); for (let i = 0; i < 160; i++) { await sleep(500); try { if (await evalExpr(readyExpr)) return; } catch {} } throw new Error('never ready'); }
const lab = async (e) => evalExpr(`window.__LAB__.${e}; 'ok'`);
const render = async () => evalExpr(`window.__LAB__.renderNow(); 'ok'`);

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', () => {});
  preview.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForHttp(LAB_URL);
  const brave = spawn(BROWSER, [`--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1', '--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,800', '--force-device-scale-factor=1', '--no-first-run', '--mute-audio', '--user-data-dir=/tmp/game-verify-r004-brave', 'about:blank'], { stdio: 'ignore' });
  client = cdp(await getWsUrl(CDP_PORT)); await client.ready;
  await client.send('Page.enable'); await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const diag = {};
  try {
    await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
    await sleep(800);

    // CAMERA CONVENTION (lab/main.ts applyCameraPreset doc): camera offset = (cos a, h, sin a)*r from
    // the resting car. The car's crushed NOSE is at +Z, so a FRONT shot needs sin(a) > 0 (a in (0,PI));
    // rig hidden so the camera can sit on the barrier's side. Rear (tail, -Z) needs sin(a) < 0.
    const A_FRONT = Math.PI / 2;         // straight-on nose
    const A_FRONT_3Q = (2 * Math.PI) / 3; // front + far (-X) quarter
    const A_SIDE = Math.PI / 12;          // near-profile biased slightly toward the front
    const A_REAR = -Math.PI / 2;          // straight-on tail
    const A_REAR_3Q = (-2 * Math.PI) / 3; // rear + far (-X) quarter

    // (c) PRISTINE pre-crash: split must be invisible (no seams / z-fighting at the front cut line).
    await lab(`reset()`);
    await lab(`setOrbitView({ radius: 3.8, height: 1.2, targetHeight: 0.5 })`);
    await lab(`setFixedAngle(${A_FRONT_3Q})`); await render();
    await shot('final-pristine-front-3q.png');
    diag.pristineBumpers = await evalExpr('JSON.stringify(window.__FX__.bumpers())');

    // (a) NHTSA-56 frontal nose close-up with LEGIBLE scuffs (the exact shot that failed before).
    await lab(`run('nhtsa-frontal-56')`);
    await evalExpr('window.__LAB__.stepN(420); "ok"');
    diag.scuff56 = {
      counters: await evalExpr('JSON.stringify(window.__FX__.counters())'),
      bumpers: await evalExpr('JSON.stringify(window.__FX__.bumpers())'),
      frontCrushPlasticM: await evalExpr('window.__LAB__.exportReport().segments.frontCrushPlasticM ?? window.__LAB__.readout.mechCrushFrontM'),
      worstSync: await evalExpr('Math.max(...window.__LAB__.deformableSyncCheck().map(e=>e.maxErrorM))'),
      structM: await evalExpr('window.__LAB__.maxStructuralOffsetM()'),
      dented: await evalExpr('window.__LAB__.readout.dentedVertexCount'),
    };
    await lab(`setRigVisible(false)`);
    await lab(`setOrbitView({ radius: 3.4, height: 0.9, targetHeight: 0.5 })`);
    await lab(`setFixedAngle(${A_FRONT})`); await render();
    await shot('final-scuffs-nose-56.png');
    // a second scuff angle (front-3q close) so the scuffs are provable from more than one view
    await lab(`setOrbitView({ radius: 3.8, height: 1.3, targetHeight: 0.55 })`);
    await lab(`setFixedAngle(${A_FRONT_3Q})`); await render();
    await shot('final-scuffs-nose-3q.png');

    // (b) HANGING FRONT BUMPER after a hard frontal (free 100 km/h -- in the requested 100-130 band, a
    // touch less total-obliteration than 120 so the drooped bumper reads as a distinct hanging part).
    await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
    await lab(`setFreeConfig({ speedKmh: 100, offsetM: 0, angleDeg: 0 })`);
    await sleep(300);
    await lab(`run('free')`);
    await evalExpr('window.__LAB__.stepN(520); "ok"');
    diag.hardFront = {
      bumpers: await evalExpr('JSON.stringify(window.__FX__.bumpers())'),
      frontCrushPlasticM: await evalExpr('window.__LAB__.exportReport().segments.frontCrushPlasticM'),
      worstSync: await evalExpr('Math.max(...window.__LAB__.deformableSyncCheck().map(e=>e.maxErrorM))'),
      chassisZ: await evalExpr('window.__LAB__.exportReport().segments ? (window.__LAB__.chassisSpeedMs(), 0) : 0'),
    };
    await lab(`setRigVisible(false)`);
    await lab(`setOrbitView({ radius: 6.0, height: 1.9, targetHeight: 0.45 })`);
    await lab(`setFixedAngle(${A_FRONT_3Q})`); await render();
    await shot('final-bumper-hang-front-3q.png');
    await lab(`setOrbitView({ radius: 7.0, height: 1.3, targetHeight: 0.4 })`);
    await lab(`setFixedAngle(${A_SIDE})`); await render();
    await shot('final-bumper-hang-front-side.png');
    // tighter front-3q close-up of the hanging bumper
    await lab(`setOrbitView({ radius: 5.0, height: 1.5, targetHeight: 0.3 })`);
    await lab(`setFixedAngle(${A_FRONT_3Q})`); await render();
    await shot('final-bumper-hang-front-close.png');

    // (d) REAR bumper hang after rear-80 (if it triggers there).
    await navigate(LAB_URL, 'window.__LAB__ && window.__LAB__.ready === true');
    await lab(`run('rear-80')`);
    await evalExpr('window.__LAB__.stepN(500); "ok"');
    diag.rear80 = {
      bumpers: await evalExpr('JSON.stringify(window.__FX__.bumpers())'),
      rearCrushPlasticM: await evalExpr('window.__LAB__.exportReport().segments.rearCrushPlasticM'),
      worstSync: await evalExpr('Math.max(...window.__LAB__.deformableSyncCheck().map(e=>e.maxErrorM))'),
    };
    await lab(`setRigVisible(false)`);
    await lab(`setOrbitView({ radius: 6.0, height: 1.9, targetHeight: 0.35 })`);
    await lab(`setFixedAngle(${A_REAR_3Q})`); await render();
    await shot('final-bumper-hang-rear-3q.png');
    await lab(`setOrbitView({ radius: 5.2, height: 1.1, targetHeight: 0.3 })`);
    await lab(`setFixedAngle(${A_REAR})`); await render();
    await shot('final-bumper-hang-rear-close.png');

    console.log('\n[R004 DIAG] ' + JSON.stringify(diag, null, 2));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path.join(OUT_DIR, 'final-diag.json'), JSON.stringify(diag, null, 2));
    console.log('[r004-final] DONE');
  } catch (e) {
    console.error('[r004-final] ERROR', e);
    process.exitCode = 1;
  } finally { try { brave.kill(); } catch {} try { preview.kill(); } catch {} }
}
main();
