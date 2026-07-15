// SPDX-License-Identifier: MIT
//
// BUGS R003/R004 verification harness (crash visual-effects layer: game/src/scene/crashFx.ts).
// Same raw-CDP-over-Node pattern as verify/crash-lab.mjs -- headless Brave, SwiftShader software
// WebGL -- but on its OWN preview+CDP ports (this task's constraint: other agents' verify scripts
// may hold the usual 4173/9422-family ports) and driving BOTH Vite pages the multi-page build
// serves from one `vite preview`: crash-lab.html for a deterministic NHTSA-56 frontal crash
// (glass shards, dust/debris, engine-bay fluid leak, scuff/chip decals), and the main driving
// page (index.html) for a stationary burnout (tire smoke -- crash-lab's protocols are all
// velocity-set impacts, no throttle/wheelspin path, so the smoke check needs the real driving
// loop).
//
// DETERMINISM/TIMING NOTE (see this task's dispatch notes + __LAB__.renderNow()'s own doc
// comment): headless SwiftShader screenshot capture can itself take several real seconds, during
// which the crash-lab's live rAF loop would otherwise keep calling crashFx.update() with real
// frame dt and fade everything out before the pixels are actually read. renderNow() forces a
// synced render AND permanently stops that rAF loop (idempotent) -- called immediately before
// every crash-lab screenshot below so the captured frame is exactly the one the fixed-step
// stepN() batch produced, not whatever it drifted to during the slow capture.
//
// Usage: node verify/crash-fx.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
// Own ports (task constraint: other agents' verify scripts may hold :4173/9422-family).
const CDP_PORT = 9483;
const PREVIEW_PORT = 4183;
const LAB_URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const GAME_URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_R003 = path.join(repoRoot, 'screenshots/R003_missing-crash-effects/sim');
const OUT_R004 = path.join(repoRoot, 'screenshots/R004_no-paint-damage-hanging-parts/sim');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT_R003, { recursive: true });
mkdirSync(OUT_R004, { recursive: true });

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
  console.log('[crash-fx] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(LAB_URL);

  console.log('[crash-fx] launching headless Brave...');
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
      '--user-data-dir=/tmp/game-verify-crash-fx-brave-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  const assertions = [];
  let exitCode = 0;

  const assert = (label, cond, detail) => {
    assertions.push({ label, pass: !!cond, detail });
    console.log(`[crash-fx] ${cond ? 'PASS' : 'FAIL'} — ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
  };

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable');
    await c.send('Runtime.enable');
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
    });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    const evalExpr = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);
    const shot = async (dir, name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(dir, name), Buffer.from(s.data, 'base64'));
      console.log(`[crash-fx] wrote ${path.join(dir, name)}`);
    };

    // =============================================================================================
    // PART 1: crash-lab.html -- NHTSA-56 full frontal. Glass shards + impact dust/debris (mid-crash),
    // then engine-bay fluid leak + scuff/chip decals persisting into the settled post-crash frame.
    // =============================================================================================
    await c.send('Page.navigate', { url: LAB_URL });
    let ok = false;
    for (let i = 0; i < 60; i++) {
      if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) {
        ok = true;
        break;
      }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__LAB__.ready never became true');
    ok = false;
    for (let i = 0; i < 20; i++) {
      if ((await evalExpr('!!(window.__FX__ && window.__FX__.counters)')) === true) {
        ok = true;
        break;
      }
      await sleep(200);
    }
    assert('window.__FX__ present on crash-lab page', ok);
    console.log('[crash-fx] lab ready');

    await evalExpr("window.__LAB__.setCameraPreset('3q'); window.__LAB__.run('nhtsa-frontal-56'); 'ok'");
    // Step in small increments until the car has GENUINELY touched the barrier (dentedVertexCount>0
    // -- the lab's own crumple-registry readout, not just "some impact event fired somewhere" --
    // early ragdoll/seatbelt settling can legitimately brush a glass pane fast enough to shatter it
    // in the first few steps, well before the wall itself is reached, so gating on particle count
    // alone caught that instead of the wall hit). This is the "mid-crash" sample point: real contact
    // has begun (dust/debris + likely more glass shards), but the crash hasn't settled yet.
    let midStep = 0;
    let dented = 0;
    for (let i = 0; i < 30 && dented === 0; i++) {
      await evalExpr('window.__LAB__.stepN(5); "ok"');
      midStep += 5;
      dented = await evalExpr('window.__LAB__.readout.dentedVertexCount');
    }
    assert(`mid-crash: real barrier contact reached within 150 steps (step ${midStep})`, dented > 0, dented);
    let fx = await evalExpr('JSON.stringify(window.__FX__.counters())').then((s) => JSON.parse(s));
    console.log(`[crash-fx] mid-crash (step ${midStep}, dentedVertexCount=${dented}) counters:`, JSON.stringify(fx));
    console.log(
      '[crash-fx] DIAG particle kind counts:',
      await evalExpr(
        "JSON.stringify(window.__FX__.debugParticles().reduce((m,p)=>{m[p.kind]=(m[p.kind]||0)+1;return m;},{}))",
      ),
    );
    console.log('[crash-fx] DIAG dust/debris/shard samples:', await evalExpr("JSON.stringify(window.__FX__.debugParticles().filter(p=>p.kind!=='smoke').slice(0,10))"));
    assert(`mid-crash (step ${midStep}) particles active (glass shards / impact dust+debris)`, fx.activeParticles > 0, fx);
    // The rig's own wall sits directly in front of the crushed nose -- every impact/glass FX lands
    // right at that face, which the standard "3q"/"side" presets can't see past (the barrier is a
    // large opaque box between the camera and the impact zone by construction -- see barriers.ts's
    // own ANGLE SIGN CONVENTION doc comment on why a positive-angle "look at the front" orbit is
    // normally avoided: it looks THROUGH the wall from the far side). Hide the rig (an existing lab
    // diagnostic toggle, setRigVisible) and use a close frontal orbit so the actual FX are in shot.
    await evalExpr("window.__LAB__.setRigVisible(false); window.__LAB__.setOrbitView({ radius: 4.2, height: 1.3, targetHeight: 0.45 }); window.__LAB__.setFixedAngle(0.55); 'ok'");
    await evalExpr('window.__LAB__.renderNow(); "ok"');
    await shot(OUT_R003, 'mid-crash-shards-dust.png');
    await shot(OUT_R004, 'mid-crash-shards-dust.png');

    // Run to settle -- fluid leak + decals should now be present and persist.
    await evalExpr('window.__LAB__.stepN(600); "ok"');
    const runState = await evalExpr('window.__LAB__.runState');
    assert('run settled after 600 more fixed steps', runState === 'settled', runState);
    const readout = await evalExpr('JSON.stringify(window.__LAB__.readout)').then((s) => JSON.parse(s));
    console.log('[crash-fx] post-crash readout:', JSON.stringify(readout.mechCrushFrontM ?? readout));
    fx = await evalExpr('JSON.stringify(window.__FX__.counters())').then((s) => JSON.parse(s));
    console.log('[crash-fx] post-crash (settled) counters:', JSON.stringify(fx));
    assert('post-crash: puddle present (engine-bay fluid leak)', fx.puddles > 0, fx);
    assert('post-crash: at least one scuff/chip decal present', fx.decals > 0, fx);
    assert('post-crash: decal count within its 60-slot cap', fx.decals <= 60, fx);
    assert('post-crash: particle count within its 400-slot cap', fx.activeParticles <= 400, fx);
    await evalExpr('window.__LAB__.renderNow(); "ok"');
    await shot(OUT_R003, 'post-crash-puddle.png');
    await shot(OUT_R004, 'post-crash-decals-puddle.png');

    // A closer frontal shot (rig still hidden) for decal/scuff legibility against the paint.
    await evalExpr("window.__LAB__.setOrbitView({ radius: 2.6, height: 1.1, targetHeight: 0.4 }); window.__LAB__.setFixedAngle(0.5); 'ok'");
    await evalExpr('window.__LAB__.renderNow(); "ok"');
    await shot(OUT_R004, 'post-crash-decals-closeup.png');
    // DIAG: straight-on nose view (rig still hidden) -- isolates the hood/bumper area specifically,
    // to check the scuff decal renders as a small mark there (not conflated with anything else
    // that might be in frame from other angles, e.g. a shattered glass pane's own material swap).
    await evalExpr("window.__LAB__.setOrbitView({ radius: 3.0, height: 1.5, targetHeight: 0.3 }); window.__LAB__.setFixedAngle(0.05); 'ok'");
    await evalExpr('window.__LAB__.renderNow(); "ok"');
    await shot(OUT_R004, 'post-crash-nose-straight-on.png');

    // DIAG: top-down (rig hidden) -- the puddle sits UNDER the chassis, easily hidden by the car's
    // own body/shadow from a low close-up angle; a top view clears the ground around the nose.
    await evalExpr("window.__LAB__.setCameraPreset('top'); window.__LAB__.setOrbitView({ radius: 3.0, height: 5.5, targetHeight: 0.2 }); 'ok'");
    await evalExpr('window.__LAB__.renderNow(); "ok"');
    await shot(OUT_R003, 'post-crash-puddle-top.png');
    await shot(OUT_R004, 'post-crash-puddle-top.png');

    // A wider frontal shot with the rig visible again, for context (crushed nose against the wall).
    await evalExpr("window.__LAB__.setRigVisible(true); window.__LAB__.setOrbitView({ radius: 4.5, height: 1.6, targetHeight: 0.6 }); window.__LAB__.setFixedAngle(-0.6); 'ok'");
    await evalExpr('window.__LAB__.renderNow(); "ok"');
    await shot(OUT_R004, 'post-crash-context-3q.png');

    // =============================================================================================
    // PART 2: main driving page (index.html) -- stationary burnout (throttle + handbrake) to
    // exercise the tire-smoke path via the LIVE (real-time) game loop (crash-lab has no throttle/
    // wheelspin path -- every protocol is velocity-set at run start, see this file's module doc).
    // =============================================================================================
    await c.send('Page.navigate', { url: GAME_URL });
    ok = false;
    for (let i = 0; i < 120; i++) {
      if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) {
        ok = true;
        break;
      }
      if (i % 10 === 0) {
        const diag = await evalExpr(
          'JSON.stringify({ hasGame: !!window.__GAME__, ready: window.__GAME__ && window.__GAME__.ready, readyState: document.readyState, title: document.title })',
        ).catch((e) => `evalExpr failed: ${e}`);
        console.log(`[crash-fx] game boot diag (i=${i}): ${diag}`);
      }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    ok = false;
    for (let i = 0; i < 20; i++) {
      if ((await evalExpr('!!(window.__FX__ && window.__FX__.counters)')) === true) {
        ok = true;
        break;
      }
      await sleep(200);
    }
    assert('window.__FX__ present on main driving page', ok);
    console.log('[crash-fx] game ready');

    // Low, close, wide-ish side-3q view so BOTH rear wheels (this RWD car's driven, smoking wheels
    // -- see vehicle/vehicle.ts's stepVehicle(): rl/rr get drive torque, fl/fr don't) are in frame
    // regardless of the car's exact final heading after a wheelspin launch. Set up ONCE, before any
    // stepping -- the main driving page has no renderNow()-equivalent freeze hook (unlike the lab),
    // so every extra real-time gap between the last stepN() and the screenshot risks the
    // deliberately fast-fading (~0.5-1s) smoke puffs aging out before the pixels are actually read;
    // minimizing intervening awaits (no extra camera move/sleep between the last stepN and the shot)
    // keeps that risk as low as this page's live loop allows.
    await evalExpr("window.__GAME__.setFixedAngle(1.1); window.__GAME__.setOrbitView({ radius: 5.5, height: 1.7, targetHeight: 0.35 }); 'ok'");
    // Hard standing-start launch, full throttle, no handbrake (handbrake overrides the SAME driven
    // rear wheels' spin target to 0 -- see vehicle/vehicle.ts's stepVehicle(), so it would fight the
    // very wheelspin this test wants, not cause it). Deterministic stepN (not real-time sleep) --
    // crashFx.updateWheel() runs every fixed step regardless of the render loop, so this reliably
    // exercises the smoke-spawn path without depending on how many real rAF frames SwiftShader
    // manages to render during a wall-clock sleep.
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }); 'ok'");
    for (let i = 0; i < 6; i++) {
      await evalExpr('window.__GAME__.stepN(10); "ok"');
      const slip = await evalExpr('JSON.stringify(window.__GAME__.telemetry.slipHints)');
      const fxNow = await evalExpr('JSON.stringify(window.__FX__.counters())');
      console.log(`[crash-fx] launch step ${(i + 1) * 10}: slipHints=${slip} fx=${fxNow}`);
    }
    const fxGame = await evalExpr('JSON.stringify(window.__FX__.counters())').then((s) => JSON.parse(s));
    console.log('[crash-fx] burnout counters:', JSON.stringify(fxGame));
    assert('burnout: tire-smoke particles active', fxGame.activeParticles > 0, fxGame);
    await shot(OUT_R003, 'burnout-tire-smoke.png');
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, handbrake: 0, steer: 0 }); 'ok'");

    c.ws.close();
  } catch (err) {
    console.error('[crash-fx] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[crash-fx] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  const failed = assertions.filter((a) => !a.pass);
  writeFileSync(path.join(__dirname, 'console-report-crash-fx.json'), JSON.stringify({ assertions, failed, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2));
  console.log(`[crash-fx] assertions: ${assertions.length - failed.length}/${assertions.length} passed`);

  if (consoleErrors.length > 0 || pageErrors.length > 0 || failed.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
