// Isolate the +1 geometry/cycle leak: run each sub-action of a crash cycle separately on the live
// loop and read renderer.info.memory.geometries after each, to pin which action creates an
// undisposed BufferGeometry.
import { launchHarness, sleep } from './lib.mjs';
const PREVIEW_PORT = 4233, CDP_PORT = 9483;

async function main() {
  const h = await launchHarness({ previewPort: PREVIEW_PORT, cdpPort: CDP_PORT, label: 'iso-geo' });
  const geo = () => h.evalExpr('window.__GAME__.renderer.info.memory.geometries');
  const settle = (ms) => sleep(ms); // let the live loop render a frame so uploads/disposals apply

  await h.evalExpr('window.__GAME__.resetCar(); window.__GAME__.resetWorld(); "ok"');
  await settle(800);
  console.log('pristine geo =', await geo());

  async function trial(name, fn, n = 8) {
    const before = await geo();
    for (let i = 0; i < n; i++) { await fn(); await settle(250); }
    await settle(400);
    const after = await geo();
    console.log(`${name.padEnd(28)} x${n}: ${before} -> ${after}  (delta ${after - before}, ${((after - before) / n).toFixed(2)}/it)`);
  }

  await trial('resetCar only', () => h.evalExpr('window.__GAME__.resetCar(); "ok"'));
  await trial('resetWorld only', () => h.evalExpr('window.__GAME__.resetWorld(); "ok"'));
  await trial('spawnTestWall only', () => h.evalExpr('window.__GAME__.spawnTestWall(16); "ok"'));
  await trial('crash+step (no reset)', async () => {
    await h.evalExpr('window.__GAME__.crash(85); window.__GAME__.setInput({throttle:1,brake:0,steer:0,handbrake:false}); "ok"');
    await settle(700);
    await h.evalExpr('window.__GAME__.setInput({throttle:0,brake:1,steer:0,handbrake:false}); "ok"');
  });
  await trial('full cycle (reset+wall+crash)', async () => {
    await h.evalExpr('window.__GAME__.resetCar(); window.__GAME__.spawnTestWall(16); window.__GAME__.crash(85); window.__GAME__.setInput({throttle:1,brake:0,steer:0,handbrake:false}); "ok"');
    await settle(700);
    await h.evalExpr('window.__GAME__.setInput({throttle:0,brake:1,steer:0,handbrake:false}); "ok"');
  });

  console.log('consoleErrors:', h.consoleErrors.slice(0, 4));
  await h.close();
  await sleep(200);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
