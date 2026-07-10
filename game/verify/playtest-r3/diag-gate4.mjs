// Confirms/refutes: is the z~46.8 "stall" actually the car driving straight up the KICKER RAMP
// (world/tuning.ts RAMP_CONFIGS 'kicker': centerX=0, backZ=43, 30deg, height 1.2m -- SAME x=0 line as
// a naive straight-north drive from spawn) rather than anything to do with the fence/gate?
import { launchHarness } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4814, cdpPort: 9814, label: 'diag-gate4' });
  const { evalExpr } = h;
  const N = 4;
  for (let trial = 0; trial < N; trial++) {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    const run = await evalExpr(`(() => {
      const g = window.__GAME__;
      const trace = [];
      for (let i = 0; i < 420; i++) {
        g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
        g.stepN(1);
        const t = g.telemetry;
        if (t.chassisPos.z > 40 && t.chassisPos.z < 50) {
          trace.push({ i, x: +t.chassisPos.x.toFixed(2), z: +t.chassisPos.z.toFixed(2), y: +t.chassisPos.y.toFixed(3), speed: +t.speedKmh.toFixed(1), roll: +t.rollAngleRad.toFixed(2), up: +t.upDot.toFixed(3) });
        }
      }
      return trace;
    })()`);
    console.log(`\n[trial ${trial}] samples in z=[40,50]:`);
    console.log(run.map(s => `i=${s.i} x=${s.x} z=${s.z} y=${s.y} spd=${s.speed} roll=${s.roll} up=${s.up}`).join('\n'));
  }
  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
