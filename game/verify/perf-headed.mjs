// Real-GPU HEADED fps check (PLAN-2.md item 11's "real-GPU headed check ≥ 55fps" half). Launches
// Brave HEADED (no SwiftShader/software-GL flags -- a real window is expected to appear on the
// desktop) and measures actual requestAnimationFrame throughput at spawn and mid-crash, independent of
// the game's own internal HUD fps readout (main.ts is out of this task's edit scope, and an
// independently-computed rAF counter is a more robust ground truth anyway). Same harness pattern as
// game/verify/playtest/headed.mjs (RUN 1's equivalent check) -- if there's no display/session
// reachable, this fails fast/skips rather than treating it as a game bug (same convention).
//
// Usage: node verify/perf-headed.mjs
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHarness, sleep } from './playtest/lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Captures a screenshot straight into game/verify/ (not playtest/lib.mjs's shared screenshot() helper,
 * which hardcodes its OUT_DIR to verify/playtest/ -- this task's OWNED PATHS keep new perf artifacts
 * directly under game/verify/). */
async function screenshotTo(h, name) {
  const shot = await h.send('Page.captureScreenshot', { format: 'png' });
  const outPath = path.join(__dirname, `${name}.png`);
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  return outPath;
}

/** Counts real rAF callbacks over `durationMs` of actual wall-clock time -- an independent ground-truth
 * fps measurement (not the game's own internal HUD counter). Returned as one Runtime.evaluate
 * (awaitPromise:true) call. */
function fpsProbeExpr(durationMs) {
  return `new Promise((resolve) => {
    let count = 0;
    const start = performance.now();
    function tick() {
      count++;
      const elapsed = performance.now() - start;
      if (elapsed < ${durationMs}) requestAnimationFrame(tick);
      else resolve({ frames: count, elapsedMs: elapsed, fps: count / (elapsed / 1000) });
    }
    requestAnimationFrame(tick);
  })`;
}

async function main() {
  let h;
  try {
    h = await launchHarness({ previewPort: 4198, cdpPort: 9448, width: 1280, height: 720, headed: true, label: 'perf-headed' });
  } catch (err) {
    const report = { skipped: true, reason: 'could not launch a headed browser (likely no display/session available)', error: String(err && err.message || err) };
    console.log('[perf-headed] SKIPPED:', report.reason, '--', report.error);
    writeFileSync(path.join(__dirname, 'console-report-perf-headed.json'), JSON.stringify(report, null, 2));
    process.exit(2);
  }
  const { evalExpr } = h;
  const report = { headed: true };
  try {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    await evalExpr("window.__GAME__.setInput({ throttle: 0, brake: 0, steer: 0, handbrake: false }); 'ok'");

    // ---- SPAWN fps: idle, default view, real GPU. ----
    await sleep(500);
    report.spawnFps = await evalExpr(fpsProbeExpr(3000));
    console.log('[perf-headed] SPAWN fps probe:', JSON.stringify(report.spawnFps));
    const spawnShot = await screenshotTo(h, 'perf-headed-spawn');

    // ---- MID-CRASH fps: spawn a wall, teleport to speed toward it (same trick as shoot-crash.mjs's
    // window.__GAME__.crash()), give it a beat of real time to reach + smash through, THEN measure fps
    // during the immediate aftermath (panels detached/debris scattering -- the actual "worst-case
    // scene mid-crash" moment the gate cares about). ----
    await evalExpr('window.__GAME__.spawnTestWall(25); "ok"');
    await evalExpr('window.__GAME__.crash(90); "ok"');
    await evalExpr("window.__GAME__.setInput({ throttle: 0.3, brake: 0, steer: 0, handbrake: false }); 'ok'");
    await sleep(1200); // ~90km/h (25m/s) covers the 25m runway in ~1s -- real wall-clock time for the actual impact to occur
    report.telemetryAtCrash = await evalExpr('window.__GAME__.telemetry');
    report.midCrashFps = await evalExpr(fpsProbeExpr(3000));
    console.log('[perf-headed] MID-CRASH fps probe:', JSON.stringify(report.midCrashFps));
    const crashShot = await screenshotTo(h, 'perf-headed-mid-crash');

    report.screenshots = { spawn: spawnShot, midCrash: crashShot };
    report.consoleErrors = h.consoleErrors;
    report.pageErrors = h.pageErrors;
    report.timestamp = new Date().toISOString();

    const gatePass = report.midCrashFps.fps >= 55;
    report.gate = { requiredMidCrashFpsGte: 55, actual: report.midCrashFps.fps, pass: gatePass };
    console.log(`[perf-headed] REQUIRED mid-crash fps >= 55 (real GPU, headed): ${gatePass ? 'PASS' : 'FAIL'} (actual=${report.midCrashFps.fps.toFixed(1)})`);
    console.log('[perf-headed] console errors:', h.consoleErrors.length, 'page errors:', h.pageErrors.length);

    writeFileSync(path.join(__dirname, 'console-report-perf-headed.json'), JSON.stringify(report, null, 2));
    console.log('[perf-headed] wrote', path.join(__dirname, 'console-report-perf-headed.json'));

    const exitCode = gatePass && h.consoleErrors.length === 0 && h.pageErrors.length === 0 ? 0 : 1;
    await h.close();
    process.exit(exitCode);
  } catch (err) {
    console.error('[perf-headed] FATAL', err);
    report.error = String(err && err.message || err);
    writeFileSync(path.join(__dirname, 'console-report-perf-headed.json'), JSON.stringify(report, null, 2));
    await h.close();
    process.exit(1);
  }
}

main();
