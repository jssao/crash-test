// SPDX-License-Identifier: MIT — DIAG: step-level rearLeft state through the 70km/h crash.
import { describe, expect, it } from 'vitest';
import { createSim } from '../harness.mjs';
import { spawnTestWall, crashSetup } from '../../src/damage/scenario.ts';
import { createOccupant, createSeatPan, matchOccupantVelocity, matchSeatPanVelocity, pollOccupantRestraint, teardownOccupant, teardownSeatPan } from '../../src/world/features/occupants/physics.ts';
import { createOccupantRuntime, resetOccupantAccelBaseline, updateOccupantActive } from '../../src/world/features/occupants/active.ts';
import { SEAT_KEYS } from '../../src/world/features/occupants/tuning.ts';
const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };
function activeCtx(sim) { const t = sim.vehicle.chassis.getTransform(); return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: sim.vehicle.chassis.getLinearVelocity(), world: sim.world }; }
function conj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w }; }
function rot(q, v) { const { x, y, z, w } = q; const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
  return { x: v.x + w * tx + y * tz - z * ty, y: v.y + w * ty + z * tx - x * tz, z: v.z + w * tz + x * ty - y * tx }; }
function toLocal(p, ctx) { return rot(conj(ctx.chassisRot), { x: p.x - ctx.chassisPos.x, y: p.y - ctx.chassisPos.y, z: p.z - ctx.chassisPos.z }); }
describe('DIAG eject detail', () => {
  it('logs rearLeft steps 55-100', async () => {
    const sim = await createSim();
    try {
      const c = sim.vehicle.chassis; const t0 = c.getTransform();
      const pans = [], occ = [], rt = [];
      SEAT_KEYS.forEach((k, i) => { pans.push(createSeatPan(sim.world, c, k, t0.position, t0.rotation)); occ.push(createOccupant(sim.world, c, i, k, t0.position, t0.rotation)); rt.push(createOccupantRuntime()); });
      for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
      const wall = spawnTestWall(sim.world, sim.vehicle, 22);
      crashSetup(sim.vehicle, 70);
      const v = c.getLinearVelocity();
      occ.forEach((o, i) => { matchOccupantVelocity(o, v); resetOccupantAccelBaseline(o, rt[i]); });
      for (const p of pans) matchSeatPanVelocity(p, v);
      const lines = [];
      for (let step = 0; step < 150; step++) {
        sim.step(NEUTRAL);
        const ctx = activeCtx(sim);
        occ.forEach((o, i) => {
          pollOccupantRestraint(o);
          updateOccupantActive(o, rt[i], 1 / 60, ctx);
          if (i === 2 && step >= 55 && step <= 100) {
            const lh = toLocal(occ[2].parts.head.body.getPosition(), ctx);
            const lt = toLocal(occ[2].parts.torso.body.getPosition(), ctx);
            lines.push(`s${step} ej=${o.ejected ? 1 : 0} alive=${rt[2].alive ? 1 : 0} peakG=${rt[2].peakAccelG.toFixed(0)} headL=(${lh.x.toFixed(2)},${lh.y.toFixed(2)},${lh.z.toFixed(2)}) torsoL=(${lt.x.toFixed(2)},${lt.y.toFixed(2)},${lt.z.toFixed(2)})`);
          }
        });
      }
      console.log('[detail]\n' + lines.join('\n'));
      wall.destroy(); for (const o of occ) teardownOccupant(o); for (const p of pans) teardownSeatPan(p);
      expect(true).toBe(true);
    } finally { sim.destroy(); }
  });
}, 60000);
