// SPDX-License-Identifier: MIT
//
// BUGS R003/R004 ROUND-2 verification harness (crash visual-effects layer: game/src/scene/crashFx.ts
// visibility overhaul + crazed-glass swap). Same raw-CDP-over-Node pattern as verify/crash-fx.mjs and
// verify/crash-lab.mjs -- headless Brave, SwiftShader software WebGL -- on this round's OWN ports
// (4193 preview / 9493 CDP; other agents + the round-1 crash-fx.mjs hold other ports).
//
// Round-2 captures (all round2-* prefixed, keeping the round-1 files intact):
//   (a) mid-crash frontal -- glass shards + dust plume            -> R003 + R004
//   (b) tire smoke with the car in motion (crash skid, low-side)  -> R003
//   (c) post-crash fluid puddle (low grazing + top)               -> R003 + R004
//   (d) scratch/scuff decal close-up on the paint                 -> R004
//   (e) sprung/hanging door post-crash (front-left 3/4 + side)    -> R004
//   (f) shattered-glass close-up -- crazed look, no white tri     -> R004
//   (bonus) driving-page burnout launch (best-effort)             -> R003
//
// The reliable tire-smoke venue is the LAB, not the driving page: the drivetrain's traction-control
// torque taper (vehicle/tuning.ts TRACTION_SLIP_ALLOWANCE/CUTOFF) suppresses sustained wheelspin, and
// the headless rAF loop crawls so a live-loop screenshot desyncs from JS state. During a crash the
// wheels lock/skid as the chassis slams to a stop -> a big tire-smoke plume off the contact patches,
// captured DETERMINISTICALLY via __LAB__.renderNow() (no desync). The driving-page burnout is kept as
// a best-effort bonus and never fails the gate.
//
// Usage: node verify/crash-fx-round2.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(gameRoot, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9493;
const PREVIEW_PORT = 4193;
const LAB_URL = `http://localhost:${PREVIEW_PORT}/crash-lab.html`;
const GAME_URL = `http://localhost:${PREVIEW_PORT}/?quality=medium`;
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
        try { const r = await fetch(url); if (r.ok) return resolve(true); } catch {}
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
  console.log('[fx-r2] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(LAB_URL);

  console.log('[fx-r2] launching headless Brave...');
  const browser = spawn(
    BROWSER,
    [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,800', '--force-device-scale-factor=1', '--user-data-dir=/tmp/game-verify-crash-fx-r2-brave-profile', 'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const consoleErrors = [];
  const pageErrors = [];
  const assertions = [];
  let exitCode = 0;

  const assert = (label, cond, detail) => {
    assertions.push({ label, pass: !!cond, detail });
    console.log(`[fx-r2] ${cond ? 'PASS' : 'FAIL'} — ${label}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`);
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
    const evalJson = (expr) => evalExpr(`JSON.stringify(${expr})`).then((s) => (s == null ? s : JSON.parse(s)));
    const shot = async (dir, name) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(dir, name), Buffer.from(s.data, 'base64'));
      console.log(`[fx-r2] wrote ${path.join(path.basename(dir), name)}`);
    };
    const kinds = () => evalJson("window.__FX__.debugParticles().reduce((m,p)=>{m[p.kind]=(m[p.kind]||0)+1;return m;},{})");
    const orbit = (o, angle) => evalExpr(`window.__LAB__.setOrbitView(${JSON.stringify(o)});${angle !== undefined ? `window.__LAB__.setFixedAngle(${angle});` : ''}window.__LAB__.renderNow();"ok"`);

    // ---- boot crash-lab ----
    await c.send('Page.navigate', { url: LAB_URL });
    let ok = false;
    for (let i = 0; i < 60; i++) {
      if ((await evalExpr('window.__LAB__ && window.__LAB__.ready === true')) === true) { ok = true; break; }
      await sleep(500);
    }
    if (!ok) throw new Error('window.__LAB__.ready never became true');
    for (let i = 0; i < 20; i++) { if ((await evalExpr('!!(window.__FX__ && window.__FX__.puddleInfo)')) === true) break; await sleep(200); }
    assert('window.__FX__ (with puddleInfo) present on crash-lab', (await evalExpr('!!(window.__FX__ && window.__FX__.puddleInfo)')) === true);
    console.log('[fx-r2] lab ready');

    // =============================================================================================
    // PART 1: NHTSA-56 straight full frontal. Straight car => clean framing for the puddle, decals,
    // shards+dust, and a symmetric all-wheel skid for tire smoke.
    // =============================================================================================
    await evalExpr("window.__LAB__.setCameraPreset('3q'); window.__LAB__.run('nhtsa-frontal-56'); 'ok'");
    let midStep = 0, dented = 0;
    for (let i = 0; i < 30 && dented === 0; i++) {
      await evalExpr('window.__LAB__.stepN(5); "ok"');
      midStep += 5;
      dented = await evalExpr('window.__LAB__.readout.dentedVertexCount');
    }
    await evalExpr('window.__LAB__.stepN(6); "ok"'); midStep += 6;
    let fx = await evalJson('window.__FX__.counters()');
    let mk = await kinds();
    console.log(`[fx-r2] P1 mid-crash (step ${midStep}, dented=${dented}) counters:`, JSON.stringify(fx), 'kinds:', JSON.stringify(mk));
    assert(`P1 mid-crash: barrier contact reached (step ${midStep})`, dented > 0, dented);
    assert('P1 mid-crash: particles active', fx.activeParticles > 0, fx);
    assert('P1 mid-crash: glass shards present', (mk.shard || 0) > 0, mk);
    assert('P1 mid-crash: dust plume present', (mk.dust || 0) > 0, mk);
    assert('P1 mid-crash: tire smoke present (wheel skid)', (mk.smoke || 0) > 0, mk);

    // (a) mid-crash shards+dust -- rig hidden, front-corner low orbit onto the struck nose.
    await evalExpr("window.__LAB__.setRigVisible(false); 'ok'");
    await orbit({ radius: 4.8, height: 1.7, targetHeight: 0.75 }, 0.6);
    await shot(OUT_R003, 'round2-mid-crash-shards-dust.png');
    await shot(OUT_R004, 'round2-mid-crash-shards-dust.png');

    // (b) tire smoke -- low SIDE view onto the wheel contact patches (skid smoke). Deterministic frame.
    await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
    await orbit({ radius: 6.5, height: 0.85, targetHeight: 0.25 });
    await shot(OUT_R003, 'round2-tire-smoke-skid.png');

    // Settle -> puddle + decals persist.
    await evalExpr('window.__LAB__.stepN(600); "ok"');
    fx = await evalJson('window.__FX__.counters()');
    const pud = await evalJson('window.__FX__.puddleInfo()');
    console.log('[fx-r2] P1 settled counters:', JSON.stringify(fx), 'puddle:', JSON.stringify(pud));
    assert('P1 post-crash: puddle present', fx.puddles > 0, fx);
    assert('P1 post-crash: puddle radius grown (>0.6m)', pud.radius > 0.6, pud);
    assert('P1 post-crash: scuff/chip decals present', fx.decals > 0, fx);
    assert('P1 post-crash: decals within cap', fx.decals <= 80, fx);
    assert('P1 post-crash: particles within cap', fx.activeParticles <= 700, fx);

    // (c) puddle -- top-down zoomed on the nose ground, then a low grazing frontal (sky sheen reads).
    await evalExpr("window.__LAB__.setCameraPreset('top'); 'ok'");
    await orbit({ radius: 2.4, height: 5.0, targetHeight: 0.1 });
    await shot(OUT_R003, 'round2-post-crash-puddle-top.png');
    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await orbit({ radius: 4.2, height: 0.7, targetHeight: 0.12 }, 1.45);
    await shot(OUT_R003, 'round2-post-crash-puddle-lowfront.png');
    await shot(OUT_R004, 'round2-post-crash-puddle-lowfront.png');

    // (d) scuff decal close-up on the front paint.
    await orbit({ radius: 2.8, height: 1.0, targetHeight: 0.55 }, 1.15);
    await shot(OUT_R004, 'round2-scuff-decal-closeup.png');

    // =============================================================================================
    // PART 2: high-speed 'free' frontal (150 km/h) -> guarantees glass shatter (crazed look) + sprung
    // doors. Sprung-door evidence + shattered-glass close-up + a bonus violent shards+dust shot.
    // =============================================================================================
    await evalExpr("window.__LAB__.reset(); 'ok'");
    await sleep(200);
    await evalExpr("window.__LAB__.setFreeConfig({ speedKmh: 150, offsetM: 0, angleDeg: 0 }); window.__LAB__.setCameraPreset('3q'); window.__LAB__.run('free'); 'ok'");
    let hsStep = 0, hsDented = 0;
    for (let i = 0; i < 30 && hsDented === 0; i++) {
      await evalExpr('window.__LAB__.stepN(4); "ok"'); hsStep += 4;
      hsDented = await evalExpr('window.__LAB__.readout.dentedVertexCount');
    }
    await evalExpr('window.__LAB__.stepN(6); "ok"'); hsStep += 6;
    mk = await kinds();
    console.log(`[fx-r2] P2 highspeed mid-crash (step ${hsStep}) kinds:`, JSON.stringify(mk));
    await evalExpr("window.__LAB__.setRigVisible(false); 'ok'");
    await orbit({ radius: 5.2, height: 1.7, targetHeight: 0.75 }, 0.6);
    await shot(OUT_R003, 'round2-mid-crash-shards-dust-highspeed.png');

    // Settle the high-speed wreck.
    await evalExpr('window.__LAB__.stepN(600); "ok"');
    const panelStates = await evalJson('window.__LAB__.readout.panelStates');
    console.log('[fx-r2] P2 panelStates:', JSON.stringify(panelStates));
    const sprung = panelStates && Object.entries(panelStates).some(([k, v]) => /door/i.test(k) && (v === 'sprung' || v === 'broken' || v === 'loosened'));
    assert('sprung-door: at least one door sprung/loosened/broken', sprung, panelStates);

    // (e) sprung door -- front-left 3/4 (matches the door-sprung reference framing) + a side profile.
    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await orbit({ radius: 7.0, height: 2.1, targetHeight: 0.7 }, -1.05);
    await shot(OUT_R004, 'round2-sprung-door-3q.png');
    await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
    await orbit({ radius: 7.0, height: 1.6, targetHeight: 0.7 });
    await shot(OUT_R004, 'round2-sprung-door-side.png');

    // (f) shattered-glass close-up -- greenhouse (windshield/side glass), crazed look, no white triangle.
    await evalExpr("window.__LAB__.setCameraPreset('side'); 'ok'");
    await orbit({ radius: 3.6, height: 1.5, targetHeight: 1.05 });
    await shot(OUT_R004, 'round2-shattered-glass-closeup.png');
    await evalExpr("window.__LAB__.setCameraPreset('3q'); 'ok'");
    await orbit({ radius: 3.9, height: 1.9, targetHeight: 1.05 }, -0.9);
    await shot(OUT_R004, 'round2-shattered-glass-closeup-3q.png');

    // =============================================================================================
    // PART 3 (BEST-EFFORT bonus): driving-page burnout launch. Never fails the gate (see module doc on
    // why the driving page is an unreliable tire-smoke venue). Held throttle via the live loop; capture
    // the first frame with smoke present.
    // =============================================================================================
    try {
      await c.send('Page.navigate', { url: GAME_URL });
      ok = false;
      for (let i = 0; i < 120; i++) { if ((await evalExpr('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; } await sleep(500); }
      if (ok) {
        await evalExpr("window.__GAME__.setFixedAngle(1.15); window.__GAME__.setOrbitView({ radius: 6.0, height: 1.7, targetHeight: 0.35 }); 'ok'");
        await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }); 'ok'");
        let best = 0;
        for (let i = 0; i < 30; i++) {
          await evalExpr('window.__GAME__.stepN(8); "ok"');
          await sleep(90);
          const g = await evalJson('window.__FX__.counters()');
          const smoke = (await kinds()).smoke || 0;
          if (smoke > best) best = smoke;
          if (i % 5 === 0) console.log(`[fx-r2] burnout step ${(i + 1) * 8}: smoke=${smoke} active=${g.activeParticles}`);
          if (smoke >= 4) { await shot(OUT_R003, 'round2-burnout-tire-smoke.png'); break; }
          if (i === 29) await shot(OUT_R003, 'round2-burnout-tire-smoke.png');
        }
        console.log(`[fx-r2] burnout best smoke count = ${best} (best-effort, not gated)`);
        await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, handbrake: 0, steer: 0 }); 'ok'");
      } else {
        console.log('[fx-r2] driving page never ready -- skipping best-effort burnout');
      }
    } catch (e) {
      console.log('[fx-r2] best-effort burnout errored (non-fatal):', String(e));
    }

    c.ws.close();
  } catch (err) {
    console.error('[fx-r2] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log(`\n[fx-r2] console errors: ${consoleErrors.length}, page exceptions: ${pageErrors.length}`);
  consoleErrors.slice(0, 10).forEach((e, i) => console.log(`  err[${i}] ${e}`));
  pageErrors.slice(0, 10).forEach((e, i) => console.log(`  exc[${i}] ${e}`));

  const failed = assertions.filter((a) => !a.pass);
  writeFileSync(path.join(__dirname, 'console-report-crash-fx-round2.json'), JSON.stringify({ assertions, failed, consoleErrors, pageErrors, timestamp: new Date().toISOString() }, null, 2));
  console.log(`[fx-r2] assertions: ${assertions.length - failed.length}/${assertions.length} passed`);

  if (pageErrors.length > 0 || failed.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
