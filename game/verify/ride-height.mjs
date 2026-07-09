// Ride-height browser verification (suspension round 2 -- laden stance). Loads the REAL game (full
// cardetail + occupant sprung load, unlike the bare vehicle sim), settles the car at rest, and:
//   - measures per-wheel suspension deflection (window.__GAME__.suspensionDeflections()) + chassis Y,
//   - screenshots a side view at rest (stance / visible wheel-arch gap -- compare vs the user's
//     "slammed" playtest screenshot) and a tight front-wheel close-up,
//   - then brakes hard from speed and screenshots mid-dive to confirm the arch gap survives a 1g dive.
// game/sim/ride-height.test.mjs is the numeric source of truth; this is the eyes-on companion. Same
// headless-Brave CDP harness as the other verify/*.mjs scripts, on its own preview port.
//
// Usage: node verify/ride-height.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gameRoot = path.resolve(__dirname, '..');

const BROWSER = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const CDP_PORT = 9431;
const PREVIEW_PORT = 4181;
const URL = `http://localhost:${PREVIEW_PORT}/`;
const OUT_DIR = path.join(gameRoot, 'verify');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT_DIR, { recursive: true });

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
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  const send = (method, params = {}) => new Promise((res, rej) => { const myId = ++id; pending.set(myId, { res, rej }); ws.send(JSON.stringify({ id: myId, method, params })); });
  return { ready, send, ws };
}

async function getWsUrl(port) {
  for (let i = 0; i < 60; i++) {
    try { const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = tabs.find((t) => t.type === 'page'); if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl; } catch {}
    await sleep(500);
  }
  throw new Error('no devtools page target');
}

