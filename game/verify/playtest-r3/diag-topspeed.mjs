// Confirms/refutes the long-session-soak's observed speed=323km/h sample: drives straight (small
// steer, matching 'perimeter-fast') for a real 30s via the game's own rAF loop (not stepN, since
// vehicle.ts's aero-drag comments reference a "settle speed ~230-240km/h" design target that's
// presumably reached asymptotically over real TIME, not fixed-step count -- this reproduces the exact
// real-time-driven conditions the soak used).
import { launchHarness, sleep } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4823, cdpPort: 9823, label: 'diag-topspeed' });
  const { evalExpr } = h;
  await evalExpr("window.__GAME__.resetWorld(); 'ok'");
  await evalExpr("window.__GAME__.setInput({ throttle: 1, brake: 0, steer: 0.1, handbrake: false }); 'ok'");

  const t0 = Date.now();
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    const t = await evalExpr('window.__GAME__.telemetry');
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s speed=${t.speedKmh.toFixed(1)} pos=${JSON.stringify(t.chassisPos)} up=${t.upDot.toFixed(3)} finite=${Number.isFinite(t.speedKmh)}`);
  }
  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
