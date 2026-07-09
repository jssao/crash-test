// PLAYTEST scenario 10 (optional): launch Brave HEADED (no SwiftShader/software-GL flags) for a real
// 60s drive with the fps/physics-ms perf readout visible, screenshotted. A real window is expected to
// appear on the desktop -- authorized per the QA brief. If there's no display/session available (no
// window server reachable), this fails fast; the caller should just note that and move on rather than
// treating it as a game bug.
//
// Usage: node verify/playtest/headed.mjs
import { launchHarness, sleep } from './lib.mjs';

async function main() {
  let h;
  try {
    h = await launchHarness({ previewPort: 4195, cdpPort: 9445, width: 1280, height: 720, headed: true, label: 'headed' });
  } catch (err) {
    console.log('[headed] SKIPPED: could not launch a headed browser (likely no display/session available):', err.message);
    process.exit(2);
  }
  const { evalExpr, screenshot } = h;
  try {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    // Show the perf readout for the screenshot.
    await h.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyF', key: 'f' });
    await h.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyF', key: 'f' });
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); 'ok'");
    // Real 60s wall-clock drive -- this is the ONE scenario that intentionally waits on real time/real
    // GPU rendering rather than stepN(), since the whole point is to see real-GPU frame timing.
    const t0 = Date.now();
    let lastSteer = 0;
    while (Date.now() - t0 < 60000) {
      lastSteer = Math.sin((Date.now() - t0) / 1500) * 0.2;
      await evalExpr(`window.__GAME__.setInput({ throttle: 1, brake: 0, steer: ${lastSteer}, handbrake: false }); 'ok'`);
      await sleep(500);
    }
    const telemetry = await evalExpr('window.__GAME__.telemetry');
    const shot = await screenshot('10-headed-real-gpu-60s');
    console.log('[headed] 60s real drive complete. speed=', telemetry.speedKmh.toFixed(1), 'screenshot:', shot);
    console.log('[headed] console errors:', h.consoleErrors.length, 'page errors:', h.pageErrors.length);
    console.log(JSON.stringify({ speedKmh: telemetry.speedKmh, consoleErrors: h.consoleErrors, pageErrors: h.pageErrors }, null, 2));
  } finally {
    await h.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[headed] FATAL', err);
  process.exit(1);
});
