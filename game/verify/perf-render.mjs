// Render-cost profile (PLAN-2.md item 11's browser half): reads window.__GAME__.renderer.info (draw
// calls / triangles) at spawn and mid-crash, plus per-feature body counts, via CDP against a headless
// (SwiftShader) Brave -- draw-call/triangle counts don't need real-GPU accuracy, only the real-GPU fps
// check (perf-headed.mjs) does. Reuses game/verify/playtest/lib.mjs's harness (same pattern as every
// other verify/playtest script) rather than re-implementing the CDP/preview boilerplate.
//
// Usage: node verify/perf-render.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const h = await launchHarness({ previewPort: 4197, cdpPort: 9447, headed: false, label: 'perf-render' });
  const { evalExpr } = h;
  let exitCode = 0;
  const report = {};
  try {
    // ---- SPAWN: read render stats right after the game is ready + a couple of real frames have
    // rendered (launchHarness already waits ~1.2s post-ready for shadow map/PMREM/texture settle). ----
    report.spawn = await evalExpr(`({
      renderCalls: window.__GAME__.renderer.info.render.calls,
      triangles: window.__GAME__.renderer.info.render.triangles,
      featureBodyCount: window.__GAME__.featureBodyCount(),
      destructibleBodyCount: window.__GAME__.destructibleBodyCount,
    })`);
    console.log('[perf-render] SPAWN:', JSON.stringify(report.spawn));

    // ---- MID-CRASH: same deterministic wall-crash scenario as verify/shoot-crash.mjs (spawnTestWall
    // + crash(70km/h) + stepN through impact), then a couple more real frames so renderer.info reflects
    // the post-impact (panels detached/debris scattering) frame. ----
    await evalExpr('window.__GAME__.spawnTestWall(25); "ok"');
    await evalExpr('window.__GAME__.crash(70); "ok"');
    await evalExpr('window.__GAME__.stepN(360); "ok"'); // 6s @ 60Hz -- reach the wall + settle, same as shoot-crash.mjs
    await sleep(500); // let the real rAF loop render a few more frames so renderer.info is current

    report.midCrashChase = await evalExpr(`({
      renderCalls: window.__GAME__.renderer.info.render.calls,
      triangles: window.__GAME__.renderer.info.render.triangles,
    })`);
    console.log('[perf-render] MID-CRASH (default chase cam):', JSON.stringify(report.midCrashChase));

    // ---- WIDE ORBIT: a pulled-back orbit view (still centered on the car, per cameraOrbit.ts's
    // focus-tracking) to see more of the surrounding destructible/tree/building field in frustum at
    // once -- an upper-bound "worst visible" draw-call reading beyond what the tight default chase cam
    // shows. ----
    await evalExpr('window.__GAME__.setOrbitView({ radius: 120, height: 70, angularSpeed: 0, targetHeight: 0 }); "ok"');
    await sleep(500);
    report.midCrashWideOrbit = await evalExpr(`({
      renderCalls: window.__GAME__.renderer.info.render.calls,
      triangles: window.__GAME__.renderer.info.render.triangles,
    })`);
    console.log('[perf-render] MID-CRASH (wide orbit, ~120m out):', JSON.stringify(report.midCrashWideOrbit));

    report.consoleErrors = h.consoleErrors;
    report.pageErrors = h.pageErrors;
    report.timestamp = new Date().toISOString();
    console.log('[perf-render] console errors:', h.consoleErrors.length, 'page errors:', h.pageErrors.length);
    if (h.consoleErrors.length > 0 || h.pageErrors.length > 0) exitCode = 1;
  } catch (err) {
    console.error('[perf-render] ERROR', err);
    report.error = String(err && err.message || err);
    exitCode = 1;
  } finally {
    await h.close();
  }

  const outPath = path.join(__dirname, 'console-report-perf-render.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('[perf-render] wrote', outPath);
  process.exit(exitCode);
}

main();
