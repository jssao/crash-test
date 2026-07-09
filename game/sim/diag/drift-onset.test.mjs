import { describe, it } from 'vitest';
import { createSim } from '../harness.mjs';
describe('diag: drift onset fine trace', () => {
  it('per-step trace t=3.0-5.5s', async () => {
    const sim = await createSim();
    try {
      for (let i=0;i<180;i++) sim.step({throttle:1,brake:0,steer:0,handbrake:false}); // to t=3.0
      const rows=[];
      for (let i=0;i<150;i++){ // 2.5s more
        sim.step({throttle:1,brake:0,steer:0,handbrake:false});
        const t=sim.telemetry();
        rows.push(`${(3+ (i+1)/60).toFixed(3)},${t.speedKmh.toFixed(2)},${t.gear},${t.wheelOmegas.rl.toFixed(3)},${t.wheelOmegas.rr.toFixed(3)},${t.yawRateRadS.toFixed(4)}`);
      }
      console.log('t,speed,gear,rl,rr,yawRate');
      console.log(rows.join('\n'));
    } finally { sim.destroy(); }
  });
});
