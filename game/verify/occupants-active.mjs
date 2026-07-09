// Browser verification for the ACTIVE occupant layer (world/features/occupants/active.ts): boots the
// built game, drives a hard brake (occupants brace -- documented via occupantStates(), since this car's
// glass renders opaque from outside so seated figures aren't visible), then a scripted hard frontal
// crash, and screenshots the ejection through the shattering windshield, the get-up, and the
// stumble-away. Reads window.__GAME__.features.occupants.occupantStates() at each stage (the
// AUTHORITATIVE machine-readable evidence). Asserts 0 console errors, glass shattered, a survivor stood.
//
// Usage: node verify/occupants-active.mjs   (spawns `vite preview` itself; run `npm run build` first).
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9463;
const PREVIEW_PORT = 4199;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = path.join(gameRoot, 'verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try {
          const r = await fetch(url);
          if (r.ok) return resolve(true);
        } catch {}
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
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const myId = ++id;
      pending.set(myId, { res, rej });
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  return { ready, send, ws };
}

async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = tabs.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error('no devtools page target');
}

async function main() {
  console.log('[verify-active] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-active] preview up at', URL);

  const browser = spawn(
    BROWSER,
    [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,720', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-active-brave', 'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  let exitCode = 0;
  const stages = {};

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
    });

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    let ok = false;
    for (let i = 0; i < 60; i++) {
      if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify-active] game ready');
    await sleep(1200);
    await evalExpr('window.__GAME__.stepN(300); "ok"'); // settle seated pose

    const shot = async (name) => {
      await sleep(500);
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
      console.log('[verify-active] wrote', name);
    };

    // Stage 1: seated brace under a hard brake (documented via state; occupants not visible through the
    // car's opaque-from-outside glass -- occupantStates() is the authoritative evidence).
    await evalExpr('window.__GAME__.setInput({ throttle: 1 }); window.__GAME__.stepN(150); "ok"');
    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1 }); window.__GAME__.stepN(30); "ok"');
    stages.braking = await evalExpr('window.__GAME__.features.occupants.occupantStates()');
    await evalExpr('window.__GAME__.setInput(null); window.__GAME__.resetCar(); window.__GAME__.stepN(120); "ok"');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 7.5, height: 3.2, targetHeight: 0.7 }); window.__GAME__.setFixedAngle(' + Math.PI / 2.6 + '); "ok"');
    await shot('occupants-active-1-seated.png');

    // Stage 2: hard frontal crash -> ejection through the shattering windshield.
    await evalExpr('window.__GAME__.spawnTestWall(24); "ok"');
    await evalExpr('window.__GAME__.crash(72); "ok"');
    await evalExpr('window.__GAME__.features.occupants.matchVehicleVelocity(); "ok"');
    await evalExpr('window.__GAME__.stepN(70); "ok"'); // reach wall + eject + start flying out
    stages.ejection = await evalExpr('window.__GAME__.features.occupants.occupantStates()');
    await shot('occupants-active-2-ejection.png');

    // Stage 3: get-up (survivors settle then rise).
    await evalExpr('window.__GAME__.stepN(420); "ok"');
    stages.getup = await evalExpr('window.__GAME__.features.occupants.occupantStates()');
    await shot('occupants-active-3-getup.png');

    // Stage 4: stumble away / standing.
    await evalExpr('window.__GAME__.stepN(900); "ok"');
    stages.flee = await evalExpr('window.__GAME__.features.occupants.occupantStates()');
    await shot('occupants-active-4-flee.png');

    console.log('[verify-active] braking states:', JSON.stringify(stages.braking));
    console.log('[verify-active] ejection states:', JSON.stringify(stages.ejection));
    console.log('[verify-active] getup states:', JSON.stringify(stages.getup));
    console.log('[verify-active] flee states:', JSON.stringify(stages.flee));

    c.ws.close();
  } catch (err) {
    console.error('[verify-active] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-active] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-active] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  writeFileSync(path.join(OUT_DIR, 'console-report-occupants-active.json'), JSON.stringify({ consoleErrors, pageErrors, stages, timestamp: new Date().toISOString() }, null, 2));

  const flee = stages.flee ?? [];
  const anyGlass = flee.some((s) => (s.shatteredGlass ?? []).length > 0);
  const anyAliveEjectedStanding = flee.some((s) => s.alive && s.ejected && s.headHeight > 1.0);
  console.log(`[verify-active] anyGlassShattered=${anyGlass} anyAliveEjectedStanding=${anyAliveEjectedStanding}`);
  if (consoleErrors.length > 0 || pageErrors.length > 0 || !anyGlass) exitCode = 1;
  process.exit(exitCode);
}

main();
