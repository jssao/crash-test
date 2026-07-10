// Reproduce the kicker-ramp stall, then check whether reverse/brake can free the car, plus grab a
// screenshot of the stuck state for evidence.
import { launchHarness, sleep } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4815, cdpPort: 9815, label: 'diag-gate5' });
  const { evalExpr } = h;
  let stuck = null;
  for (let attempt = 0; attempt < 6 && !stuck; attempt++) {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    const run = await evalExpr(`(() => {
      const g = window.__GAME__;
      for (let i = 0; i < 500; i++) {
        g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
        g.stepN(1);
      }
      const t = g.telemetry;
      return { z: t.chassisPos.z, speed: t.speedKmh, up: t.upDot, roll: t.rollAngleRad };
    })()`);
    console.log(`[attempt ${attempt}] z=${run.z.toFixed(2)} speed=${run.speed.toFixed(2)} up=${run.up.toFixed(3)} roll=${run.roll.toFixed(3)}`);
    if (run.z < 53 && run.speed < 1) stuck = run;
  }
  if (!stuck) {
    console.log('could not reproduce a stall in 6 attempts this session -- stopping');
    await h.close();
    return;
  }
  console.log('STUCK, attempting recovery via reverse+steer...');
  await evalExpr('window.__GAME__.setOrbitView({ radius: 10, height: 4, targetHeight: 1 }); window.__GAME__.setFixedAngle(0.6); "ok"');
  await sleep(700);
  await h.screenshot('diag-stuck-before-recovery');

  const recovery = await evalExpr(`(() => {
    const g = window.__GAME__;
    const trace = [];
    for (let i = 0; i < 360; i++) {
      g.setInput({ throttle: 0, brake: 1, steer: (i % 120 < 60) ? 0.8 : -0.8, handbrake: false });
      g.stepN(1);
      if (i % 30 === 0) { const t = g.telemetry; trace.push({ i, z: +t.chassisPos.z.toFixed(2), speed: +t.speedKmh.toFixed(2) }); }
    }
    const t = g.telemetry;
    return { trace, finalZ: t.chassisPos.z, finalSpeed: t.speedKmh };
  })()`);
  console.log('recovery attempt:', JSON.stringify(recovery));
  await evalExpr('window.__GAME__.setFixedAngle(null); "ok"');
  await sleep(400);
  await h.screenshot('diag-stuck-after-recovery-attempt');

  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