async function main() {
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'], { cwd: gameRoot, stdio: 'pipe' });
  preview.stdout.on('data', (d) => process.stdout.write(`[preview] ${d}`));
  preview.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForHttp(URL);
  console.log('[verify-ride-height] preview up at', URL);

  const browser = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-debugging-address=127.0.0.1',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,720', '--force-device-scale-factor=1',
    '--user-data-dir=/tmp/game-verify-ride-height-brave-profile', 'about:blank',
  ], { stdio: 'ignore' });

  const consoleErrors = [], pageErrors = [];
  let exitCode = 0;
  const measurements = {};

  try {
    const c = cdp(await getWsUrl(CDP_PORT));
    await c.ready;
    await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
    c.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description || JSON.stringify(m.params.exceptionDetails));
    });
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: URL });
    const ev = (expr) => c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }).then((r) => r?.result?.value);

    let ok = false;
    for (let i = 0; i < 60; i++) { if ((await ev('window.__GAME__ && window.__GAME__.ready === true')) === true) { ok = true; break; } await sleep(500); }
    if (!ok) throw new Error('window.__GAME__.ready never became true');
    console.log('[verify-ride-height] game ready');
    await sleep(1500);

    // Capture the live three.js scene (no source edit) by wrapping renderer.render once, so we can
    // measure the RENDERED fender-vs-tire gap directly from mesh world AABBs.
    await ev(`(() => { const r = window.__GAME__.renderer; if (!r.__patched) { const o = r.render.bind(r); r.render = (s, c) => { window.__scene = s; return o(s, c); }; r.__patched = true; } return 'ok'; })()`);

    const shot = async (name) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path.join(OUT_DIR, name), Buffer.from(s.data, 'base64')); console.log('[verify-ride-height] wrote', name); };

    // ---- Rest: let the laden car fully settle on its suspension ----
    await ev("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: true }); 'ok'");
    await ev('window.__GAME__.stepN(240); "ok"');
    const restDefl = await ev('JSON.stringify(window.__GAME__.suspensionDeflections())');
    const restChassisY = await ev('window.__GAME__.telemetry.chassisPos.y');
    const wheelHeights = await ev('JSON.stringify(window.__GAME__.wheelHeights())');
    measurements.restDeflections = JSON.parse(restDefl);
    measurements.restChassisY = restChassisY;
    measurements.wheelHeights = JSON.parse(wheelHeights);
    console.log('[verify-ride-height] REST chassisY=', restChassisY.toFixed(4), 'deflections=', restDefl);
    console.log('[verify-ride-height] wheelHeights=', wheelHeights);

    // Side view (camera on +X, car forward is +Z), tight on the car, for stance / arch-gap eyes-on.
    await ev(`window.__GAME__.setFixedAngle(0); 'ok'`);
    await ev('window.__GAME__.setOrbitView({ radius: 6.5, height: 0.7, targetHeight: 0.45 }); "ok"');
    await ev('window.__GAME__.stepN(2); "ok"');
    await sleep(700);
    await shot('ride-height-rest-side.png');

    // Measure the RENDERED front wheel-arch gap: max world-Y of the WheelFrontL group (tire top) vs the
    // min world-Y of the body fender sheet directly above it (BodyHood / body panels in the wheel's
    // fore/aft+lateral column). Traverses the captured scene; forces a matrix update first.
    const gapProbe = await ev(`(() => {
      const s = window.__scene; if (!s) return { err: 'no scene captured' };
      s.updateMatrixWorld(true);
      const THREE_Box3 = (window.__GAME__.renderer && null); // (three not global; use manual vertex scan)
      const V = { x:0,y:0,z:0 };
      function objByName(root, name){ let f=null; root.traverse(o=>{ if(!f && o.name===name) f=o; }); return f; }
      function worldYRange(obj){
        let ymin=Infinity,ymax=-Infinity, xmin=Infinity,xmax=-Infinity, zmin=Infinity,zmax=-Infinity;
        obj.updateWorldMatrix(true,true);
        obj.traverse(o=>{ const g=o.geometry; if(!g||!g.attributes||!g.attributes.position) return; const p=g.attributes.position; const m=o.matrixWorld.elements;
          for(let i=0;i<p.count;i++){ const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
            const wx=m[0]*x+m[4]*y+m[8]*z+m[12], wy=m[1]*x+m[5]*y+m[9]*z+m[13], wz=m[2]*x+m[6]*y+m[10]*z+m[14];
            if(wy<ymin)ymin=wy; if(wy>ymax)ymax=wy; if(wx<xmin)xmin=wx; if(wx>xmax)xmax=wx; if(wz<zmin)zmin=wz; if(wz>zmax)zmax=wz; }
        });
        return { ymin,ymax,xmin,xmax,zmin,zmax };
      }
      const wheel = objByName(s,'WheelFrontL'); if(!wheel) return { err:'no WheelFrontL' };
      const wr = worldYRange(wheel);
      const wheelCX = (wr.xmin+wr.xmax)/2, wheelCZ=(wr.zmin+wr.zmax)/2;
      const tireTop = wr.ymax;
      // Scan every mesh; collect min world-y of body sheet directly above the tire (exclude the wheels).
      let fenderMinY = Infinity, fenderNode='';
      s.traverse(o=>{ const nm=(o.name||''); if(/Wheel|Rim|Tire|Brake|Hub|Disc|Caliper/i.test(nm)) return; if(!/Body|Fender|Panel|Door|Pillar|Hood/i.test(nm)) return;
        const g=o.geometry; if(!g||!g.attributes||!g.attributes.position) return; o.updateWorldMatrix(true,false); const m=o.matrixWorld.elements; const p=g.attributes.position;
        for(let i=0;i<p.count;i++){ const x=p.getX(i),y=p.getY(i),z=p.getZ(i);
          const wx=m[0]*x+m[4]*y+m[8]*z+m[12], wy=m[1]*x+m[5]*y+m[9]*z+m[13], wz=m[2]*x+m[6]*y+m[10]*z+m[14];
          if(Math.abs(wx-wheelCX)<0.25 && Math.abs(wz-wheelCZ)<0.10 && wy>wheelCX*0+ (wr.ymin+wr.ymax)/2){ if(wy<fenderMinY){ fenderMinY=wy; fenderNode=nm; } } }
      });
      return { tireTop, wheelCY:(wr.ymin+wr.ymax)/2, fenderMinY, fenderNode, gap: fenderMinY-tireTop };
    })()`);
    measurements.renderedGapProbe = gapProbe;
    console.log('[verify-ride-height] RENDERED front arch gap:', JSON.stringify(gapProbe));
    const fd = measurements.restDeflections;
    console.log('[verify-ride-height] formula gap check: chassisY - wheelY_fl + 0.0132 =', (restChassisY - measurements.wheelHeights.fl + 0.0132).toFixed(4));

    // Tight front-wheel close-up (arch gap).
    await ev('window.__GAME__.setOrbitView({ radius: 3.0, height: 0.55, targetHeight: 0.42 }); "ok"');
    await ev('window.__GAME__.stepN(2); "ok"');
    await sleep(700);
    await shot('ride-height-rest-wheel-closeup.png');

    // ---- Brake dive: accelerate then brake hard, screenshot mid-dive (arch gap under 1g load) ----
    await ev('window.__GAME__.setOrbitView({ radius: 6.5, height: 0.7, targetHeight: 0.45 }); "ok"');
    await ev("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    for (let i = 0; i < 60 && (await ev('window.__GAME__.telemetry.speedKmh')) < 70; i++) await ev('window.__GAME__.stepN(20); "ok"');
    const preBrakeSpeed = await ev('window.__GAME__.telemetry.speedKmh');
    console.log('[verify-ride-height] braking from', preBrakeSpeed.toFixed(1), 'km/h');
    await ev("window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); 'ok'");
    let minFrontDefl = 1, maxFrontDefl = 0, bestDiveShot = null;
    for (let i = 0; i < 14; i++) {
      await ev('window.__GAME__.stepN(8); "ok"');
      const d = JSON.parse(await ev('JSON.stringify(window.__GAME__.suspensionDeflections())'));
      const fd = (d.fl + d.fr) / 2;
      const speedNow = await ev('window.__GAME__.telemetry.speedKmh');
      if (fd > maxFrontDefl && speedNow > 5) { maxFrontDefl = fd; bestDiveShot = await c.send('Page.captureScreenshot', { format: 'png' }); }
      minFrontDefl = Math.min(minFrontDefl, fd);
    }
    measurements.maxFrontDeflDuringDive = maxFrontDefl;
    console.log('[verify-ride-height] max front deflection during dive =', maxFrontDefl.toFixed(4));
    if (bestDiveShot) { writeFileSync(path.join(OUT_DIR, 'ride-height-brake-dive-side.png'), Buffer.from(bestDiveShot.data, 'base64')); console.log('[verify-ride-height] wrote ride-height-brake-dive-side.png'); }

    await ev("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    c.ws.close();
  } catch (err) {
    console.error('[verify-ride-height] ERROR', err);
    exitCode = 1;
  } finally {
    browser.kill();
    preview.kill();
  }

  console.log('\n[verify-ride-height] console errors:', consoleErrors.length);
  consoleErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  console.log('[verify-ride-height] page exceptions:', pageErrors.length);
  pageErrors.forEach((e, i) => console.log(`  [${i}] ${e}`));
  writeFileSync(path.join(OUT_DIR, 'console-report-ride-height.json'), JSON.stringify({ consoleErrors, pageErrors, measurements, timestamp: new Date().toISOString() }, null, 2));
  if (consoleErrors.length > 0 || pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
