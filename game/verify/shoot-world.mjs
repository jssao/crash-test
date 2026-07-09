// World/destructible verification (G4/G5 spec): loads the game, screenshots (a) the hero shot (car
// at spawn with the destructible field visible), scripts a deterministic drive (via
// window.__GAME__.setInput()/stepN(), same as verify/shoot-driving.mjs -- not wall-clock waiting,
// SwiftShader software rendering is slow) into (b) the barrel bowling triangle and (c) the crate
// tower, and (d) a post-crash shot with the HUD's damage widget visibly showing non-green state.
// Screenshots land at verify/screenshot-world-{a,b,c,d}.png. Same headless-Brave CDP harness pattern
// as verify/shoot-crash.mjs.
//
// AIMING: the barrel triangle / crate tower sit off-center (game/src/world/tuning.ts's
// BARREL_TRIANGLE_APEX at x=16 / CRATE_TOWER_CENTER at x=-16 -- see that file's LAYOUT doc comment),
// so a plain straight-ahead scripted drive
// (like shoot-crash.mjs's) won't reach them. A small proportional steering controller
// (driveToward()) runs INSIDE the page (injected once via Runtime.evaluate) -- computes the current
// heading (rotating the chassis quaternion's local +Z by its own math, no three.js needed) vs. the
// bearing to a target waypoint, and steers to close that error every window.__GAME__.stepN() chunk.
// Tuned empirically against the actual world layout (see this file's own console output for the
// final approach position/damage reached).
//
// Usage: node verify/shoot-world.mjs   (spawns `vite preview` itself)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9425;
const PREVIEW_PORT = 4176;
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

// Injected once into the page (see main()) -- a small proportional steering controller toward an
// (x,z) waypoint, driven entirely by window.__GAME__'s existing debug hooks (telemetry/setInput/
// stepN), no three.js/DOM access needed on the page side beyond what __GAME__ already exposes.
const DRIVE_TOWARD_SNIPPET = `
window.__rotateVec = function (q, v) {
  const t = { x: 2 * (q.y * v.z - q.z * v.y), y: 2 * (q.z * v.x - q.x * v.z), z: 2 * (q.x * v.y - q.y * v.x) };
  return { x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y), y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z), z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x) };
};
window.__driveToward = function (targetX, targetZ, maxSteps, chunkSteps) {
  let steps = 0;
  while (steps < maxSteps) {
    const tel = window.__GAME__.telemetry;
    const pos = tel.chassisPos;
    const fwd = window.__rotateVec(tel.chassisQuat, { x: 0, y: 0, z: 1 });
    const desiredAngle = Math.atan2(targetX - pos.x, targetZ - pos.z);
    const currentAngle = Math.atan2(fwd.x, fwd.z);
    let diff = desiredAngle - currentAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    const steer = Math.max(-0.45, Math.min(0.45, diff * 1.3));
    window.__GAME__.setInput({ throttle: 1, brake: 0, steer, handbrake: false });
    window.__GAME__.stepN(chunkSteps);
    steps += chunkSteps;
    const dist = Math.hypot(targetX - pos.x, targetZ - pos.z);
    if (dist < 2.5) break;
  }
  return window.__GAME__.telemetry;
};
'ok';
`;

