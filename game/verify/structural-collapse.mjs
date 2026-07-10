// Browser verify for STRUCTURAL COLLAPSE (game/src/world/features/buildings/support.ts). Loads the
// full game in headless Brave (same CDP harness as verify/feature-buildings.mjs), drives the Mustang
// into the SHED's front wall (compound layout: SHED_CENTER x=-30 z=34, front face at z~32.5), and
// captures the roof coming down. Proves the support graph flagged the orphaned front assembly
// (collapsingBodyCountFor('shed') > 0) and that the roof pieces actually dropped (max piece
// displacement + a mid-fall / settled screenshot pair).
//
// Fresh ports (9531/4231) so it doesn't collide with sibling verify runs. Reuses feature-trees.mjs's
// proven proportional heading controller verbatim (steer = -yawError * gain).
//
// Usage: node verify/structural-collapse.mjs   (spawns `vite preview` itself; run `vite build` first)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9531;
const PREVIEW_PORT = 4231;
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
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
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
  function wrap(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; }
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
    if (i % 20 === 0) samples.push({ i, x: +p.x.toFixed(1), z: +p.z.toFixed(1), steer: +steer.toFixed(2), speedKmh: +t.speedKmh.toFixed(1) });
    window.__GAME__.setInput({ throttle, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(1);
  }
  const ft = window.__GAME__.telemetry;
  return { steps: i, finalPos: ft.chassisPos, speedKmh: ft.speedKmh, samples };
};
'ok';
`;

// Mean Y of the shed's roof pieces (read straight off the physics bodies via the buildings feature's
// structures array -- exposed through window.__GAME__.features.buildings.__structures if present, else
// fall back to the pieceDisplacements hook). We inject a tiny reader that reaches the roof piece Ys.
const ROOF_READER_SNIPPET = `
window.__shedRoofStats = function () {
  const b = window.__GAME__.features.buildings;
  const disp = b.pieceDisplacements('shed'); // magnitudes for every non-static shed piece
  const maxDisp = disp.reduce((m, d) => Math.max(m, d), 0);
  const movedOver05 = disp.filter((d) => d > 0.5).length;
  return {
    collapsingShed: b.collapsingBodyCountFor('shed'),
    collapsingTotal: b.totalCollapsingBodyCount(),
    brokenShed: b.brokenJointCountFor('shed'),
    yieldedShed: b.yieldedJointCountFor ? b.yieldedJointCountFor('shed') : -1,
    maxPieceDisp: +maxDisp.toFixed(3),
    piecesMovedOver05: movedOver05,
  };
};
'ok';
`;

async function main() {
  console.log('[verify-collapse] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-collapse] preview up at', URL);

  const browser = spawn(
    BROWSER,
    [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,720', '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-collapse-brave-profile', 'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  const evalExceptions = [];
  let exitCode = 0;
  const report = {};

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
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
      }
    });

    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });

    const evalExpr = (expr) =>
      c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => {
        if (r?.exceptionDetails) {
          const desc = r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails);
          console.error('[verify-collapse] EVAL EXCEPTION:', desc);
          evalExceptions.push(desc);
        }
        return r?.result?.value;
      });

    let ok = false;
    for (let i = 0; i < 60; i++) {
      if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify-collapse] game ready');

    report.bodyCount = await evalExpr('window.__GAME__.features.buildings.totalPieceCount()');
    report.brokenBefore = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    report.collapsingBefore = await evalExpr('window.__GAME__.features.buildings.totalCollapsingBodyCount()');
    console.log(`[verify-collapse] bodyCount=${report.bodyCount} brokenBefore=${report.brokenBefore} collapsingBefore=${report.collapsingBefore}`);

    await sleep(1500);
    await evalExpr(DRIVE_TOWARD_SNIPPET);
    await evalExpr(ROOF_READER_SNIPPET);

    // ---- Phase 1: drive to a vantage just SOUTH-EAST of the shed and frame the intact shed. Shed front
    // face is at z~32.5 (SHED_CENTER z=34 minus half-depth 1.5); approach from lower z. Vantage (-24, 26)
    // sits south-east of the shed on the way in. ----
    console.log('[verify-collapse] phase 1: driving to shed vantage...');
    report.drive1 = await evalExpr('window.__driveToward(-26, 27, 420, 4, 0.55, 1.5)');
    console.log('[verify-collapse] phase1:', JSON.stringify(report.drive1));
    report.roofBeforeRam = await evalExpr('window.__shedRoofStats()');
    console.log('[verify-collapse] roof stats @vantage:', JSON.stringify(report.roofBeforeRam));

    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); window.__GAME__.stepN(15); "ok"');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 12, height: 6, targetHeight: 1.4 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(0.9); "ok"');
    await sleep(700);
    let shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-collapse-shed-intact.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-collapse] wrote screenshot-collapse-shed-intact.png');

    // ---- Phase 2: ram the shed front wall (x=-30, z=32.5). Bounded retry until the shed's studs break
    // and the front assembly is flagged collapsing. ----
    console.log('[verify-collapse] phase 2: ramming the shed front wall...');
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    // back off a touch then charge with full throttle straight into the front wall
    report.drive2 = await evalExpr('window.__driveToward(-30, 33, 300, 1.2, 0.9, 1.7)');
    console.log('[verify-collapse] phase2:', JSON.stringify(report.drive2));
    let stats = await evalExpr('window.__shedRoofStats()');
    for (let attempt = 0; attempt < 5 && !(stats.collapsingShed > 0); attempt++) {
      console.log(`[verify-collapse] retry ${attempt}: shed stats=${JSON.stringify(stats)} -- charging again`);
      await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(70); 'ok'");
      await evalExpr('window.__driveToward(-30, 34, 140, 0.5, 1.0, 2.0)');
      stats = await evalExpr('window.__shedRoofStats()');
    }
    report.roofAtImpact = stats;
    console.log('[verify-collapse] shed stats after ram:', JSON.stringify(stats));

    // Mid-fall screenshot: side-on, low, while the roof is coming down (a few steps after the studs go).
    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); "ok"');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 10, height: 4, targetHeight: 1.6 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(1.4); "ok"');
    await evalExpr('window.__GAME__.stepN(12); "ok"'); // let the roof drop a bit into frame
    await sleep(500);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-collapse-shed-falling.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-collapse] wrote screenshot-collapse-shed-falling.png');

    // Let it settle, then a final "collapsed" shot + stats.
    await evalExpr('window.__GAME__.stepN(150); "ok"');
    report.roofSettled = await evalExpr('window.__shedRoofStats()');
    await evalExpr('window.__GAME__.setOrbitView({ radius: 11, height: 5, targetHeight: 0.8 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(0.9); "ok"');
    await sleep(600);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-collapse-shed-settled.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-collapse] wrote screenshot-collapse-shed-settled.png');
    console.log('[verify-collapse] roof settled stats:', JSON.stringify(report.roofSettled));

    // ---- Reset restores the structure (Shift+R equivalent) -- the collapse feature must rebaseline. ----
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    report.afterReset = {
      broken: await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()'),
      collapsing: await evalExpr('window.__GAME__.features.buildings.totalCollapsingBodyCount()'),
      bodyCount: await evalExpr('window.__GAME__.features.buildings.totalPieceCount()'),
    };
    console.log('[verify-collapse] after resetWorld():', JSON.stringify(report.afterReset));

    c.ws.close();

    // ---- ASSERTIONS ----
    if (report.brokenBefore !== 0) throw new Error(`expected 0 broken joints before crash, got ${report.brokenBefore}`);
    if (report.collapsingBefore !== 0) throw new Error(`expected 0 collapsing bodies before crash, got ${report.collapsingBefore}`);
    if (!(report.roofAtImpact.collapsingShed > 0)) throw new Error(`shed front assembly never flagged collapsing (studs never knocked out); stats=${JSON.stringify(report.roofAtImpact)}`);
    if (!(report.roofSettled.maxPieceDisp > 0.8)) throw new Error(`shed roof/top did not fall (maxPieceDisp=${report.roofSettled.maxPieceDisp})`);
    if (report.afterReset.broken !== 0) throw new Error(`expected 0 broken joints after reset, got ${report.afterReset.broken}`);
    if (report.afterReset.collapsing !== 0) throw new Error(`expected 0 collapsing bodies after reset, got ${report.afterReset.collapsing}`);
    if (report.afterReset.bodyCount !== report.bodyCount) throw new Error(`body count changed after reset: ${report.afterReset.bodyCount} != ${report.bodyCount}`);
  } catch (err) {
    console.error('[verify-collapse] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-collapse] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-collapse] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  writeFileSync(
    path.join(OUT_DIR, 'console-report-structural-collapse.json'),
    JSON.stringify({ consoleErrors, pageErrors, evalExceptions, ...report, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
