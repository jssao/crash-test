// SPDX-License-Identifier: MIT
//
// P001 visual verification ("dummies limp/unposed at crash-lab load"): loads crash-lab.html, lets the
// parked (zero-velocity, no crash run triggered) rig settle for 5s @ 60Hz -- exactly "crash-lab at rest
// after load" -- and screenshots side/top/3q (same CDP headless-Brave pattern as verify/crash-lab.mjs
// and verify/feature-occupants.mjs: spawn `vite preview`, poll window.__LAB__.ready, drive via
// window.__LAB__.stepN, Page.captureScreenshot). Also reads window.__LAB__.readout.occupants as a
// supplementary numeric cross-check (all 4 alive/seated/not-ejected) -- the AUTHORITATIVE joint-angle/
// pose check is game/sim/occupants-load-pose.test.mjs (headless, asserts knee angle / torso height /
// floor clearance directly against physics.ts); this script's job is the human eyes-on look, per this
// bug's verification requirement.
//
// KNOWN CAVEAT (documented independently, occupants/tuning.ts's torso/head TUNING NOTE + verify/
// feature-occupants.mjs's own doc comment): this car's windshield/side glass renders as an opaque tint
// from OUTSIDE in this build, so exterior side/3q shots may not visually reveal the seated figures
// regardless of pose correctness -- not a regression this task introduced, and not something this
// occupants-only fix can address (a rendering/materials concern, outside this feature's ownership).
// Screenshots are still captured and inspected honestly per the task's requirement.
//
// Usage: node verify/occupants-load-pose.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9575;
const PREVIEW_PORT = 4275;
const URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const OUT_DIR = path.join(gameRoot, '..', 'screenshots', 'P001_dummies-limp', 'sim');
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
  console.log('[occupants-load-pose] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[occupants-load-pose] preview server up at', URL);

  console.log('[occupants-load-pose] launching headless Brave...');
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
      '--window-size=1280,800',
      '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-occupants-load-pose-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  let exitCode = 0;
  let readoutBefore = null;

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
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    let ok = false;
    for (let i = 0; i < 60; i++) {
      if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__LAB__.ready never became true');
    console.log('[occupants-load-pose] lab ready');
    await sleep(1000);

    // Explicit reset (matches pressing 'R' / the lab's own load-time resetLab() call) -- spawns the car
    // + 4 seated occupants PARKED (zero velocity, no protocol run triggered), i.e. exactly "crash-lab at
    // load" with nothing crashing into anything.
    await evalExpr('window.__LAB__.reset(); "ok"');
    await evalExpr('window.__LAB__.stepN(300); "ok"'); // 5s @ 60Hz -- full settle, no input, matches the sim test

    readoutBefore = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
    console.log('[occupants-load-pose] readout.occupants=', JSON.stringify(readoutBefore.occupants));

    const shot = async (name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64'));
      console.log(`[occupants-load-pose] wrote ${name}`);
    };

    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await sleep(600);
    await shot('rest-3q.png');

    await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
    await sleep(600);
    await shot('rest-side.png');

    await evalExpr("window.__LAB__.setCameraPreset('top'); 'ok'");
    await sleep(600);
    await shot('rest-top.png');

    // Best-effort close/interior attempt (same caveat as verify/feature-occupants.mjs's cabin-closeup
    // shot -- may just show tinted glass regardless of pose correctness).
    await evalExpr('window.__LAB__.setOrbitView({ radius: 3.2, height: 2.6, targetHeight: 0.85 }); "ok"');
    await evalExpr(`window.__LAB__.setFixedAngle(${Math.PI / 2.3}); 'ok'`);
    await sleep(600);
    await shot('rest-cabin-closeup.png');

    c.ws.close();
  } catch (err) {
    console.error('[occupants-load-pose] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[occupants-load-pose] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  const occupants = readoutBefore?.occupants ?? [];
  const allSeatedAliveNotEjected = occupants.length === 4 && occupants.every((o) => o.alive === true && o.ejected === false && o.state === 'seated');
  console.log(`[occupants-load-pose] allSeatedAliveNotEjected=${allSeatedAliveNotEjected}`);

  writeFileSync(
    path.join(OUT_DIR, 'console-report-occupants-load-pose.json'),
    JSON.stringify({ consoleErrors, pageErrors, readoutOccupants: occupants, allSeatedAliveNotEjected, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0 || !allSeatedAliveNotEjected) exitCode = 1;
  process.exit(exitCode);
}

main();
