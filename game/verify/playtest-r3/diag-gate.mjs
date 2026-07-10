// Ad hoc diagnostic: why does a dead-straight (steer=0, x should stay ~0) drive from spawn stop cold
// around z~46.9, right at the FENCE_CONFIGS z=46 line, despite x=0 sitting mid-gate ([-8,8])?
import { launchHarness } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4811, cdpPort: 9811, label: 'diag-gate' });
  const { evalExpr } = h;
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const fenceIds = ['fence-w3','fence-w2','fence-w1','fence-e1','fence-e2','fence-e3'];
  const before = {};
  for (const id of fenceIds) before[id] = await evalExpr(`window.__GAME__.features.buildings.brokenJointCountFor('${id}')`);
  console.log('broken before:', JSON.stringify(before));

  const run = await evalExpr(`(() => {
    const g = window.__GAME__;
    const samples = [];
    for (let i = 0; i < 400; i++) {
      g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
      g.stepN(1);
      const t = g.telemetry;
      if (i % 5 === 0 || (t.chassisPos.z > 38 && t.chassisPos.z < 50)) {
        samples.push({ i, x: +t.chassisPos.x.toFixed(3), z: +t.chassisPos.z.toFixed(2), y: +t.chassisPos.y.toFixed(2), speed: +t.speedKmh.toFixed(1), roll: +t.rollAngleRad.toFixed(3), up: +t.upDot.toFixed(3) });
      }
    }
    return samples;
  })()`);
  console.log('samples near gate:', JSON.stringify(run.filter(s => s.z > 30), null, 1));

  const after = {};
  for (const id of fenceIds) after[id] = await evalExpr(`window.__GAME__.features.buildings.brokenJointCountFor('${id}')`);
  console.log('broken after:', JSON.stringify(after));

  const dispByFence = {};
  for (const id of fenceIds) dispByFence[id] = await evalExpr(`window.__GAME__.features.buildings.pieceDisplacements('${id}')`);
  console.log('disp by fence:', JSON.stringify(dispByFence));

  const final = await evalExpr('window.__GAME__.telemetry');
  console.log('final pos:', JSON.stringify(final.chassisPos), 'speed:', final.speedKmh);
  console.log('final damage:', JSON.stringify(final.damage));
  console.log('wheelHeights:', JSON.stringify(await evalExpr('window.__GAME__.wheelHeights()')));
  console.log('suspensionDeflections:', JSON.stringify(await evalExpr('window.__GAME__.suspensionDeflections()')));
  console.log('debugReverse:', JSON.stringify(await evalExpr('window.__GAME__.debugReverse()')));
  console.log('chassisAwake:', await evalExpr('window.__GAME__.chassisAwake()'));

  await evalExpr('window.__GAME__.setOrbitView({ radius: 14, height: 6, targetHeight: 1 }); window.__GAME__.setFixedAngle(0.5); "ok"');
  await new Promise((r) => setTimeout(r, 700));
  await h.screenshot('diag-gate-stuck');

  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
