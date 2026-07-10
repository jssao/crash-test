import { launchHarness, DRIVE_TOWARD_SNIPPET } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4816, cdpPort: 9816, label: 'diag-brick' });
  const { evalExpr } = h;
  await evalExpr(DRIVE_TOWARD_SNIPPET);
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");

  const structInfo = await evalExpr('window.__GAME__.features.buildings.structures');
  console.log('structures:', JSON.stringify(structInfo));

  const dispBefore = await evalExpr("window.__GAME__.features.buildings.pieceDisplacements('brick-wall')");
  console.log('brick-wall piece count (non-static):', dispBefore.length);

  const legacyDispBefore = await evalExpr('window.__GAME__.destructibleDisplacements()');
  const drive = await evalExpr('window.__driveToward(16, 24, 500, 1.2, 0.75, 0.7, 60, 10)');
  const legacyDispAfter = await evalExpr('window.__GAME__.destructibleDisplacements()');
  const legacyMaxBefore = Math.max(...legacyDispBefore);
  const legacyMaxAfter = Math.max(...legacyDispAfter);
  console.log('legacy destructible maxDisp before/after:', legacyMaxBefore, legacyMaxAfter);
  const movedIdx = legacyDispAfter.map((d,i)=>[i,d]).filter(([,d]) => d > 0.1);
  console.log('legacy destructibles that moved >0.1m (index,disp):', JSON.stringify(movedIdx));
  console.log('drive result: steps=', drive.steps, 'finalPos=', JSON.stringify(drive.finalPos), 'maxSpeedKmh=', drive.maxSpeedKmh, 'error=', JSON.stringify(drive.error));
  console.log('samples:', JSON.stringify(drive.samples));

  const brokenAfter = await evalExpr("window.__GAME__.features.buildings.brokenJointCountFor('brick-wall')");
  const dispAfter = await evalExpr("window.__GAME__.features.buildings.pieceDisplacements('brick-wall')");
  console.log('brokenAfter=', brokenAfter, 'maxDispAfter=', Math.max(...dispAfter));

  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
