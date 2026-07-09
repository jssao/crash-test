// DESTRUCTION-FEEL browser verify: the design-judgment deliverable is that destruction reads as
// PHYSICAL (bend/bulge/lean-then-break) rather than "hard bodies getting blasted". This drives the
// real game (headless Brave via CDP, same harness as verify/feature-buildings.mjs) into the free-
// standing brick wall TWICE and captures the contrast a human eye must be able to see instantly:
//
//   (A) LOW-SPEED NUDGE  -> the wall BULGES/SLUMPS in place: welds plastically YIELD (bent, not
//       broken), ~nothing is flung, the wall stays standing.  screenshot-destruction-nudge.png
//   (B) HIGH-SPEED BREACH -> the wall SPRAYS: many welds break, bricks scatter.
//                                              screenshot-destruction-breach.png
//
// Between the two it resetWorld()s (repairs structures + respawns the car at spawn). Numeric proof is
// captured too via the buildings feature hooks (totalYieldedJointCount / yieldedJointCountFor added
// for this work, plus totalBrokenJointCount).
//
// Usage: node verify/destruction-feel.mjs   (spawns its own `vite preview`)
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9498;
const PREVIEW_PORT = 4198;
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

// Proportional heading controller (verbatim from verify/feature-buildings.mjs) + a gentle CREEP
// controller that pushes into the wall at a capped low speed and STOPS the instant the wall visibly
// bulges (welds yielded) -- so the nudge shot catches the plastic bulge, not a full breach.
const SNIPPET = `
window.__driveToward = function (targetX, targetZ, maxSteps, stopDist, throttle, gain) {
  function yawOf(q){const t={x:2*(q.y*1-q.z*0),y:2*(q.z*0-q.x*1),z:2*(q.x*0-q.y*0)};const fwd={x:0+q.w*t.x+(q.y*t.z-q.z*t.y),y:0+q.w*t.y+(q.z*t.x-q.x*t.z),z:1+q.w*t.z+(q.x*t.y-q.y*t.x)};return Math.atan2(fwd.x,fwd.z);}
  function wrap(a){while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a;}
  let i=0;
  for(;i<maxSteps;i++){
    const t=window.__GAME__.telemetry;const p=t.chassisPos;
    const dist=Math.hypot(p.x-targetX,p.z-targetZ);
    if(dist<stopDist)break;
    const desiredYaw=Math.atan2(targetX-p.x,targetZ-p.z);
    const err=wrap(desiredYaw-yawOf(t.chassisQuat));
    const steer=Math.max(-1,Math.min(1,-err*gain));
    window.__GAME__.setInput({throttle,brake:0,steer,handbrake:false});
    window.__GAME__.stepN(1);
  }
  const f=window.__GAME__.telemetry;
  return {steps:i,finalPos:f.chassisPos,speedKmh:f.speedKmh};
};
// Gentle push into the wall, STEERING toward its centre (self-corrects any approach mis-alignment) and
// capped to a low speed (~20-25km/h -- above the brick yield onset, below a spray), stopping the
// instant the wall plastically bulges (bentTarget welds yielded) or a few bricks let go.
window.__creepIntoWall = function (maxSteps, bentTarget, brokenCap, speedCapKmh) {
  const B = window.__GAME__.features.buildings;
  function yawOf(q){const t={x:2*(q.y*1-q.z*0),y:2*(q.z*0-q.x*1),z:2*(q.x*0-q.y*0)};const fwd={x:0+q.w*t.x+(q.y*t.z-q.z*t.y),y:0+q.w*t.y+(q.z*t.x-q.x*t.z),z:1+q.w*t.z+(q.x*t.y-q.y*t.x)};return Math.atan2(fwd.x,fwd.z);}
  function wrap(a){while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a;}
  let last = {bent:0, broken:0, speedKmh:0, steps:0};
  for (let i=0; i<maxSteps; i++) {
    const t = window.__GAME__.telemetry;
    const p = t.chassisPos;
    const speed = t.speedKmh;
    const bent = B.yieldedJointCountFor('brick-wall');
    const broken = B.brokenJointCountFor('brick-wall');
    last = {bent, broken, speedKmh: speed, steps: i};
    if (bent >= bentTarget || broken >= brokenCap) break;
    const desiredYaw = Math.atan2(68 - p.x, 20 - p.z); // aim at BRICK_WALL_CENTER (68,20)
    const err = wrap(desiredYaw - yawOf(t.chassisQuat));
    const steer = Math.max(-1, Math.min(1, -err * 1.2));
    const throttle = speed < speedCapKmh ? 0.24 : 0;
    const brake = speed > speedCapKmh + 3 ? 0.5 : 0;
    window.__GAME__.setInput({ throttle, brake, steer, handbrake: false });
    window.__GAME__.stepN(2);
  }
  return last;
};
'ok';
`;

