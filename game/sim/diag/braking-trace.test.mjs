import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
describe('diag: braking trace', () => {
  it('logs speed each step during braking', async () => {
    const sim = await createSim();
    try {
      let reached = false;
      const rows = [];
      for (let i = 0; i < 300; i++) {
        const tel = sim.telemetry();
        if (!reached && tel.speedKmh >= 80) reached = true;
        sim.step({ throttle: reached ? 0 : 1, brake: reached ? 1 : 0, steer: 0, handbrake: false });
        if (reached) {
          const t2 = sim.telemetry();
          rows.push(t2.speedKmh.toFixed(2));
          if (t2.speedKmh < 2) break;
        }
      }
      console.log('[brake-speed-trace]', rows.join(','));
      // compute decel g between consecutive steps (1/60s)
      const gs = [];
      for (let i=1;i<rows.length;i++){
        const v0=parseFloat(rows[i-1])/3.6, v1=parseFloat(rows[i])/3.6;
        gs.push(((v0-v1)/(1/60)/9.81).toFixed(3));
      }
      console.log('[brake-decel-g-per-step]', gs.join(','));
    } finally { sim.destroy(); }
  });
});