async function main() {
  console.log('[verify-world] starting vite preview server...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], {
    cwd: gameRoot,
    stdio: 'pipe',
  });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-world] preview server up at', URL);

  console.log('[verify-world] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-world-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  let exitCode = 0;
  let telemetryHero = null;
  let telemetryBarrels = null;
  let telemetryCrate = null;
  let displacedCount = 0;
  let displacements = [];

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
    console.log('[verify-world] game ready');

    const bodyCount = await evalExpr('window.__GAME__.destructibleBodyCount');
    console.log('[verify-world] destructible dynamic body count:', bodyCount);

    // Let a handful of real frames render first (shadow map, PMREM, textures settle).
    await sleep(1500);

    await evalExpr(DRIVE_TOWARD_SNIPPET);

    // ---- (a) hero shot: car at spawn, destructible field visible (wide-ish orbit, camera behind the
    // car looking forward across the whole field). ----
    await evalExpr(`window.__GAME__.setFixedAngle(${-Math.PI / 2}); 'ok'`);
    await sleep(700);
    telemetryHero = await evalExpr('window.__GAME__.telemetry');
    let shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-world-a.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-world] wrote screenshot-world-a.png (hero)');

    // ---- (b) mid-destruction: scripted drive through the barrel bowling triangle (right lane,
    // BARREL_TRIANGLE_APEX at x=16,z=34). ----
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__driveToward(16, 30, 400, 15); "ok"'); // approach the triangle
    await evalExpr('window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0.03, handbrake: false }); "ok"');
    await evalExpr('window.__GAME__.stepN(45); "ok"'); // plow straight into it, screenshot while debris is still flying
    telemetryBarrels = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-world] telemetry mid-barrel-triangle:', JSON.stringify({ pos: telemetryBarrels.chassisPos, speedKmh: telemetryBarrels.speedKmh }));
    await evalExpr(`window.__GAME__.setFixedAngle(${(2 * Math.PI) / 3}); 'ok'`);
    await sleep(500);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-world-b.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-world] wrote screenshot-world-b.png (mid-destruction: barrel triangle)');

    // ---- (c) post-jump/crash into the crate tower (left lane, CRATE_TOWER_CENTER at x=-16,z=34,
    // its own clear approach -- see world/tuning.ts's LAYOUT doc comment) -- fresh world state first
    // (Shift+R equivalent) so this crash is easy to read. ----
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    await sleep(50);
    await evalExpr('window.__driveToward(-16, 32, 420, 15); "ok"'); // drive the whole lane in one pass straight into the tower
    telemetryCrate = await evalExpr('window.__GAME__.telemetry');
    console.log('[verify-world] telemetry post-crate-tower-crash:', JSON.stringify({ pos: telemetryCrate.chassisPos, speedKmh: telemetryCrate.speedKmh, damage: telemetryCrate.damage.panelStates }));

    // GATE FIX (adversarial-verifier gap): assert on ACTUAL destructible-world displacement, not just
    // the car's own damage flags -- a car could show damage without the world itself having moved
    // convincingly. window.__GAME__.destructibleDisplacements() (main.ts) returns each destructible
    // body's distance (meters) from its spawn pose right now.
    displacements = await evalExpr('window.__GAME__.destructibleDisplacements()');
    displacedCount = displacements.filter((d) => d > 0.5).length;
    console.log(`[verify-world] destructible bodies displaced >0.5m after crate-tower crash: ${displacedCount} / ${displacements.length}`);
    await evalExpr(`window.__GAME__.setFixedAngle(${Math.PI / 4}); 'ok'`);
    await sleep(500);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-world-c.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-world] wrote screenshot-world-c.png (post-crash: crate tower)');

    // ---- (d) HUD visible with the damage widget showing post-crash state (chase camera, so the
    // full HUD overlay -- title/speed/gear/rpm/damage widget/perf -- is unambiguously on screen). ----
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__GAME__.stepN(30); "ok"'); // let the chase camera settle behind the car
    await sleep(500);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-world-d.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-world] wrote screenshot-world-d.png (HUD + damage widget)');

    c.ws.close();
  } catch (err) {
    console.error('[verify-world] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-world] console errors captured:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-world] console warnings captured:', consoleWarnings.length);
  consoleWarnings.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-world] uncaught page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  const crateDamageOccurred =
    telemetryCrate && (Object.values(telemetryCrate.damage.panelStates).some((s) => s === 'loosened' || s === 'broken') || telemetryCrate.damage.dentedVertexCount > 0);
  console.log(`[verify-world] crate-tower crash produced damage: ${crateDamageOccurred}`);

  const REQUIRED_DISPLACED_COUNT = 10;
  const worldDisplacementOccurred = displacedCount >= REQUIRED_DISPLACED_COUNT;
  console.log(
    `[verify-world] REQUIRED >=${REQUIRED_DISPLACED_COUNT} destructible bodies displaced >0.5m: ${worldDisplacementOccurred ? 'PASS' : 'FAIL'} (${displacedCount})`,
  );

  writeFileSync(
    path.join(OUT_DIR, 'console-report-world.json'),
    JSON.stringify(
      {
        consoleErrors,
        consoleWarnings,
        pageErrors,
        telemetryHero,
        telemetryBarrels,
        telemetryCrate,
        crateDamageOccurred,
        displacedCount,
        displacements,
        worldDisplacementOccurred,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  // HARD ASSERT (adversarial-verifier gate fix): a car-damage flag alone doesn't prove the destructible
  // WORLD itself moved convincingly -- require actual body displacement too, exit 1 if it doesn't hold.
  if (consoleErrors.length > 0 || pageErrors.length > 0 || !crateDamageOccurred || !worldDisplacementOccurred) exitCode = 1;
  process.exit(exitCode);
}

main();
