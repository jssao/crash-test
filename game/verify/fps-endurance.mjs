// FPS ENDURANCE GATE (exit-gated).
//
// Guards against a per-real-frame renderer accumulator (draw calls / geometry / GPU state that grows
// over a long continuous session even though heap/handle/audio counts stay flat). Root-cause profiling
// (verify/playtest-r3/profile-fps.mjs + profile-realtime.mjs) established that FPS in this game is a
// pure function of how many draw calls sit in the camera frustum -- NOT of elapsed time -- and that
// renderer.info (calls/triangles/geometries/textures/programs), scene object count and heap are all
// flat/plateaued across a crash-heavy session. This gate freezes the confound (camera pose + scene
// state are made identical at the first and last measurement) so that ANY genuine temporal growth in
// per-frame cost shows up as an fps drop, while the position-driven variation that fooled the original
// long-session soak is removed.
//
// Method:
//   1. Lock a fixed orbit camera around the origin (setOrbitView + setFixedAngle) so the frustum's
//      draw-call count is constant and repeatable.
//   2. resetCar + resetWorld -> pristine full scene; measure baseline fps as REAL requestAnimationFrame
//      ticks over a window (bypasses the game HUD's dt-clamp, which floors reported fps at ~10).
//   3. Run repeated real-time crash cycles on the LIVE animation loop (spawn wall, crash, drive, settle,
//      reset) for the whole session -- exercising crumple geometry re-uploads, panel-detach visuals,
//      explosion sprites, damage, collapse.
//   4. resetCar + resetWorld -> identical pristine full scene; measure final fps the same way.
//   5. GATE: final fps >= 0.70 * initial fps. Also asserts renderer.info counts did not grow beyond a
//      small plateau tolerance and heap did not balloon.
//
// Usage: node verify/fps-endurance.mjs            (full 8-min session)
//        DURATION_MS=120000 node verify/fps-endurance.mjs   (short validation run)
import { launchHarness, sleep, writeJson } from './playtest-r3/lib.mjs';

const PREVIEW_PORT = 4223;
const CDP_PORT = 9473;
const DURATION_MS = Number(process.env.DURATION_MS || 8 * 60 * 1000); // 8-min scripted session
const FPS_WINDOW_MS = 12000; // rAF-tick averaging window for each fps measurement
const GATE_RATIO = 0.7; // final fps must be >= 70% of initial

// In-browser rAF tick counter -> true frame rate (independent of the game's dt-clamped HUD fps), plus
// a scene-object census (via a wrapper capturing the live render's scene) so a debris-accumulation
// leak that is frustum-culled -- and thus invisible in fps/draw-calls -- still trips the gate.
const TICKER = `
(() => {
  if (!window.__ticker) {
    window.__ticker = { frames: 0 };
    const loop = () => { window.__ticker.frames++; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  if (!window.__renderWrapped) {
    const r = window.__GAME__.renderer;
    const orig = r.render.bind(r);
    r.render = function (s, c) { window.__scene = s; return orig(s, c); };
    window.__renderWrapped = true;
  }
  window.__frames = () => window.__ticker.frames;
  window.__info = () => {
    const r = window.__GAME__.renderer, i = r.info;
    let objs = 0, meshes = 0, sprites = 0;
    if (window.__scene) window.__scene.traverse((o) => { objs++; if (o.isMesh) meshes++; if (o.isSprite) sprites++; });
    return {
      calls: i.render.calls, triangles: i.render.triangles,
      geometries: i.memory.geometries, textures: i.memory.textures,
      programs: i.programs ? i.programs.length : null,
      sceneObjs: objs, meshes, sprites,
    };
  };
  return 'ok';
})()
`;

