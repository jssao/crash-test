// Feature verification: 'trees' world feature -- drives the car (deterministically, via
// window.__GAME__.setInput()+stepN(), same technique as verify/shoot-driving.mjs) from spawn into
// the west-zone tree slalom and on into a mid tree, using a simple proportional heading controller
// (steer toward a target x/z, same yaw-error technique verified offline against the headless sim
// harness while calibrating game/sim/features-trees.test.mjs -- the exact same deterministic
// physics/code path, so the browser run reproduces it) rather than a fixed scripted input sequence,
// since open-loop steer/throttle constants turned out too sensitive to reliably land on a specific
// tree (documented in this feature's build notes). Screenshots the tree line mid-drive and the felled
// mid tree after impact; asserts 0 console errors + at least one tree actually broke.
//
// Usage: node verify/feature-trees.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9440;
const PREVIEW_PORT = 4180;
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

// Injected into the page once: a self-contained heading-proportional-controller drive loop, entirely
// in-page (no per-step CDP round trip) -- computes yaw from chassisQuat the same way
// verify/shoot-driving.mjs's __yawOf() does, steers toward (targetX,targetZ), stops early once within
// `stopDist` meters or after `maxSteps`. Returns the final chassisPos + step count actually taken.
const DRIVE_TOWARD_SNIPPET = `
window.__driveToward = function (targetX, targetZ, maxSteps, stopDist, throttle, gain) {
  function yawOf(q) {
    const t = { x: 2 * (q.y * 1 - q.z * 0), y: 2 * (q.z * 0 - q.x * 1), z: 2 * (q.x * 0 - q.y * 0) };
    const fwd = {
      x: 0 + q.w * t.x + (q.y * t.z - q.z * t.y),
      y: 0 + q.w * t.y + (q.z * t.x - q.x * t.z),
      z: 1 + q.w * t.z + (q.x * t.y - q.y * t.x),
    };
    return Math.atan2(fwd.x, fwd.z);
  }
  function wrap(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
  }
  let i = 0;
  const samples = [];
  for (; i < maxSteps; i++) {
    const t = window.__GAME__.telemetry;
    const p = t.chassisPos;
    const dist = Math.hypot(p.x - targetX, p.z - targetZ);
    if (dist < stopDist) break;
    const desiredYaw = Math.atan2(targetX - p.x, targetZ - p.z);
    const currentYaw = yawOf(t.chassisQuat);
    const err = wrap(desiredYaw - currentYaw);
    const steer = Math.max(-1, Math.min(1, -err * gain));
    if (i % 20 === 0) samples.push({ i, x: p.x, z: p.z, steer, speedKmh: t.speedKmh, yaw: currentYaw });
    window.__GAME__.setInput({ throttle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  const finalTelemetry = window.__GAME__.telemetry;
  return { steps: i, finalPos: finalTelemetry.chassisPos, speedKmh: finalTelemetry.speedKmh, samples };
};
'ok';
`;

