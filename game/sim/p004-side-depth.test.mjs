// SPDX-License-Identifier: MIT
//
// P004: "side crashes produce not nearly enough damage." RUN 5's lateral structural field derives its
// cave depth from the crumple registry's raw offsets, which for a side-MDB run are ALSO attenuated by
// the mass-aware damage factor (a ~half-mass trolley deposits only ~e of a rigid wall's dent), so the
// rendered flank barely changed vs the reference's deep door/B-pillar intrusion. The fix amplifies the
// lateral VISUAL field (structuralCrush.ts LATERAL_DEPTH_AMPLIFY + raised DOOR_CAVE_MAX_M / roof-drop)
// so the struck flank + door skin cave to a plausible depth. Target defended from
// screenshots/P004_side-impact-damage/reference/ (car-to-car T-bone + 75 km/h pole side impact both show
// ~0.3m of door/B-pillar intrusion). Runs a real side-50 crash and measures the built field.
import { describe, expect, it } from 'vitest';
import { buildGridPlane, registerDeformable } from '../src/damage/crumple.ts';
import { registerDeformable as registerWithSystem } from '../src/damage/system.ts';
import { createStructuralCrushState, updateStructuralCrush, structuralFieldFor, lateralInputsFromRegistry } from '../src/scene/structuralCrush.ts';
import { createCrashRealismSim } from './crash-realism-harness.mjs';

describe('P004: a side-MDB-50 crash caves the struck flank + door skin to a plausible depth', () => {
  it('struck (+x) flank + door cave clearly inward; intact (-x) flank reads exactly zero', async () => {
    const sim = await createCrashRealismSim();
    try {
      // A chassis flank/sill proxy spanning the cabin z-region (what the real browser GLB shell provides)
      // registered with the damage system so the crash's crumple deposits onto it.
      const flank = buildGridPlane({ center: { x: 0, y: 0.35, z: 0 }, halfU: 0.95, halfV: 0.85, axisU: 'x', axisV: 'z', segsU: 12, segsV: 10 });
      const flankHandle = registerWithSystem(sim.damage, 'chassis-flank', 'chassis', 'chassis', flank.positions, flank.indices);
      // Door panel proxies (geometry only) for building/measuring the door cave field.
      const dL = buildGridPlane({ center: { x: 0, y: 0, z: 0 }, halfU: 0.5, halfV: 0.6, axisU: 'y', axisV: 'z', segsU: 6, segsV: 6 });
      const dR = buildGridPlane({ center: { x: 0, y: 0, z: 0 }, halfU: 0.5, halfV: 0.6, axisU: 'y', axisV: 'z', segsU: 6, segsV: 6 });
      const doorLH = registerDeformable('panel-doorL', 'panel', 'doorL', dL.positions, dL.indices);
      const doorRH = registerDeformable('panel-doorR', 'panel', 'doorR', dR.positions, dR.indices);

      sim.spawnSideWall(1.05); // side-mdb-50 proxy
      sim.crashSideways(50);
      sim.settle(300);

      const { sidePos, sideNeg } = lateralInputsFromRegistry([flankHandle]);
      const state = createStructuralCrushState([flankHandle, doorLH, doorRH]);
      updateStructuralCrush(state, { frontCrushM: 0, rearCrushM: 0, frontPosM: 0, frontNegM: 0, sidePos, sideNeg });

      const flankField = structuralFieldFor(state, flankHandle);
      let structDepth = 0; // max inward (-x) cave on the struck (+x) flank
      let intactMax = 0; // any displacement on the intact (-x) flank -- must be exactly 0
      for (let i = 0; i < flankHandle.vertexCount; i++) {
        const bx = flankHandle.basePositions[i * 3];
        const ox = flankField.offsets[i * 3];
        if (bx > 0.3) structDepth = Math.max(structDepth, -ox);
        if (bx < -0.3) intactMax = Math.max(intactMax, Math.abs(ox), Math.abs(flankField.offsets[i * 3 + 1]), Math.abs(flankField.offsets[i * 3 + 2]));
      }
      const doorLField = structuralFieldFor(state, doorLH);
      let doorLCave = 0;
      for (let i = 0; i < doorLH.vertexCount; i++) doorLCave = Math.max(doorLCave, -doorLField.offsets[i * 3]);

      console.log(`[P004] rawDepthM=${sidePos.depthM.toFixed(3)} structDepth=${structDepth.toFixed(3)} doorLCave=${doorLCave.toFixed(3)} intactMax=${intactMax}`);

      // DEFENDED TARGET: the struck flank caves >=0.25m and the struck door skin caves >=0.25m inward --
      // a clearly-visible intrusion matching the reference's ~0.3m door/B-pillar caving (pre-fix these
      // read roughly half as deep, barely changing the top-view silhouette).
      expect(structDepth).toBeGreaterThanOrEqual(0.25);
      expect(doorLCave).toBeGreaterThanOrEqual(0.25);
      // The struck door on the intact flank never engages, and the intact flank stays exactly pristine.
      expect(structuralFieldFor(state, doorRH).active).toBe(false);
      expect(intactMax).toBe(0);
      expect(sideNeg.depthM).toBe(0);
    } finally {
      sim.destroy();
    }
  }, 30000);
});
