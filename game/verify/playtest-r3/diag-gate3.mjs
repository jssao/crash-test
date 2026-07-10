// Repeatability probe: same fresh-reset -> throttle=1/steer=0/900-step straight drive, ONE synchronous
// in-page loop (no intermediate round-trips), repeated N times in the SAME browser tab (fresh
// resetWorld() between each) to measure how often the car fully stalls vs. only shows brief transient
// wheel-ungrounding blips over the dirt-spur washboard (z 54-100, expected roughness).
import { launchHarness } from './lib.mjs';

async function main() {
  const h = await launchHarness({ previewPort: 4813, cdpPort: 9813, label: 'diag-gate3' });
  const { evalExpr } = h;
  const N = 6;
  const results = [];
  for (let trial = 0; trial < N; trial++) {
    await evalExpr("window.__GAME__.resetWorld(); 'ok'");
    const run = await evalExpr(`(() => {
      const g = window.__GAME__;
      let stalledAt = null;
      let lastZ = 0, stallStreak = 0;
      const trace = [];
      for (let i = 0; i < 900; i++) {
        g.setInput({ throttle: 1, brake: 0, steer: 0, handbrake: false });
        g.stepN(1);
        const t = g.telemetry;
        if (i % 60 === 0) trace.push({ i, z: +t.chassisPos.z.toFixed(1), speed: +t.speedKmh.toFixed(1) });
        if (t.speedKmh < 0.5 && t.chassisPos.z < 53) { stallStreak++; if (stallStreak > 30 && stalledAt === null) stalledAt = i; }
        else stallStreak = 0;
      }
      const t = g.telemetry;
      return { finalZ: +t.chassisPos.z.toFixed(2), finalSpeed: +t.speedKmh.toFixed(2), stalledAt, trace };
    })()`);
    console.log(`[trial ${trial}] finalZ=${run.finalZ} finalSpeed=${run.finalSpeed} stalledAt=${run.stalledAt}`);
    results.push(run);
  }
  const stalls = results.filter((r) => r.stalledAt !== null || r.finalZ < 53).length;
  console.log(`\nSTALL RATE: ${stalls}/${N}`);
  console.log(JSON.stringify(results, null, 1));
  await h.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