async function main() {
  console.log('[verify-trees] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-trees] preview server up at', URL);

  console.log('[verify-trees] launching headless Brave...');
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
      '--window-size=1280,720',
      '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-trees-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let exitCode = 0;
  let driveResult1 = null;
  let driveResult2 = null;
  let treesSnapshotAfterSlalom = null;
  let treesSnapshotAfterMid = null;

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    await c.send('Log.enable');

    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
        if (m.params.type === 'error') consoleErrors.push(text);
        else consoleWarnings.push(text);
      }
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
      }
    });

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    let ok = false;
    for (let i = 0; i < 60; i++) {
      const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true');
      if (r === true) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify-trees] game ready');

    // Let a handful of real frames render first (shadow map, PMREM, textures settle).
    await sleep(1500);

    await evalExpr(DRIVE_TOWARD_SNIPPET);

    // Phase 1: steer toward the sapling slalom's first tree (world/features/trees/tuning.ts's
    // SAPLING_SITES[0] = (-42,6)) -- calibrated offline against the headless sim harness (same
    // deterministic physics) to reliably reach the west-zone tree line within ~230 steps.
    console.log('[verify-trees] phase 1: driving toward the sapling slalom...');
    driveResult1 = await evalExpr('window.__driveToward(-42, 6, 260, 4, 0.5, 1.5)');
    console.log('[verify-trees] phase 1 result:', JSON.stringify(driveResult1));

    treesSnapshotAfterSlalom = await evalExpr('window.__GAME__.features.trees.snapshot()');
    console.log('[verify-trees] trees snapshot after slalom:', JSON.stringify(treesSnapshotAfterSlalom));

    // Render a few real frames, then orbit-screenshot the tree line.
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(20); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI / 6); "ok"');
    await sleep(700);
    const shot1 = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'feature-trees-line.png'), Buffer.from(shot1.data, 'base64'));
    console.log('[verify-trees] wrote feature-trees-line.png');

    // Phase 2: continue steering toward the mid tree (MID_SITES[0] = (-55,20)) -- calibrated offline
    // to reliably fell it (weld breaks) by ~step 340 from spawn; phase 1 already covered ~260 of
    // those steps on a compatible heading, so a further ~200 steps of continued proportional steering
    // is plenty of margin. The real browser also runs its own live rAF render loop concurrently with
    // these scripted steps, which can tick a handful of EXTRA ambient physics steps (using whatever
    // input was last set) during the CDP round-trips/sleeps around the screenshot above -- harmless
    // jitter most of the time, but enough to occasionally leave the controller's final approach a
    // little short of an actual collision. Guard against that empirically-observed flakiness with a
    // bounded retry: re-approach + a guaranteed straight full-throttle "ram" burst, up to 3 times,
    // stopping as soon as the mid tree's weld has actually broken.
    console.log('[verify-trees] phase 2: driving on into the mid tree...');
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"'); // back to chase cam while driving
    driveResult2 = await evalExpr('window.__driveToward(-55, 20, 220, 2, 0.5, 1.5)');
    console.log('[verify-trees] phase 2 result:', JSON.stringify(driveResult2));

    treesSnapshotAfterMid = await evalExpr('window.__GAME__.features.trees.snapshot()');
    for (let attempt = 0; attempt < 3 && !treesSnapshotAfterMid.mids.some((m) => m.broken); attempt++) {
      console.log(`[verify-trees] phase 2 retry ${attempt}: mid tree not yet broken, ramming again...`);
      await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
      await evalExpr('window.__GAME__.stepN(60); "ok"');
      const retryResult = await evalExpr('window.__driveToward(-55, 20, 120, 1, 0.6, 2)');
      console.log(`[verify-trees] phase 2 retry ${attempt} result:`, JSON.stringify(retryResult));
      treesSnapshotAfterMid = await evalExpr('window.__GAME__.features.trees.snapshot()');
    }
    console.log('[verify-trees] trees snapshot after mid-tree approach:', JSON.stringify(treesSnapshotAfterMid));

    // Let the felled trunk settle a little, then orbit-screenshot it.
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    await evalExpr('window.__GAME__.stepN(60); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(Math.PI / 3); "ok"');
    await sleep(700);
    const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'feature-trees-felled.png'), Buffer.from(shot2.data, 'base64'));
    console.log('[verify-trees] wrote feature-trees-felled.png');

    c.ws.close();
  } catch (err) {
    console.error('[verify-trees] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-trees] console errors captured:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-trees] console warnings captured:', consoleWarnings.length);
  consoleWarnings.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-trees] uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  const anySaplingBroken = (treesSnapshotAfterSlalom?.saplings ?? []).some((s) => s.broken) || (treesSnapshotAfterMid?.saplings ?? []).some((s) => s.broken);
  const anyMidBroken = (treesSnapshotAfterMid?.mids ?? []).some((m) => m.broken);
  console.log(`[verify-trees] anySaplingBroken=${anySaplingBroken} anyMidBroken=${anyMidBroken}`);

  writeFileSync(
    path.join(OUT_DIR, 'console-report-trees.json'),
    JSON.stringify(
      {
        consoleErrors,
        consoleWarnings,
        pageErrors,
        driveResult1,
        driveResult2,
        treesSnapshotAfterSlalom,
        treesSnapshotAfterMid,
        anySaplingBroken,
        anyMidBroken,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0 || !anyMidBroken) exitCode = 1;
  process.exit(exitCode);
}

main();
