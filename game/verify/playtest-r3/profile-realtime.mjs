// Real-time FPS probe: measures the TRUE rAF frame rate (in-browser tick counter, bypassing the
// game's dt-clamped HUD fps) over real wall-clock, under two regimes:
//   A) car continuously MOVING on the live loop (no stepN)
//   B) car IDLE/static
// If moving-fps stays flat over minutes => no real-time renderer leak; the soak's "decay" is the
// headless rAF-throttle-when-static artifact (dt clamp floors HUD fps at ~10). If moving-fps decays
// => a genuine per-real-frame accumulator.
import { launchHarness, sleep, writeJson } from './lib.mjs';

const PREVIEW_PORT = 4213;
const CDP_PORT = 9463;

const TICKER = `
(() => {
  if (!window.__ticker) {
    window.__ticker = { frames: 0, last: performance.now() };
    const loop = () => { window.__ticker.frames++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  window.__tick = function () {
    const now = performance.now();
    const f = window.__ticker.frames;
    const dtMs = now - window.__ticker.last;
    const df = f - (window.__ticker.lastFrames || 0);
    window.__ticker.last = now;
    window.__ticker.lastFrames = f;
    const r = window.__GAME__.renderer;
    return {
      rafFps: dtMs > 0 ? (df / (dtMs / 1000)) : 0,
      calls: r.info.render.calls,
      geometries: r.info.memory.geometries,
      textures: r.info.memory.textures,
      programs: r.info.programs ? r.info.programs.length : null,
      hudFps: (document.getElementById('hud-perf')||{}).textContent || null,
      awake: window.__GAME__.chassisAwake(),
      spd: window.__GAME__.telemetry.speedKmh,
    };
  };
  return 'ok';
})()
`;

async function main() {
  const h = await launchHarness({ previewPort: PREVIEW_PORT, cdpPort: CDP_PORT, label: 'profile-rt' });
  await h.evalExpr(TICKER);
  await sleep(300);

  const rows = [];
  async function samp(regime, tSec) {
    const s = await h.evalExpr('window.__tick()');
    const heap = await h.evalExpr('performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1');
    const row = { regime, tSec, ...s, heapMB: heap };
    rows.push(row);
    const hudM = s.hudFps && /fps\s+(\d+)/.exec(s.hudFps);
    console.log(`[${regime}] t=${tSec}s rafFps=${s.rafFps.toFixed(1)} hudFps=${hudM?hudM[1]:'?'} calls=${s.calls} geo=${s.geometries} tex=${s.textures} spd=${s.spd.toFixed(1)} awake=${s.awake} heap=${heap}`);
    return row;
  }

  // --- Regime A: continuous circular driving on the LIVE loop for ~150s ---
  // Fresh, un-crashed world; keep throttle on with a constant steer so the car loops and the camera
  // keeps moving (stresses the exact "moving" case where the soak read high fps).
  await h.evalExpr('window.__GAME__.resetCar(); window.__GAME__.resetWorld(); "ok"');
  await h.evalExpr('window.__GAME__.setInput({ throttle: 0.8, brake: 0, steer: 0.25, handbrake: false }); "ok"');
  await sleep(2000);
  await samp('moving', 0);
  for (let t = 15; t <= 150; t += 15) {
    // keep the drive input fresh (setInput is sticky, but re-assert so nothing external clears it)
    await h.evalExpr('window.__GAME__.setInput({ throttle: 0.8, brake: 0, steer: 0.25, handbrake: false }); "ok"');
    await sleep(15000);
    await samp('moving', t);
  }

  // --- Regime B: idle/static for ~60s (expect headless rAF to throttle -> low rafFps) ---
  await h.evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: true }); "ok"');
  await sleep(3000);
  await samp('idle', 0);
  for (let t = 15; t <= 60; t += 15) {
    await sleep(15000);
    await samp('idle', t);
  }

  writeJson('profile-realtime-rows.json', rows);
  const moving = rows.filter((r) => r.regime === 'moving');
  const mFirst = moving[0], mLast = moving[moving.length - 1];
  console.log(`\nMOVING rafFps: first=${mFirst.rafFps.toFixed(1)} last=${mLast.rafFps.toFixed(1)} (ratio ${(mLast.rafFps/mFirst.rafFps).toFixed(2)})`);
  console.log(`MOVING renderer.info: calls ${mFirst.calls}->${mLast.calls}, geo ${mFirst.geometries}->${mLast.geometries}, heap ${mFirst.heapMB}->${mLast.heapMB}`);
  console.log('consoleErrors:', h.consoleErrors.length, 'pageErrors:', h.pageErrors.length);
  await h.close();
  await sleep(300);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
