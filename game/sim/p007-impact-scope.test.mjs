// SPDX-License-Identifier: MIT
//
// P007: "side impact drops the trunk; front impact dislodges doors." Fixes verified here:
//   - the TRUNK stays intact in a squarely-lateral side impact (the tight per-panel trunk stress radius,
//     damage-tuning.ts STRESS_RADIUS_M_BY_PANEL, keeps a door-region flank hit from reaching the trunk
//     centroid at chassis-local z=-2.13);
//   - a FRONTAL crash up to 100 km/h leaves every door AND the trunk attached (no frontal door dislodge
//     at ordinary speeds; the extreme-tier 161 km/h door-SPRUNG behaviour is intentionally preserved and
//     guarded by extreme-tier.test.mjs, not here).
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';
import { createCrashRealismSim } from './crash-realism-harness.mjs';

describe('P007: a frontal crash never dislodges the doors or trunk', () => {
  it('100 km/h frontal: all 4 doors + trunk stay attached', async () => {
    const sim = await createDamageSim();
    try {
      sim.spawnWall(12);
      sim.crash(100);
      for (let i = 0; i < 420; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
      const dt = sim.damageTelemetry();
      console.log(`[P007 frontal100] states=${JSON.stringify(dt.panelStates)} trunkStress=${dt.stressLevels.trunk.toFixed(1)}`);
      for (const key of ['doorL', 'doorR', 'doorRL', 'doorRR', 'trunk']) {
        expect(dt.panelStates[key]).toBe('attached');
      }
    } finally {
      sim.destroy();
    }
  }, 30000);
});

describe('P007: a lateral side impact never drops the trunk', () => {
  it('side-mdb-50 style: trunk stays attached with negligible stress; a struck-side door is damaged', async () => {
    const sim = await createCrashRealismSim();
    try {
      sim.spawnSideWall(1.05); // door-centred barrier at the +X flank (side-mdb-50 proxy)
      sim.crashSideways(50);
      sim.settle(300);
      const dt = sim.damageTelemetry();
      console.log(`[P007 side50] states=${JSON.stringify(dt.panelStates)} trunkStress=${dt.stressLevels.trunk.toFixed(1)}`);
      // The trunk (rear panel) must not be dropped or even damaged by a purely lateral door-region hit.
      expect(dt.panelStates.trunk).toBe('attached');
      // Real damage still lands on the struck flank (this is not a silent no-op) -- at least one door
      // loosened/sprung/broken.
      const struckDoorsTouched = ['doorL', 'doorRL'].filter((k) => dt.panelStates[k] !== 'attached');
      expect(struckDoorsTouched.length).toBeGreaterThanOrEqual(1);
    } finally {
      sim.destroy();
    }
  }, 30000);

  it('side-130 (violent T-bone): the trunk still stays attached', async () => {
    const sim = await createCrashRealismSim();
    try {
      sim.spawnSideWall(1.1);
      sim.crashSideways(130);
      sim.settle(300);
      const dt = sim.damageTelemetry();
      console.log(`[P007 side130] states=${JSON.stringify(dt.panelStates)} trunkStress=${dt.stressLevels.trunk.toFixed(1)}`);
      // Even a door-tearing 130 km/h side impact must not reach the trunk (pre-fix it loosened it).
      expect(dt.panelStates.trunk).toBe('attached');
    } finally {
      sim.destroy();
    }
  }, 30000);
});
