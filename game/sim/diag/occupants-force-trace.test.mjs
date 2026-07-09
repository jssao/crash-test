// SPDX-License-Identifier: MIT — DIAG: restraint force run-length structure with ejection disabled.
import { describe, expect, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { spawnTestWall, crashSetup } from '../../src/damage/scenario.ts';
import { createOccupant, createSeatPan, matchOccupantVelocity, matchSeatPanVelocity, pollOccupantRestraint, teardownOccupant, teardownSeatPan } from '../../src/world/features/occupants/physics.ts';
import { createOccupantRuntime, resetOccupantAccelBaseline, updateOccupantActive } from '../../src/world/features/occupants/active.ts';
import { SEAT_KEYS } from '../../src/world/features/occupants/tuning.ts';
const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };
function activeCtx(sim) { const t = sim.vehicle.chassis.getTransform(); return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: sim.vehicle.chassis.getLinearVelocity(), world: sim.world }; }
function seatAll(sim) { const c = sim.vehicle.chassis; const t = c.getTransform(); const pans = [], occ = [], rt = [];
  SEAT_KEYS.forEach((k, i) => { pans.push(createSeatPan(sim.world, c, k, t.position, t.rotation)); occ.push(createOccupant(sim.world, c, i, k, t.position, t.rotation)); rt.push(createOccupantRuntime()); }); return { pans, occ, rt }; }
describe('DIAG force runs', () => {
  async function trace(speedKmh, wallDist) {
    const sim = await createSim();
    try {
      const rig = seatAll(sim);
      for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
      const wall = spawnTestWall(sim.world, sim.vehicle, wallDist);
      crashSetup(sim.vehicle, speedKmh);
      const v = sim.vehicle.chassis.getLinearVelocity();
      rig.occ.forEach((o, i) => { o.restraintThresholdN = Infinity; matchOccupantVelocity(o, v); resetOccupantAccelBaseline(o, rig.rt[i]); });
      for (const p of rig.pans) matchSeatPanVelocity(p, v);
      const REAL = [16000, 16000, 5300, 5300];
      // per occupant: histogram of consecutive-run lengths above REAL threshold; and max windowed-min over k=2..4
      const runs = [[], [], [], []]; const cur = [0, 0, 0, 0];
      for (let step = 0; step < 300; step++) {
        sim.step(NEUTRAL);
        const ctx = activeCtx(sim);
        rig.occ.forEach((o, i) => {
          const f = o.restraintJoint.getConstraintForce();
          const m = Math.hypot(f.x, f.y, f.z);
          if (m > REAL[i]) cur[i]++; else { if (cur[i] > 0) runs[i].push(cur[i]); cur[i] = 0; }
          pollOccupantRestraint(o);
          updateOccupantActive(o, rig.rt[i], 1 / 60, ctx);
        });
      }
      rig.occ.forEach((_, i) => { if (cur[i] > 0) runs[i].push(cur[i]); });
      console.log(`[runs ${speedKmh}km/h] ${SEAT_KEYS.map((k, i) => `${k}:${JSON.stringify(runs[i])}`).join(' ')}`);
      wall.destroy();
      for (const o of rig.occ) teardownOccupant(o); for (const p of rig.pans) teardownSeatPan(p);
    } finally { sim.destroy(); }
  }
  it('30', async () => { await trace(30, 18); expect(true).toBe(true); });
  it('50', async () => { await trace(50, 18); expect(true).toBe(true); });
  it('70', async () => { await trace(70, 22); expect(true).toBe(true); });
}, 60000);
