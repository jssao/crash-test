import { launchHarness, DRIVE_TOWARD_SNIPPET } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4819, cdpPort: 9819, label: 'diag-midtree' });
  const { evalExpr } = h;
  await evalExpr(DRIVE_TOWARD_SNIPPET);
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  const before = await evalExpr('window.__GAME__.features.trees.snapshot()');
  console.log('mids before:', JSON.stringify(before.mids[0]));

  const r1 = await evalExpr('window.__driveToward(-72, -58, 1400, 5, 0.6, 0.7, 55, 60)');
  console.log('stageMid: steps=', r1.steps, 'finalPos=', JSON.stringify(r1.finalPos), 'maxSpeed=', r1.maxSpeedKmh, 'error=', JSON.stringify(r1.error));
  console.log('samples:', JSON.stringify(r1.samples));

  await evalExpr('window.__GAME__.setInput({ throttle: 0, brake: 0.6, steer: 0, handbrake: false }); window.__GAME__.stepN(90); "ok"');
  const r2 = await evalExpr('window.__driveToward(-72, -40, 700, 1, 0.65, 0.8, 30, 20)');
  console.log('feMid: steps=', r2.steps, 'finalPos=', JSON.stringify(r2.finalPos), 'maxSpeed=', r2.maxSpeedKmh);
  console.log('samples2:', JSON.stringify(r2.samples));

  const after = await evalExpr('window.__GAME__.features.trees.snapshot()');
  console.log('mids after:', JSON.stringify(after.mids[0]));
  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
