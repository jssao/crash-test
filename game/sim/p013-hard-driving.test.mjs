// SPDX-License-Identifier: MIT
//
// P013 (Critical) regression: "the car deforms + bounces back during regular driving; deformation is
// zone-confined." Root causes fixed:
//   (a) the visual crush field was fed the segments' raw CURRENT (elastic) displacement, so hard
//       braking/cornering/suspension loads visibly dented the shell then relaxed -- now the field reads
//       the PLASTIC-only crush (segments.ts frontCrushPlasticM / rearCrushPlasticM);
//   (b) the crumple pipeline lacked the ground-normal exclusion, so curb/undercarriage scrapes
//       permanently dented the mesh (system.ts now filters upward-pushing ground contacts);
//   (c) the OWN-displacement segment ratchet false-triggered on sustained terrain/curb contact
//       (segments.ts: longer debounce + a strong-impact corroboration latch).
// This drives a HARD-DRIVING battery (full-throttle launch, hard brake+steer, handbrake yanks) on flat
// ground with NO obstacles for ~600 steps and asserts: zero permanent segment crush, zero plastic
// visual-crush, zero panel loosen/break, zero wheel detach, and zero cosmetic dents.
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';

describe('P013: hard-driving battery leaves the car mechanically + cosmetically pristine', () => {
  it('~600 steps of aggressive driving cause zero permanent deformation, damage, or wheel loss', async () => {
    const sim = await createDamageSim();
    try {
      const phases = [
        { throttle: 1, brake: 0, steer: 0, handbrake: false }, // full-throttle launch
        { throttle: 1, brake: 0, steer: 0.6, handbrake: false }, // hard corner right at speed
        { throttle: 0, brake: 1, steer: -0.6, handbrake: false }, // hard brake + full steer left
        { throttle: 1, brake: 0, steer: -0.5, handbrake: false }, // accelerate hard, other lock
        { throttle: 0.5, brake: 0, steer: 0.9, handbrake: true }, // handbrake yank
        { throttle: 1, brake: 0, steer: 0, handbrake: false }, // full throttle again
        { throttle: 0, brake: 1, steer: 0, handbrake: false }, // hard brake to a stop
      ];
      const perPhase = 90; // ~630 steps total @ 60Hz
      let peakPlasticFront = 0;
      let peakPlasticRear = 0;
      for (const phase of phases) {
        for (let i = 0; i < perPhase; i++) {
          sim.step(phase);
          const seg = sim.damageTelemetry().segments;
          peakPlasticFront = Math.max(peakPlasticFront, seg.frontCrushPlasticM);
          peakPlasticRear = Math.max(peakPlasticRear, seg.rearCrushPlasticM);
        }
      }

      const dt = sim.damageTelemetry();
      const seg = dt.segments;
      console.log(
        `[P013 hard-drive] peakPlasticFront=${peakPlasticFront.toFixed(4)} peakPlasticRear=${peakPlasticRear.toFixed(4)} ` +
          `frontCrushM=${seg.frontCrushM.toFixed(4)} weldCrush=${JSON.stringify(Object.fromEntries(Object.entries(seg.weldCrushM).map(([k, v]) => [k, +v.toFixed(3)])))} ` +
          `panels=${JSON.stringify(dt.panelStates)} wheels=${JSON.stringify(dt.wheelStates)} dented=${dt.dentedVertexCount}`,
      );

      // (a)/(c): zero PERMANENT segment crush -- the visual field (plastic values) stays exactly 0, and
      // every weld's ratcheted crush is 0. This is the "no dent-then-bounce during driving" guarantee.
      expect(peakPlasticFront).toBe(0);
      expect(peakPlasticRear).toBe(0);
      expect(seg.frontCrushPlasticM).toBe(0);
      expect(seg.rearCrushPlasticM).toBe(0);
      for (const v of Object.values(seg.weldCrushM)) expect(v).toBe(0);
      expect(seg.coreRetreatM.front).toBe(0);
      expect(seg.coreRetreatM.rear).toBe(0);
      expect(seg.tornWelds).toEqual([]);

      // No panel loosened/broke, no wheel detached.
      for (const s of Object.values(dt.panelStates)) expect(s).toBe('attached');
      for (const s of Object.values(dt.wheelStates)) expect(s).toBe('attached');

      // (b): no cosmetic dents from ordinary driving (ground/curb contacts filtered out of crumple).
      expect(dt.dentedVertexCount).toBe(0);

      // No NaNs.
      const t = sim.vehicle.chassis.getTransform();
      for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    } finally {
      sim.destroy();
    }
  }, 30000);
});
