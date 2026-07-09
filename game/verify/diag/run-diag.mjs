// Diagnostic-only CDP driver for game/verify/diag/diag.html. Boots vite dev server (needed for TS
// on-the-fly transform of diag-main.ts), drives headless Brave, dumps numeric panel/wheel poses at
// spawn / after full reset / after a mild crash, and screenshots front/side/top views at spawn.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '../..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9430;
const DEV_PORT = 5199;
const URL = `http://localhost:${DEV_PORT}/verify/diag/diag.html`;
const OUT_DIR = __dirname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_DIR, { recursive: true });

function waitForHttp(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (async function poll() {
      while (Date.now() - start < timeoutMs) {
        try {
          const r = await fetch(url);
          if (r.ok || r.status === 200) return resolve(true);
        } catch {}
        await sleep(300);
      }
      reject(new Error('dev server never came up'));
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
  console.log('[diag] starting vite dev server...');
  const dev = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  dev.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  dev.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForHttp(`http://localhost:${DEV_PORT}/`);
  console.log('[diag] dev server up');

  console.log('[diag] launching headless Brave...');
  const browser = spawn(
    BROWSER,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1024,768',
      '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-diag-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  let exitCode = 0;
  const results = {};

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
      }
    });

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 768, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
      if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
      return r?.result?.value;
    });

    let ok = false;
    for (let i = 0; i < 60; i++) {
      const r = await evalExpr('window.__DIAG__ && window.__DIAG__.ready === true');
      if (r === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__DIAG__.ready never became true');
    console.log('[diag] scene ready');

    // ---- Settle at spawn (a few physics steps so suspension/panels settle from initial penetration) ----
    await evalExpr('window.__DIAG__.stepN(30); "ok"');
    results.spawn = await evalExpr('window.__DIAG__.dumpPoses("spawn")');
    console.log('[diag] dumped spawn poses');

    for (const view of ['front', 'side', 'top']) {
      await evalExpr(`window.__DIAG__.setCamera('${view}'); window.__DIAG__.render(); 'ok'`);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, `spawn-${view}.png`), Buffer.from(shot.data, 'base64'));
      console.log('[diag] wrote spawn-' + view + '.png');
    }

    // ---- Full reset (mirrors R key / doCarRepair) ----
    await evalExpr('window.__DIAG__.doFullReset(); "ok"');
    await evalExpr('window.__DIAG__.stepN(5); "ok"');
    results.afterReset = await evalExpr('window.__DIAG__.dumpPoses("afterReset")');
    console.log('[diag] dumped afterReset poses');

    // ---- Mild crash: wall 12m ahead, 45 km/h, then step through impact + settle ----
    await evalExpr('window.__DIAG__.spawnTestWall(12); "ok"');
    await evalExpr('window.__DIAG__.crash(45); "ok"');
    await evalExpr('window.__DIAG__.stepN(240); "ok"'); // 4s @ 60Hz
    results.afterCrash = await evalExpr('window.__DIAG__.dumpPoses("afterCrash")');
    results.afterCrashTelemetry = await evalExpr('window.__DIAG__.telemetry()');
    console.log('[diag] dumped afterCrash poses; telemetry:', JSON.stringify(results.afterCrashTelemetry));

    for (const view of ['front', 'side', 'top', 'rear3q']) {
      await evalExpr(`window.__DIAG__.setCamera('${view}'); window.__DIAG__.render(); 'ok'`);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, `crash-${view}.png`), Buffer.from(shot.data, 'base64'));
      console.log('[diag] wrote crash-' + view + '.png');
    }

    // ---- Harder crash (a fresh vehicle instance, since the mild-crash one above may already have
    // reparented panels) to try to trigger loosen/break for the pose-mismatch check. ----
    await evalExpr('window.__DIAG__.doFullReset(); "ok"');
    await evalExpr('window.__DIAG__.spawnTestWall(12); "ok"');
    await evalExpr('window.__DIAG__.crash(90); "ok"');
    await evalExpr('window.__DIAG__.stepN(240); "ok"');
    results.afterHardCrash = await evalExpr('window.__DIAG__.dumpPoses("afterHardCrash")');
    results.afterHardCrashTelemetry = await evalExpr('window.__DIAG__.telemetry()');
    console.log('[diag] dumped afterHardCrash poses; telemetry:', JSON.stringify(results.afterHardCrashTelemetry));

    for (const view of ['front', 'side', 'rear3q']) {
      await evalExpr(`window.__DIAG__.setCamera('${view}'); window.__DIAG__.render(); 'ok'`);
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, `hardcrash-${view}.png`), Buffer.from(shot.data, 'base64'));
      console.log('[diag] wrote hardcrash-' + view + '.png');
    }

    c.ws.close();
  } catch (err) {
    console.error('[diag] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    dev.kill();
  }

  console.log('\n[diag] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[diag] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  writeFileSync(path.join(OUT_DIR, 'diag-report.json'), JSON.stringify({ results, consoleErrors, pageErrors }, null, 2));
  console.log('[diag] wrote diag-report.json');

  process.exit(exitCode);
}

main();
