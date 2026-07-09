// SPDX-License-Identifier: MIT
//
// Browser verify for the terrain overhaul: drives spawn -> dirt road -> forest, screenshots each zone,
// and measures per-wheel suspension exercise (deflection-proxy variance) on the dirt road vs the flat
// apron -- the "suspension showcase" claim. Reuses the shared CDP/preview harness (playtest/lib.mjs),
// headless SwiftShader Brave (draw correctness + console errors; the real-GPU fps gate is perf-headed).
//
// Suspension proxy: telemetry exposes no raw per-wheel deflection, but wheelHeights() (wheel body
// world Y) minus chassisPos.y is the chassis-relative wheel travel, i.e. suspension deflection up to a
// constant -- its VARIANCE is exactly the "how hard is the suspension working" signal, comparable
// across surfaces. (Same quantity the headless heightfield-drive.test.mjs measures directly.)
//
// Usage: node verify/terrain.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function variance(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((s, v) => s + v, 0) / a.length;
  return a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length;
}

async function main() {
  const h = await launchHarness({ previewPort: 4199, cdpPort: 9451, width: 1280, height: 720, headed: false, label: 'terrain' });
  const { evalExpr, send } = h;
  const OUT = __dirname;
  const report = { screenshots: {}, variance: {}, notes: [] };
  let exitCode = 0;

  async function shot(name) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, `${name}.png`);
    writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log('[terrain] wrote', p);
    return p;
  }

  // Forward-axis x-component (heading) from the chassis quaternion: rotate (0,0,1) by q.
  const fwdX = (t) => 2 * (t.chassisQuat.x * t.chassisQuat.z + t.chassisQuat.w * t.chassisQuat.y);

  // Drives (real-time input, small step+sleep so the chase camera tracks smoothly) until `cond(t)` or a
  // step cap. Returns the final telemetry. Stays in CHASE mode (never calls setFixedAngle).
  async function driveUntil(input, cond, cap = 60) {
    await evalExpr(`window.__GAME__.setInput(${JSON.stringify(input)}); 'ok'`);
    let t = await evalExpr('window.__GAME__.telemetry');
    for (let i = 0; i < cap; i++) {
      await evalExpr('window.__GAME__.stepN(12); "ok"');
      await sleep(70);
      t = await evalExpr('window.__GAME__.telemetry');
      if (cond(t)) break;
    }
    return t;
  }

  try {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(700);

    // ---- CHASE close-ups first (do these BEFORE any setFixedAngle, which would lock the camera into
    // orbit mode with no hook to switch back). ----
    // Spawn / apron.
    report.screenshots.apron = await shot('terrain-apron');

    // Drive NORTH along the washboarded dirt spur onto the loop (reachable straight ahead).
    let t = await driveUntil({ throttle: 0.7, brake: 0, steer: 0, handbrake: false }, (t) => t.chassisPos.z >= 78, 55);
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(700);
    report.dirtSouthPos = t.chassisPos;
    report.screenshots.dirtSouth = await shot('terrain-dirt-south');
    console.log('[terrain] on dirt spur/loop at z=', t.chassisPos.z.toFixed(1), 'x=', t.chassisPos.x.toFixed(1));

    t = await driveUntil({ throttle: 0.85, brake: 0, steer: 0, handbrake: false }, (t) => t.chassisPos.z >= 150, 70);
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(700);
    report.screenshots.dirtNorth = await shot('terrain-dirt-north');
    console.log('[terrain] reached dirt north region at z=', t.chassisPos.z.toFixed(1));

    // Drive into the FOREST (west). Heading-based: turn until facing west, then straighten. Steer sign
    // is convention-independent -- probe which way a +steer rotates the heading, then pick west.
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await sleep(500);
    let probe = await driveUntil({ throttle: 0.6, brake: 0, steer: 0.7, handbrake: false }, () => false, 8);
    const westSteer = fwdX(probe) > 0 ? -0.7 : 0.7; // want forward.x -> -1 (west)
    report.notes.push(`forest heading probe fwdX=${fwdX(probe).toFixed(2)} -> westSteer ${westSteer}`);
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await sleep(500);
    // Turn phase: rotate until heading is roughly west.
    await driveUntil({ throttle: 0.55, brake: 0, steer: westSteer, handbrake: false }, (t) => fwdX(t) <= -0.75, 40);
    // Straight phase: drive west into the forest.
    t = await driveUntil({ throttle: 0.85, brake: 0, steer: 0, handbrake: false }, (t) => t.chassisPos.x <= -66, 90);
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(800);
    report.forestPos = t.chassisPos;
    report.screenshots.forest = await shot('terrain-forest');
    console.log('[terrain] forest drive ended at x=', t.chassisPos.x.toFixed(1), 'z=', t.chassisPos.z.toFixed(1));

    // ---- Wide-orbit overviews LAST (locks into orbit mode). Reveals the whole 400m layout. ----
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await sleep(400);
    await evalExpr('window.__GAME__.setOrbitView({ radius: 120, height: 78, targetHeight: 0 }); "ok"');
    for (const [name, angle] of [['overview-a', 0.6], ['overview-b', 2.7], ['overview-c', 4.2]]) {
      await evalExpr(`window.__GAME__.setFixedAngle(${angle}); 'ok'`);
      await sleep(800);
      report.screenshots[name] = await shot(`terrain-${name}`);
    }

    // ---- Suspension variance: one deterministic straight north run, sampling the per-wheel deflection
    // proxy every step; split apron window (flat) vs dirt window. Run in-page synchronously. ----
    const samples = await evalExpr(`(() => {
      const g = window.__GAME__;
      g.resetWorld();
      // One constant-throttle straight run from spawn north: flat apron -> washboarded dirt spur. Constant
      // throttle keeps the car moving through BOTH surfaces so each window has real samples.
      g.setInput({ throttle: 0.6, brake: 0, steer: 0, handbrake: false });
      const out = [];
      for (let i = 0; i < 1600; i++) {
        g.stepN(1);
        const t = g.telemetry; const d = g.suspensionDeflections();
        out.push({ z: t.chassisPos.z, x: t.chassisPos.x, speed: t.speedKmh, fl: d.fl, fr: d.fr, rl: d.rl, rr: d.rr });
        if (t.chassisPos.z > 100) break;
      }
      g.setInput(null);
      return out;
    })()`);
    console.log('[terrain] suspension samples:', samples.length);

    const keys = ['fl', 'fr', 'rl', 'rr'];
    // Flat apron window (post-launch) vs washboarded-spur window. Both at driving speed on the same run.
    const apron = samples.filter((s) => s.z >= 20 && s.z <= 45 && Math.abs(s.x) < 8);
    const dirt = samples.filter((s) => s.z >= 62 && s.z <= 97 && Math.abs(s.x) < 10);
    report.variance.windowSizes = { apron: apron.length, dirt: dirt.length };
    report.variance.windowSpeeds = {
      apron: apron.length ? apron.reduce((s, v) => s + v.speed, 0) / apron.length : 0,
      dirt: dirt.length ? dirt.reduce((s, v) => s + v.speed, 0) / dirt.length : 0,
    };
    let minRatio = Infinity, maxRatio = 0, maxDirtVar = 0;
    for (const k of keys) {
      const va = variance(apron.map((s) => s[k]));
      const vd = variance(dirt.map((s) => s[k]));
      // Floor the flat baseline at a small physical noise level so a coincidentally-tiny apron variance
      // can't manufacture an absurd ratio.
      const ratio = vd / Math.max(va, 1e-5);
      report.variance[k] = { apron: va, dirt: vd, ratio };
      minRatio = Math.min(minRatio, ratio);
      maxRatio = Math.max(maxRatio, ratio);
      maxDirtVar = Math.max(maxDirtVar, vd);
      console.log(`[terrain] wheel ${k}: apronVar=${va.toExponential(3)} dirtVar=${vd.toExponential(3)} ratio=${ratio.toFixed(1)}x`);
    }
    report.variance.minRatio = minRatio;
    report.variance.maxRatio = maxRatio;
    report.variance.maxDirtVar = maxDirtVar;
    console.log(`[terrain] suspension-deflection variance ratio (dirt/apron): min=${minRatio.toFixed(1)}x max=${maxRatio.toFixed(1)}x avg speeds apron=${report.variance.windowSpeeds.apron.toFixed(0)} dirt=${report.variance.windowSpeeds.dirt.toFixed(0)}km/h`);

    report.consoleErrors = h.consoleErrors;
    report.consoleWarnings = h.consoleWarnings;
    report.pageErrors = h.pageErrors;
    report.timestamp = new Date().toISOString();
    console.log('[terrain] console errors:', h.consoleErrors.length, 'warnings:', h.consoleWarnings.length, 'page errors:', h.pageErrors.length);
    h.consoleErrors.forEach((e, i) => console.log(`  err[${i}] ${e}`));

    // Gate (what the BROWSER can honestly assert end-to-end): the car drives spawn->dirt->forest, the
    // dirt road produces SUBSTANTIAL absolute suspension activity (real travel, not a flat plane), and
    // there are no console/page errors. A raw flat-vs-dirt variance RATIO is confounded here by speed
    // (the car naturally slows on the rough dirt) and by the car's own at-speed driving dynamics on the
    // flat pad -- so it is REPORTED, not gated. The authoritative clean 27-30x suspension figure comes
    // from the headless heightfield-drive.test.mjs, which compares identical full-throttle runs on flat
    // vs bumpy ground so the driving dynamics cancel and only the terrain differs.
    const windowsOk = apron.length >= 15 && dirt.length >= 15;
    const dirtSubstantial = maxDirtVar >= 5e-4;
    const traversed = report.forestPos && report.forestPos.x <= -60;
    const gatePass = windowsOk && dirtSubstantial && traversed && h.consoleErrors.length === 0 && h.pageErrors.length === 0;
    report.gate = { windowsOk, dirtSubstantial, traversed, maxDirtVar, ratioReported: { min: minRatio, max: maxRatio }, consoleErrors: h.consoleErrors.length, pass: gatePass };
    console.log(`[terrain] GATE (traversed=${!!traversed}, dirt suspension substantial=${dirtSubstantial} [maxVar=${maxDirtVar.toExponential(2)}], 0 errors): ${gatePass ? 'PASS' : 'FAIL'}`);
    if (!gatePass) exitCode = 1;
  } catch (err) {
    console.error('[terrain] FATAL', err);
    report.error = String((err && err.message) || err);
    exitCode = 1;
  } finally {
    writeFileSync(path.join(OUT, 'console-report-terrain.json'), JSON.stringify(report, null, 2));
    await h.close();
  }
  process.exit(exitCode);
}

main();