async function main() {
  console.log('[verify-destruction] starting vite preview...');
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-destruction] preview up at', URL);

  const browser = spawn(
    BROWSER,
    [
      '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      '--window-size=1280,720', '--force-device-scale-factor=1',
      '--user-data-dir=/tmp/game-verify-destruction-brave-profile', 'about:blank',
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
          console.error('[verify-destruction] EVAL EXCEPTION:', desc);
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
    console.log('[verify-destruction] game ready');
    await sleep(1500);
    await evalExpr(SNIPPET);

    // ---------------------------------------------------------------------------------------------
    // (A) LOW-SPEED NUDGE -> bulge
    // ---------------------------------------------------------------------------------------------
    // Approach to a vantage just short of the brick wall (BRICK_WALL_CENTER x=68,z=20; -z face ~z=19.9)
    // -- stop ~4m before it so the creep can push in at a genuinely low speed.
    console.log('[verify-destruction] (A) approaching brick wall for a low-speed nudge...');
    report.approachNudge = await evalExpr('window.__driveToward(68, 13, 500, 2.0, 0.3, 1.6)');
    console.log('[verify-destruction] approach:', JSON.stringify(report.approachNudge));
    // Full stop before the creep so the nudge speed is set by the creep's own cap, not the approach.
    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); window.__GAME__.stepN(45); "ok"');
    report.creep = await evalExpr('window.__creepIntoWall(220, 8, 12, 22)');
    console.log('[verify-destruction] creep result:', JSON.stringify(report.creep));
    // Coast a few frames so the (unbroken) bulge settles into its leaned pose for the shot.
    await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(20); "ok"');
    report.nudgeBentBrick = await evalExpr("window.__GAME__.features.buildings.yieldedJointCountFor('brick-wall')");
    report.nudgeBrokenBrick = await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('brick-wall')");
    report.nudgeTelemetry = await evalExpr('window.__GAME__.telemetry');
    console.log(`[verify-destruction] NUDGE: brick bent(yielded)=${report.nudgeBentBrick} broken=${report.nudgeBrokenBrick}`);

    await evalExpr('window.__GAME__.setOrbitView({ radius: 13, height: 6, targetHeight: 1.2 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(0.35); "ok"'); // frame the wall square-on, slightly to the side
    await sleep(700);
    let shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-destruction-nudge.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-destruction] wrote screenshot-destruction-nudge.png');

    // ---------------------------------------------------------------------------------------------
    // reset (repairs the wall, respawns car at spawn)
    // ---------------------------------------------------------------------------------------------
    await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
    await evalExpr('window.__GAME__.resetWorld(); "ok"');
    report.brokenAfterReset = await evalExpr('window.__GAME__.features.buildings.totalBrokenJointCount()');
    report.bentAfterReset = await evalExpr('window.__GAME__.features.buildings.totalYieldedJointCount()');
    console.log(`[verify-destruction] after reset: broken=${report.brokenAfterReset} bent=${report.bentAfterReset} (both expect 0)`);

    // ---------------------------------------------------------------------------------------------
    // (B) HIGH-SPEED BREACH -> spray
    // ---------------------------------------------------------------------------------------------
    console.log('[verify-destruction] (B) full-throttle breach run at the brick wall...');
    report.approachBreach = await evalExpr('window.__driveToward(68, 20, 420, 1.5, 1.0, 1.6)');
    console.log('[verify-destruction] breach approach:', JSON.stringify(report.approachBreach));
    report.breachBrokenBrick = await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('brick-wall')");
    for (let attempt = 0; attempt < 4 && !(report.breachBrokenBrick > 15); attempt++) {
      console.log(`[verify-destruction] breach retry ${attempt}: broken=${report.breachBrokenBrick} (need >15)...`);
      await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(90); 'ok'");
      await evalExpr('window.__driveToward(68, 20, 150, 0.5, 1.0, 2); "ok"');
      report.breachBrokenBrick = await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('brick-wall')");
    }
    report.breachTelemetry = await evalExpr('window.__GAME__.telemetry');
    console.log(`[verify-destruction] BREACH: brick broken=${report.breachBrokenBrick}`);

    await evalExpr('window.__GAME__.setOrbitView({ radius: 13, height: 6, targetHeight: 1.2 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(0.35); "ok"');
    await sleep(500);
    shot = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(OUT_DIR, 'screenshot-destruction-breach.png'), Buffer.from(shot.data, 'base64'));
    console.log('[verify-destruction] wrote screenshot-destruction-breach.png');

    c.ws.close();

    // ---- ASSERTIONS ----
    if (!(report.nudgeBentBrick > 0)) throw new Error(`NUDGE should plastically bulge the wall (bent>0), got bent=${report.nudgeBentBrick}`);
    if (!(report.nudgeBrokenBrick < report.breachBrokenBrick)) throw new Error(`NUDGE broken (${report.nudgeBrokenBrick}) should be well under BREACH broken (${report.breachBrokenBrick})`);
    if (!(report.breachBrokenBrick > 15)) throw new Error(`BREACH should spray (>15 broken), got ${report.breachBrokenBrick}`);
    if (report.brokenAfterReset !== 0) throw new Error(`reset should repair every weld, got broken=${report.brokenAfterReset}`);
  } catch (err) {
    console.error('[verify-destruction] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-destruction] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-destruction] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));

  writeFileSync(
    path.join(OUT_DIR, 'console-report-destruction.json'),
    JSON.stringify({ consoleErrors, pageErrors, evalExceptions, ...report, timestamp: new Date().toISOString() }, null, 2),
  );

  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
