// EYES-ON verify for the loosened/broken panel REST-POSE investigation (panels.ts/welds.ts).
// Boots the same verify/diag/diag.html harness shoot-alignment.mjs uses, drives two calibrated
// crashes (~45 km/h -- loosens hood/door(s) without breaking everything; ~90 km/h -- breaks several
// panels), screenshots front+side each time, and prints each panel's pose delta against its
// COMPUTED "attached" target pose (chassisPos + chassisRot*localCenter, chassisRot*nodeWorldQuat) --
// NOT the mesh-vs-body check shoot-alignment.mjs already does. Uses its own dev/CDP ports so it can
// run alongside shoot-alignment.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_NODES, poseDeltaVsAttached } from './attached-pose.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '../..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9452;
const DEV_PORT = 5219;
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

function printPoseDeltas(label, poses) {
  console.log(`[panel-pose] --- ${label} ---`);
  for (const key of Object.keys(PANEL_NODES)) {
    const p = poses.panels[key];
    if (p.despawnedOrMissing) {
      console.log(`  ${key}: despawned`);
      continue;
    }
    const { posM, angleDeg } = poseDeltaVsAttached(key, p.bodyPos, p.bodyQuat, poses.chassis.pos, poses.chassis.quat);
    console.log(`  ${key} [${p.state}]: posDeltaVsAttached=${posM.toFixed(3)}m angleDeltaVsAttached=${angleDeg.toFixed(1)}deg`);
  }
}

async function main() {
  console.log('[panel-pose] starting vite dev server...');
  const dev = spawn('npx', ['vite', '--port', String(DEV_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  dev.stdout.on('data', (d) => process.stdout.write(`[vite] ${d}`));
  dev.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForHttp(`http://localhost:${DEV_PORT}/`);
  console.log('[panel-pose] dev server up');

  console.log('[panel-pose] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-panel-pose-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  let exitCode = 0;

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

    const evalExpr = (expr) =>
      c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
        if (r?.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r?.result?.value;
      });

    // Each scenario gets a FRESH page load (not doFullReset() + a second spawnTestWall() on the SAME
    // page) -- spawnTestWall() never destroys a previous wall (scenario.ts's own doc comment: that's
    // the caller's job), so reusing one page across scenarios silently left the old wall body sitting
    // at the exact same spot a new one was spawned, doubling up the collision geometry and producing
    // wildly worse (non-representative) damage on the 2nd/3rd scenario. A fresh navigation avoids that
    // entirely and also means each scenario is a clean, independent repro.
    async function runScenario(speedKmh, label, fileTag) {
      await c.send('Page.navigate', { url: URL });
      let ready = false;
      for (let i = 0; i < 60; i++) {
        const r = await evalExpr('window.__DIAG__ && window.__DIAG__.ready === true').catch(() => false);
        if (r === true) {
          ready = true;
          break;
        }
        await sleep(300);
      }
      if (!ready) throw new Error(`window.__DIAG__.ready never became true (scenario ${label})`);

      await evalExpr('window.__DIAG__.stepN(30); "ok"');
      await evalExpr('window.__DIAG__.spawnTestWall(10); "ok"');
      await evalExpr(`window.__DIAG__.crash(${speedKmh}); "ok"`);
      await evalExpr('window.__DIAG__.stepN(240); "ok"'); // 4s -- reach wall + settle
      const poses = await evalExpr(`window.__DIAG__.dumpPoses(${JSON.stringify(label)})`);
      printPoseDeltas(label, poses);
      for (const view of ['front', 'side']) {
        await evalExpr(`window.__DIAG__.setCamera('${view}'); window.__DIAG__.render(); 'ok'`);
        const shot = await c.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(path.join(OUT_DIR, `${fileTag}-${view}.png`), Buffer.from(shot.data, 'base64'));
        console.log(`[panel-pose] wrote ${fileTag}-${view}.png`);
      }
      return poses;
    }

    const veryMild = await runScenario(35, '35 km/h (loosen only)', 'loosen-35kmh');
    const mild = await runScenario(45, '45 km/h (loosen)', 'loosen-45kmh');
    const hard = await runScenario(90, '90 km/h (break)', 'break-90kmh');

    writeFileSync(
      path.join(OUT_DIR, 'console-report-panel-pose.json'),
      JSON.stringify({ veryMild, mild, hard, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2),
    );

    c.ws.close();
  } catch (err) {
    console.error('[panel-pose] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    dev.kill();
  }

  console.log('\n[panel-pose] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[panel-pose] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  console.log(`[panel-pose] ${exitCode === 0 ? 'DONE' : 'DONE (with console/page errors)'}`);
  process.exit(exitCode);
}

main();