async function main() {
  const h = await launchHarness({ previewPort: PREVIEW_PORT, cdpPort: CDP_PORT, label: 'fps-endurance' });
  await h.evalExpr(TICKER);

  // ---- Lock a fixed, populated overview: orbit the origin at a fixed angle so draw calls are constant
  // and repeatable across the two measurements. Radius frames the car + surrounding compound. ----
  async function freezeView() {
    await h.evalExpr(
      'window.__GAME__.setOrbitView({ radius: 22, height: 9, targetHeight: 1.2, angularSpeed: 0 }); window.__GAME__.setFixedAngle(0.6); "ok"',
    );
  }
  async function restoreScene() {
    await h.evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: true }); window.__GAME__.resetCar(); window.__GAME__.resetWorld(); "ok"');
    await freezeView();
  }

  // GC + measure true fps over a window (real rAF ticks / real elapsed seconds).
  async function measureFps(label) {
    await h.send('HeapProfiler.collectGarbage').catch(() => {});
    await sleep(500);
    const f0 = await h.evalExpr('window.__frames()');
    const t0 = Date.now();
    await sleep(FPS_WINDOW_MS);
    const f1 = await h.evalExpr('window.__frames()');
    const t1 = Date.now();
    const info = await h.evalExpr('window.__info()');
    const heap = await h.evalExpr('performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1');
    const fps = (f1 - f0) / ((t1 - t0) / 1000);
    console.log(`[${label}] fps=${fps.toFixed(1)} calls=${info.calls} tri=${info.triangles} geo=${info.geometries} tex=${info.textures} prog=${info.programs} objs=${info.sceneObjs} mesh=${info.meshes} spr=${info.sprites} heap=${heap}MB`);
    return { fps, ...info, heapMB: heap };
  }

  // One real-time crash cycle on the live loop (crumple + panel detach + debris + settle).
  async function crashCycle() {
    await h.evalExpr('window.__GAME__.resetCar(); window.__GAME__.spawnTestWall(16); "ok"');
    await h.evalExpr('window.__GAME__.crash(85); window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); "ok"');
    await sleep(1400); // impact + follow-through on the live loop
    await h.evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: false }); "ok"');
    await sleep(1200); // settle: sprites age out, chunks come to rest
  }

  // ---- Warm-up: saturate the one-time deformation working-buffer ramp (each mesh clones its position/
  // normal attributes the first time it deforms -> renderer.info.memory.geometries ramps to a plateau).
  // Measuring baseline only AFTER the plateau means any post-baseline geometry growth is a TRUE leak,
  // not the expected one-time ramp. ----
  await restoreScene();
  for (let i = 0; i < 18; i++) await crashCycle();

  // ---- Baseline (post-plateau, pristine restored scene, frozen view) ----
  await restoreScene();
  await sleep(1500);
  const baseline = await measureFps('baseline');

  // ---- Endurance: real-time crash cycles on the live loop until the session budget elapses ----
  const start = Date.now();
  let cycle = 0;
  while (Date.now() - start < DURATION_MS) {
    cycle++;
    await crashCycle();
    if (cycle % 10 === 0) {
      const info = await h.evalExpr('window.__info()');
      const heap = await h.evalExpr('performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1');
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`  ...cycle ${cycle} t=${elapsed}s calls=${info.calls} geo=${info.geometries} tex=${info.textures} prog=${info.programs} heap=${heap}MB`);
    }
  }
  console.log(`ran ${cycle} crash cycles over ${((Date.now() - start) / 1000).toFixed(0)}s`);

  // ---- Final: identical pristine scene + identical frozen view ----
  await restoreScene();
  await sleep(1500);
  const final = await measureFps('final');

  // ---- Gate ----
  // PRIMARY: true fps at the frozen full-scene view must not decay (the objective's acceptance).
  // SECONDARY leak guards (measured post-plateau, so the one-time deformation ramp is already spent):
  //   - geometries: a per-cycle BufferGeometry leak would keep climbing past the plateau.
  //   - sceneObjs:  a debris-accumulation leak grows the scene graph even while frustum-culled (so it
  //                 would be invisible in fps / draw-calls) -- this catches that class directly.
  //   - heap:       backstop for any JS-side reservoir.
  const ratio = final.fps / baseline.fps;
  const geoGrowth = final.geometries - baseline.geometries;
  const objGrowth = final.sceneObjs - baseline.sceneObjs;
  const heapGrowth = final.heapMB - baseline.heapMB;
  const pass =
    ratio >= GATE_RATIO &&
    geoGrowth <= 20 && // post-plateau: expect ~0; a real per-cycle geometry leak would exceed this
    objGrowth <= 20 && // scene graph must not grow across identical restored-scene endpoints
    heapGrowth <= 40;

  const result = {
    pass, gateRatio: GATE_RATIO, ratio: +ratio.toFixed(3),
    baselineFps: +baseline.fps.toFixed(1), finalFps: +final.fps.toFixed(1),
    cycles: cycle, durationMs: DURATION_MS,
    rendererInfo: { baseline, final },
    geoGrowth, objGrowth, heapGrowth,
    consoleErrors: h.consoleErrors.length, pageErrors: h.pageErrors.length,
  };
  writeJson('../fps-endurance-result.json', result);
  console.log('\nRESULT:', JSON.stringify(result, null, 2));

  await h.close();
  await sleep(300);
  if (!pass) {
    console.error(`FAIL: final fps ${final.fps.toFixed(1)} is ${(ratio * 100).toFixed(0)}% of initial ${baseline.fps.toFixed(1)} (need >=${GATE_RATIO * 100}%); geoGrowth=${geoGrowth} objGrowth=${objGrowth} heapGrowth=${heapGrowth}MB`);
    process.exit(1);
  }
  console.log(`PASS: final fps ${final.fps.toFixed(1)} is ${(ratio * 100).toFixed(0)}% of initial ${baseline.fps.toFixed(1)} (gate >=${GATE_RATIO * 100}%); geoGrowth=${geoGrowth} objGrowth=${objGrowth} heapGrowth=${heapGrowth}MB.`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
