// SPDX-License-Identifier: MIT
//
// Verify for the car-paint/glass material polish (scene/carMaterials.ts): three screenshots judged
// against the new outdoor je_gray_02 terrain world --
//   1. car-paint-side-glass.png       -- close orbit side view at gameplay distance, intact glass,
//      checked against the seated occupants' shirt colors (tuning.ts's SHIRT_COLOR_SEED) so "are they
//      visible through the glass" is a real yes/no, not a guess.
//   2. car-paint-beauty-dirtroad.png  -- same drive-to-the-dirt-spur framing verify/terrain.mjs uses
//      for terrain-dirt-south.png (the project's quality bar), chase cam, so the paint reads in the
//      actual driving view.
//   3. car-paint-crash-shatter.png    -- spawnTestWall()+crash()+stepN() (same deterministic technique
//      shoot-crash.mjs/feature-cardetail.mjs use), confirming the shattered-glass material swap
//      (main.ts's applyGlassShatterMaterial, NOT owned/modified by this file) still reads as frosted/
//      cracked, not a regression back to the old look.
//
// Also records renderer.info.render.{calls,triangles} at the beauty shot for a perf-delta callout,
// and drives at an explicit forced quality (?quality=) rather than the auto-benchmark default, since
// this project's own headless-SwiftShader Brave benchmark can pick a different tier run to run --
// forcing the tier is what makes the draw-call number actually comparable across runs/commits.
//
// EACH SHOT GETS ITS OWN FRESH PAGE LOAD, deliberately. Two pre-existing quirks turned up while
// investigating this polish pass, neither introduced by carMaterials.ts/car.ts (verified against git
// HEAD's stock, unmodified material too) and neither owned by this task's files:
//   (a) window.__GAME__.resetWorld() -- even as a pure no-op on a car that never moved -- measurably
//       changes how the body renders at a fixed orbit angle afterward (bisected exactly this: same
//       camera/frame/position, only variable is whether resetWorld() was ever called). Root cause is
//       somewhere in main.ts's doCarRepair/buildScene.ts's sun-follow, not this task's files.
//   (b) window.__GAME__.setFixedAngle(null) does NOT return the camera to chase mode (main.ts's
//       handler only flips cameraMode to 'orbit' when radians!==null; passing null back leaves
//       cameraMode stuck on 'orbit', now auto-spinning on real elapsed time) -- there is no exposed
//       hook to force chase mode back on from a script.
// A fresh navigation per shot sidesteps both for free: no reset ever needed, and the camera mode used
// by each shot is whatever that page load's shot needs, never switched mid-session. Flagged in this
// task's final report for the respective files' owners to look at separately.
//
// Usage: node verify/car-paint.mjs   (spawns `vite preview` itself)
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname); // game/verify (not verify/playtest) -- this feature's own dir
const QUALITY = process.env.CAR_PAINT_QUALITY || 'medium';
const PORT = 4213;

async function freshPage(evalExpr, send) {
  await send('Page.navigate', { url: `http://localhost:${PORT}/?quality=${QUALITY}` });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    const r = await evalExpr('window.__GAME__ && window.__GAME__.ready === true').catch(() => false);
    if (r === true) { ready = true; break; }
    await sleep(500);
  }
  if (!ready) throw new Error('game never became ready after navigate');
  await sleep(1200);
}

async function main() {
  const h = await launchHarness({ previewPort: PORT, cdpPort: 9413, width: 1280, height: 720, headed: false, label: 'car-paint' });
  const { evalExpr, send } = h;
  const report = { quality: QUALITY, screenshots: {}, perf: {}, notes: [] };
  let exitCode = 0;

  async function shot(name) {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(OUT_DIR, `${name}.png`);
    writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log('[car-paint] wrote', p);
    return p;
  }

  try {
    // ---- 1. Side view, fresh boot, intact glass -- occupants should read through it. ----
    await freshPage(evalExpr, send);
    await evalExpr('window.__GAME__.setOrbitView({ radius: 5.5, height: 1.6, targetHeight: 0.75 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(0); "ok"');
    await sleep(800);
    report.screenshots.sideGlass = await shot('car-paint-side-glass');

    // ---- 2. Beauty shot: drive to the dirt-spur (same as verify/terrain.mjs's terrain-dirt-south),
    // fresh boot, default chase cam the whole time (setFixedAngle/setOrbitView never called this page
    // load -- see module doc comment (b)). ----
    await freshPage(evalExpr, send);
    await evalExpr("window.__GAME__.setInput({ throttle: 0.7, brake: 0, steer: 0, handbrake: false }); 'ok'");
    let t = await evalExpr('window.__GAME__.telemetry');
    for (let i = 0; i < 55 && t.chassisPos.z < 78; i++) {
      await evalExpr('window.__GAME__.stepN(12); "ok"');
      await sleep(70);
      t = await evalExpr('window.__GAME__.telemetry');
    }
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(700);
    report.screenshots.beauty = await shot('car-paint-beauty-dirtroad');
    report.perf = await evalExpr(
      '({ calls: window.__GAME__.renderer.info.render.calls, triangles: window.__GAME__.renderer.info.render.triangles })',
    );
    console.log('[car-paint] draw calls at beauty shot:', report.perf);

    // ---- 3. Post-crash, shattered glass (deterministic scripted crash, same technique as
    // verify/shoot-crash.mjs / feature-cardetail.mjs -- crash() calls crashSetup(), which does its own
    // resetVehicle() internally; that path does NOT exhibit quirk (a) above). ----
    await freshPage(evalExpr, send);
    // wall distance/speed/step-count match game/sim/occupants-active.test.mjs's proven-reliable
    // "70km/h ejects occupants who shatter the windshield" recipe (18-22m wall, 70km/h, ~600 steps --
    // the shatter is occupant-ejection-triggered, not immediate impact, so it needs the extra steps).
    await evalExpr("window.__GAME__.spawnTestWall(20); window.__GAME__.crash(70); window.__GAME__.stepN(500); 'ok'");
    await evalExpr('window.__GAME__.setOrbitView({ radius: 4.5, height: 2.6, targetHeight: 0.6 }); "ok"');
    await evalExpr('window.__GAME__.setFixedAngle(3.05); "ok"');
    await sleep(800);
    report.screenshots.crashShatter = await shot('car-paint-crash-shatter');

    const telemetry = await evalExpr('window.__GAME__.telemetry');
    report.notes.push(`post-crash damage telemetry: ${JSON.stringify(telemetry.damage)}`);
  } catch (err) {
    console.error('[car-paint] ERROR', err);
    exitCode = 1;
  }

  console.log('[car-paint] console errors:', h.consoleErrors.length, 'warnings:', h.consoleWarnings.length, 'page errors:', h.pageErrors.length);
  h.consoleErrors.forEach((e, i) => console.log(`  [err ${i}]`, e));
  h.pageErrors.forEach((e, i) => console.log(`  [pageErr ${i}]`, e));

  writeFileSync(
    path.join(OUT_DIR, 'console-report-car-paint.json'),
    JSON.stringify({ ...report, consoleErrors: h.consoleErrors, consoleWarnings: h.consoleWarnings, pageErrors: h.pageErrors }, null, 2),
  );

  await h.close();

  if (h.consoleErrors.length > 0 || h.pageErrors.length > 0) exitCode = 1;
  process.exit(exitCode);
}

main();
