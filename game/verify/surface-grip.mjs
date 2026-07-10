// SPDX-License-Identifier: MIT
//
// Browser EYES-ON verify for Tier-2 per-zone terrain friction (game/src/world/terrain/heightfield.ts's
// SURFACE_ASPHALT/DIRT/NATURAL materials, wired into the real terrain ground body in terrainBody.ts).
// The headless game/sim/surface-grip.test.mjs already proves the numbers matter on a clean, decoupled
// synthetic ground; this script drives the REAL car over the REAL compound -> dirt spur/loop and shows
// the SAME effect in the browser: a cornering hold/slide comparison (fixed speed + fixed steer on the
// asphalt apron vs on the dirt loop) with telemetry traces, plus a drift screenshot mid-turn on the
// dirt loop. Reuses the shared CDP/preview harness (playtest/lib.mjs), same pattern as verify/terrain.mjs.
//
// Usage: node verify/surface-grip.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const G = 9.81;

async function main() {
  const h = await launchHarness({ previewPort: 4210, cdpPort: 9470, width: 1280, height: 720, headed: false, label: 'surface-grip' });
  const { evalExpr, send } = h;
  const OUT = __dirname;
  const report = { screenshots: {}, cornering: {}, braking: {}, notes: [] };
  let exitCode = 0;

  async function shot(name) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT, `${name}.png`);
    writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log('[surface-grip] wrote', p);
    return p;
  }

  // Drives (real-time input, small step+sleep so the chase camera tracks smoothly) until `cond(t)` or a
  // step cap. Returns the final telemetry. Same idiom as verify/terrain.mjs's driveUntil.
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

  // Runs an in-page, synchronous accelerate-to-speed -> hold fixed steer -> sample loop (fast: no CDP
  // round trip per physics step). Returns { samples, peakLatG } where samples are {t,speedKmh,latG}.
  async function corneringTrace(steerFraction, targetKmh = 55) {
    const result = await evalExpr(`(() => {
      const g = window.__GAME__;
      const G = ${G};
      g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
      let reached = false;
      for (let i = 0; i < 900 && !reached; i++) {
        g.stepN(1);
        if (g.telemetry.speedKmh >= ${targetKmh}) reached = true;
      }
      g.setInput({ throttle: 0.15, brake: 0, steer: ${steerFraction}, handbrake: false });
      const samples = [];
      let peakLatG = 0;
      for (let k = 0; k < 240; k++) {
        g.stepN(1);
        const t = g.telemetry;
        const speedMs = t.speedKmh / 3.6;
        const latG = Math.abs(t.yawRateRadS) * speedMs / G;
        samples.push({ k, speedKmh: t.speedKmh, latG, z: t.chassisPos.z, x: t.chassisPos.x });
        if (k > 60) peakLatG = Math.max(peakLatG, latG);
      }
      g.setInput(null);
      return { reached, samples, peakLatG };
    })()`);
    return result;
  }

  // Runs an in-page accelerate-to-target -> full-brake -> stop loop. Returns stop distance (m, straight-
  // line displacement from brake-start to stop -- NOT a raw Z delta, since on the curved dirt LOOP the
  // car's heading isn't aligned with +Z the way it is on the straight apron/spur, so a Z-only delta can
  // even go negative there), or null if it never stopped within the step budget.
  async function brakingTrace(targetKmh = 55) {
    return evalExpr(`(() => {
      const g = window.__GAME__;
      g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
      let reached = false, startX = 0, startZ = 0;
      for (let i = 0; i < 1800; i++) {
        const t = g.telemetry;
        if (!reached && t.speedKmh >= ${targetKmh}) { reached = true; startX = t.chassisPos.x; startZ = t.chassisPos.z; }
        g.setInput({ throttle: reached ? 0 : 1, brake: reached ? 1 : 0, steer: 0, handbrake: false });
        g.stepN(1);
        const t2 = g.telemetry;
        if (reached && t2.speedKmh < 2) {
          g.setInput(null);
          return Math.hypot(t2.chassisPos.x - startX, t2.chassisPos.z - startZ);
        }
      }
      g.setInput(null);
      return null;
    })()`);
  }

  try {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(700);
    report.screenshots.apron = await shot('surface-grip-apron');

    // ---- CORNERING on the ASPHALT apron (baseline: should hold a tight, controlled line). ----
    const asphaltCorner = await corneringTrace(0.6, 55);
    report.cornering.asphalt = { peakLatG: asphaltCorner.peakLatG, reached55: asphaltCorner.reached, sampleCount: asphaltCorner.samples.length };
    console.log(`[surface-grip] apron cornering: reached55=${asphaltCorner.reached} peakLatG=${asphaltCorner.peakLatG.toFixed(3)}`);
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(500);
    report.screenshots.asphaltCornerEnd = await shot('surface-grip-asphalt-corner');

    // ---- BRAKING on the ASPHALT apron. ----
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await sleep(400);
    const asphaltBrakeDist = await brakingTrace(55);
    report.braking.asphalt = asphaltBrakeDist;
    console.log(`[surface-grip] apron braking distance from 55km/h: ${asphaltBrakeDist}m`);

    // ---- Drive OUT the gate, up the spur, onto the DIRT LOOP. ----
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await sleep(400);
    let t = await driveUntil({ throttle: 0.85, brake: 0, steer: 0, handbrake: false }, (t) => t.chassisPos.z >= 110, 70);
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(700);
    report.dirtPos = t.chassisPos;
    report.screenshots.dirtLoop = await shot('surface-grip-dirt-loop');
    console.log('[surface-grip] on dirt loop at z=', t.chassisPos.z.toFixed(1), 'x=', t.chassisPos.x.toFixed(1));

    // ---- CORNERING on the DIRT LOOP (same fixed steer/target speed -- expect a gentler hold / more
    // slide than the apron, i.e. a measurably lower peak lateral g). Screenshot mid-turn = the drift shot. ----
    const dirtCornerPromise = corneringTrace(0.6, 55);
    // Grab the drift screenshot partway through the turn (the in-page loop above runs to completion
    // before returning, so take this shot from a SEPARATE short drive using real-time stepping instead,
    // right after, to get an honest mid-turn frame).
    const dirtCorner = await dirtCornerPromise;
    report.cornering.dirt = { peakLatG: dirtCorner.peakLatG, reached55: dirtCorner.reached, sampleCount: dirtCorner.samples.length };
    console.log(`[surface-grip] dirt-loop cornering: reached55=${dirtCorner.reached} peakLatG=${dirtCorner.peakLatG.toFixed(3)}`);

    // Re-drive the same turn in REAL TIME (small steps + sleep) so the chase camera can actually track
    // it, and grab a screenshot mid-slide for the EYES-ON drift shot.
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    for (let i = 0; i < 60; i++) {
      await evalExpr('window.__GAME__.stepN(1); "ok"');
      const tt = await evalExpr('window.__GAME__.telemetry');
      if (tt.speedKmh >= 55) break;
    }
    await evalExpr("window.__GAME__.setInput({ throttle: 0.15, brake: 0, steer: 0.6, handbrake: false }); 'ok'");
    for (let i = 0; i < 45; i++) {
      await evalExpr('window.__GAME__.stepN(2); "ok"');
      await sleep(30);
    }
    report.screenshots.dirtDrift = await shot('surface-grip-dirt-drift');
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(400);

    // ---- BRAKING on the DIRT LOOP (same target speed as the apron braking run above). ----
    const dirtBrakeDist = await brakingTrace(55);
    report.braking.dirt = dirtBrakeDist;
    console.log(`[surface-grip] dirt-loop braking distance from 55km/h: ${dirtBrakeDist}m`);

    report.consoleErrors = h.consoleErrors;
    report.consoleWarnings = h.consoleWarnings;
    report.pageErrors = h.pageErrors;
    report.timestamp = new Date().toISOString();
    console.log('[surface-grip] console errors:', h.consoleErrors.length, 'warnings:', h.consoleWarnings.length, 'page errors:', h.pageErrors.length);
    h.consoleErrors.forEach((e, i) => console.log(`  err[${i}] ${e}`));

    // GATE (what the BROWSER can honestly assert end-to-end, real-drive noise tolerated -- the clean,
    // decoupled numeric bands are the headless game/sim/surface-grip.test.mjs's job): the car reaches
    // both surfaces at speed, corners measurably less on dirt than asphalt (directional, not a strict
    // ratio -- an uncontrolled real drive on a curved loop vs a straight apron isn't apples-to-apples
    // the way the synthetic flat-ground headless test is), brakes measurably longer on dirt, and there
    // are no console/page errors.
    const reachedBoth = asphaltCorner.reached && dirtCorner.reached;
    const corneringDirectionOk = dirtCorner.peakLatG < asphaltCorner.peakLatG;
    const brakingOk = typeof asphaltBrakeDist === 'number' && typeof dirtBrakeDist === 'number' && dirtBrakeDist > asphaltBrakeDist;
    const noErrors = h.consoleErrors.length === 0 && h.pageErrors.length === 0;
    const gatePass = reachedBoth && corneringDirectionOk && brakingOk && noErrors;
    report.gate = { reachedBoth, corneringDirectionOk, brakingOk, noErrors, pass: gatePass };
    console.log(`[surface-grip] GATE (reachedBoth=${reachedBoth}, dirt corners less than asphalt=${corneringDirectionOk} [asphalt=${asphaltCorner.peakLatG.toFixed(3)}g dirt=${dirtCorner.peakLatG.toFixed(3)}g], dirt brakes longer=${brakingOk} [asphalt=${asphaltBrakeDist}m dirt=${dirtBrakeDist}m], 0 errors): ${gatePass ? 'PASS' : 'FAIL'}`);
    if (!gatePass) exitCode = 1;
  } catch (err) {
    console.error('[surface-grip] FATAL', err);
    report.error = String((err && err.message) || err);
    exitCode = 1;
  } finally {
    writeFileSync(path.join(OUT, 'console-report-surface-grip.json'), JSON.stringify(report, null, 2));
    await h.close();
  }
  process.exit(exitCode);
}

main();
