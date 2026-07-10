// FPS-decay profiler (OBJECTIVE: find what accumulates while heap/handles/audio stay flat).
// Drives crash-heavy sequences via deterministic stepN, then samples renderer.info + scene object
// counts + physics awake/body counts + a MEASURED render time (median of K renderer.render calls).
// If render.calls/triangles/geometries grow monotonically => renderer accumulator. If they stay flat
// but render time or physics awake grows => the accumulator is elsewhere.
import { launchHarness, sleep, writeJson } from './lib.mjs';

const PREVIEW_PORT = 4212;
const CDP_PORT = 9462;

// Capture scene+camera off the live render loop so we can time explicit renderer.render() calls,
// and expose renderer.info + scene stats in one shot.
const PROBE = `
(() => {
  const r = window.__GAME__.renderer;
  if (!window.__probeInstalled) {
    const orig = r.render.bind(r);
    r.render = function (s, c) { window.__scene = s; window.__cam = c; return orig(s, c); };
    window.__probeInstalled = true;
  }
  window.__sample = function (renderTimes) {
    const r = window.__GAME__.renderer;
    const info = r.info;
    const scene = window.__scene;
    let objs = 0, meshes = 0, sprites = 0, visible = 0, lights = 0, points = 0, lineSeg = 0;
    let geomInScene = new Set();
    if (scene) scene.traverse((o) => {
      objs++;
      if (o.visible) visible++;
      if (o.isMesh) { meshes++; if (o.geometry) geomInScene.add(o.geometry.uuid); }
      if (o.isSprite) sprites++;
      if (o.isPoints) points++;
      if (o.isLineSegments) lineSeg++;
      if (o.isLight) lights++;
    });
    // Measured render cost: time K explicit renders (median).
    const cam = window.__cam;
    const times = [];
    if (scene && cam) {
      for (let i = 0; i < (renderTimes || 8); i++) {
        const t0 = performance.now();
        r.render(scene, cam);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
    }
    const medMs = times.length ? times[Math.floor(times.length / 2)] : null;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : null,
      sceneObjs: objs, meshes, sprites, pointsObjs: points, lineSeg, lights, visible,
      geomInScene: geomInScene.size,
      renderMedMs: medMs,
    };
  };
  return 'ok';
})()
`;

async function main() {
  const h = await launchHarness({ previewPort: PREVIEW_PORT, cdpPort: CDP_PORT, label: 'profile-fps' });
  await h.evalExpr(PROBE);
  await sleep(500);

  const samples = [];
  async function sample(round, note) {
    const s = await h.evalExpr('window.__sample(10)');
    const tel = await h.evalExpr('({ awake: window.__GAME__.chassisAwake(), fb: window.__GAME__.featureBodyCount(), db: window.__GAME__.destructibleBodyCount, lh: window.__GAME__.liveHandleCount(), spd: window.__GAME__.telemetry.speedKmh })');
    const fpsTxt = await h.evalExpr("document.getElementById('hud-perf') ? document.getElementById('hud-perf').textContent : null");
    const fpsM = fpsTxt && /fps\\s+(\\d+)/.exec(fpsTxt);
    const row = { round, note, ...s, ...tel, fps: fpsM ? Number(fpsM[1]) : null };
    samples.push(row);
    console.log(
      `[r${String(round).padStart(2)}] ${note.padEnd(16)} calls=${s.calls} tri=${s.triangles} geo=${s.geometries} tex=${s.textures} prog=${s.programs} objs=${s.sceneObjs} mesh=${s.meshes} spr=${s.sprites} pts=${s.pointsObjs} render=${s.renderMedMs?.toFixed(2)}ms | awake=${tel.awake} fb=${tel.fb} db=${tel.db} fps=${row.fps}`,
    );
    return row;
  }

  await sample(0, 'baseline-idle');

  // Crash-heavy loop: each round spawns a wall ahead, crashes into it, triggers barrels/collapses by
  // driving, then lets debris settle. Deterministic stepN so wall-clock throttling can't confound.
  for (let round = 1; round <= 12; round++) {
    // High-speed crash into a fresh test wall.
    await h.evalExpr('window.__GAME__.resetCar(); window.__GAME__.spawnTestWall(18); "ok"');
    await h.evalExpr('window.__GAME__.crash(90); "ok"');
    await h.evalExpr('window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(140); "ok"');
    // Let debris/effects live and settle (sprites age out, chunks come to rest).
    await h.evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0.2, steer: 0, handbrake: false }); window.__GAME__.stepN(220); "ok"');
    await sample(round, `after-crash-${round}`);
  }

  // Idle-settle tail: does render cost / awake set come back down once everything sleeps?
  await h.evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 1, steer: 0, handbrake: true }); window.__GAME__.stepN(600); "ok"');
  await sample(99, 'post-settle-idle');

  const first = samples[1] || samples[0];
  const last = samples[samples.length - 2] || samples[samples.length - 1];
  const summary = {
    calls: [first.calls, last.calls],
    triangles: [first.triangles, last.triangles],
    geometries: [first.geometries, last.geometries],
    textures: [first.textures, last.textures],
    programs: [first.programs, last.programs],
    sceneObjs: [first.sceneObjs, last.sceneObjs],
    meshes: [first.meshes, last.meshes],
    sprites: [first.sprites, last.sprites],
    renderMedMs: [first.renderMedMs, last.renderMedMs],
    awake: [first.awake, last.awake],
    featureBodies: [first.fb, last.fb],
  };
  writeJson('profile-fps-samples.json', samples);
  writeJson('profile-fps-summary.json', summary);
  console.log('\\nSUMMARY (first-crash -> last-crash):', JSON.stringify(summary, null, 2));
  console.log('consoleErrors:', h.consoleErrors.length, 'pageErrors:', h.pageErrors.length);
  await h.close();
  await sleep(300);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
