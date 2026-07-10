import { launchHarness, DRIVE_TOWARD_SNIPPET } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4822, cdpPort: 9822, label: 'diag-maxchaos' });
  const { evalExpr } = h;
  await evalExpr(DRIVE_TOWARD_SNIPPET);
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");

  const runup = await evalExpr(`(() => {
    const g = window.__GAME__;
    function yawOf(q) { const t={x:2*(q.y*1-q.z*0),y:2*(q.z*0-q.x*1),z:2*(q.x*0-q.y*0)}; return Math.atan2(0+q.w*t.x+(q.y*t.z-q.z*t.y),1+q.w*t.z+(q.x*t.y-q.y*t.x)); }
    function wrap(a){while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a;}
    let maxSpeed=0;
    for (let i=0;i<650;i++){ const t=g.telemetry; const dy=Math.atan2(4.5-t.chassisPos.x,(t.chassisPos.z+20)-t.chassisPos.z); const err=wrap(dy-yawOf(t.chassisQuat)); const steer=Math.max(-1,Math.min(1,-err*0.8)); g.setInput({throttle:1,brake:0,steer,handbrake:false}); g.stepN(1); maxSpeed=Math.max(maxSpeed,t.speedKmh); }
    return { maxSpeedKmh: maxSpeed, finalPos: g.telemetry.chassisPos };
  })()`);
  console.log('runup:', JSON.stringify(runup));

  const toShed = await evalExpr('window.__driveToward(-30, 33, 1400, 1.5, 0.85, 0.7, 400, 40)');
  console.log('toShed: steps=', toShed.steps, 'finalPos=', JSON.stringify(toShed.finalPos), 'speed=', toShed.speedKmh);
  let shedStats = { collapsing: await evalExpr("window.__GAME__.features.buildings.collapsingBodyCountFor('shed')") };
  for (let a = 0; a < 4 && shedStats.collapsing <= 0; a++) {
    await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false }); window.__GAME__.stepN(60); 'ok'");
    shedStats = { collapsing: await evalExpr("window.__GAME__.features.buildings.collapsingBodyCountFor('shed')") };
  }
  const postShed = await evalExpr('window.__GAME__.telemetry');
  console.log('after shed ram+retries: pos=', JSON.stringify(postShed.chassisPos), 'speed=', postShed.speedKmh, 'up=', postShed.upDot, 'collapsing=', shedStats.collapsing);

  const toBarrels = await evalExpr('window.__driveToward(16, 33, 1400, 1.5, 0.85, 0.7, 400, 40)');
  console.log('toBarrels: steps=', toBarrels.steps, 'finalPos=', JSON.stringify(toBarrels.finalPos), 'speed=', toBarrels.speedKmh, 'maxSpeed=', toBarrels.maxSpeedKmh);
  console.log('samples:', JSON.stringify(toBarrels.samples));

  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
