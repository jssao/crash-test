// SPDX-License-Identifier: MIT
//
// Headless sim test for the 'cardetail' WorldFeature (docs/build-log/specs/engine-bay-spec.md).
// Imports the feature module DIRECTLY (skips world/features/registry.ts's import.meta.glob, which is
// a vite-ism) -- per feature.ts's own doc comment recommending this for headless sim tests, and per
// this task's ownership split (new test file, feature module owned by this task, never touches an
// existing test).
//
// No three.js GLTFLoader/DOM is available in this plain-node vitest environment (game/vitest.config.ts
// sets `environment: 'node'`) -- a bare `new THREE.Scene()`/`new THREE.Object3D()` needs neither, and
// materials.ts's CanvasTexture path is DOM-guarded (falls back to flat color), so the feature module
// is fully importable here unmodified.
//
// CRASH SETUP: uses a REAL drive-up (full throttle toward a wall placed well ahead), not
// damage/scenario.ts's crashSetup() teleport-to-speed helper. crashSetup() explicitly sets velocity on
// the chassis/wheels/panels ONLY (see its own doc comment on why panels need this) -- it has no
// knowledge of this feature's 39 extra welded bodies, so using it here would instantly desync their
// velocity from the just-teleported chassis on step 1, reading as a huge (but entirely artificial)
// constraint-force spike and breaking nearly everything before the car ever reaches the wall. A real
// gradual drive-up never has this discontinuity (every welded body is dragged along smoothly the
// whole time, exactly like it would be during ordinary gameplay), so it sidesteps the problem
// entirely rather than needing a fix scoped to a shared file this task doesn't own.
//
// THRESHOLD CALIBRATION NOTE: tuning.ts's BREAKS_EASILY_FORCE_N/TORQUE_NM and the grace-period
// constant in index.ts were calibrated empirically against exactly this drive-up-crash scenario AND a
// separate benign (full-throttle + hard-brake-and-swerve, no crash) run -- see tuning.ts's "TUNING
// DELTA" comment for the measured numbers.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Sim, loadNative } from './harness.mjs';
import { spawnTestWall } from '../src/damage/scenario.ts';
import { FIXED_DT } from '../src/vehicle/tuning.ts';
import createCarDetailFeature from '../src/world/features/cardetail/index.ts';
import { CAR_DETAIL_SPECS } from '../src/world/features/cardetail/tuning.ts';

const ENGINE_BAY_IDS = CAR_DETAIL_SPECS.filter((s) => s.engineBay).map((s) => s.id);
const ID_TO_INDEX = new Map(CAR_DETAIL_SPECS.map((s, i) => [s.id, i]));

const WALL_DISTANCE_M = 60;
const DRIVE_UP_STEPS = 320; // ~5.3s full throttle -- comfortably covers the ~60m to the wall (measured impact ~step 294)
const SETTLE_STEPS = Math.round(4 / FIXED_DT); // 4s post-impact scatter window (verify spec (a))

async function makeFeature(sim) {
	const ctx = {
		world: sim.world,
		scene: new THREE.Scene(),
		getVehicle: () => sim.vehicle,
		carRoot: new THREE.Object3D(),
		quality: { level: 'high', shadowMapSize: 1024, pixelRatioCap: 2, antialias: false, envMapSize: 256 },
	};
	return { ctx, feature: await createCarDetailFeature(ctx) };
}

function assertAllFinite(sim, feature) {
	const t = sim.vehicle.chassis.getTransform();
	for (const v of [t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w]) {
		expect(Number.isFinite(v)).toBe(true);
	}
	for (const d of feature.hooks.displacements()) {
		expect(Number.isFinite(d)).toBe(true);
	}
}

/** Drives full throttle toward a wall placed WALL_DISTANCE_M ahead, then holds zero input for
 * SETTLE_STEPS more fixed steps (the post-impact scatter window). Asserts finiteness throughout. */
function runCrashScenario(sim, feature) {
	spawnTestWall(sim.world, sim.vehicle, WALL_DISTANCE_M);
	for (let i = 0; i < DRIVE_UP_STEPS; i++) {
		sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
		feature.afterFixedStep(FIXED_DT);
		assertAllFinite(sim, feature);
	}
	for (let i = 0; i < SETTLE_STEPS; i++) {
		sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		feature.afterFixedStep(FIXED_DT);
		assertAllFinite(sim, feature);
	}
}

describe('cardetail feature', () => {
	// RECALIBRATED (MUSTANG-65 MODEL-FIRST CULL, orchestrator directive): the spec §5 budget (39/13/8/18)
	// assumed every component was a pure procedural addition. The Mustang model already renders most of
	// the interior (molded into 'body', see the 'seat_rubber' material) and a chunk of the engine
	// bay/drivetrain (EngineBlock/Drivetrain GLB nodes -- carbureted V8, driveshaft+diff, dual exhaust),
	// so tuning.ts's top doc comment culls the whole interior set (model already has it), the
	// forced-induction subsystem + catalytic converter (period-wrong on a naturally-aspirated 1965 car),
	// and marks driveshaft/mufflerTailpipe MODELED_PROXY (model's Drivetrain node already renders them).
	// 27 components remain (10 engine-bay / 0 interior / 17 underbody) -- see tuning.ts's CAR_DETAIL_SPECS.
	it('has 27 components matching the post-cull budget (10 engine-bay / 17 underbody, 0 interior)', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			expect(feature.bodyCount()).toBe(27);
			expect(ENGINE_BAY_IDS.length).toBe(10);
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	it('does NOT false-detach any part during ordinary full-throttle driving (no crash)', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			for (let i = 0; i < 240; i++) {
				sim.step({ throttle: 1, brake: 0, steer: 0, handbrake: false });
				feature.afterFixedStep(FIXED_DT);
				assertAllFinite(sim, feature);
			}
			expect(feature.hooks.detachedCount()).toBe(0);
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	// RECALIBRATED (MUSTANG-65 MODEL-FIRST CULL, "honestly recalibrated" per the orchestrator directive):
	// removing ~138kg of spec mass (the whole culled interior set + the forced-induction/cat-converter
	// items) while keeping TARGET_TOTAL_MASS_KG fixed at 40kg (tuning.ts's mass policy) raises
	// MASS_SCALE for every SURVIVING part by ~38% (40kg now spread over ~368kg of spec mass instead of
	// ~506kg) -- each remaining engine-bay part is proportionally heavier, so for the same crash energy
	// it travels less far in the same 4s window. Measured deterministically (headless sim, no RNG --
	// identical across repeated runs) at this exact scenario: 8/10 engine-bay parts still detach
	// (comfortably clears >=5), but only 3 of those 8 clear the >=1.5m bar in 4s. 3 is the recalibrated,
	// honest floor here -- still proves genuine scatter (not just "the weld let go and it settled 5cm
	// away"), just no longer inflated by parts this cull correctly removed.
	it('hard frontal crash (drive into a wall) detaches >=5 engine-bay parts, scatters >=3 of them >=1.5m within 4s, no NaN', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);

			runCrashScenario(sim, feature);

			const states = feature.hooks.states();
			const displacements = feature.hooks.displacements();

			const detachedEngineBay = ENGINE_BAY_IDS.filter((id) => states[id] !== 'attached');
			const scatteredEnough = detachedEngineBay.filter((id) => displacements[ID_TO_INDEX.get(id)] >= 1.5);

			console.log(
				`[cardetail] engine-bay states=${JSON.stringify(Object.fromEntries(ENGINE_BAY_IDS.map((id) => [id, states[id]])))} ` +
					`detached=${detachedEngineBay.length} scatteredGe1.5m=${scatteredEnough.length}`,
			);

			expect(detachedEngineBay.length).toBeGreaterThanOrEqual(5);
			expect(scatteredEnough.length).toBeGreaterThanOrEqual(3);

			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	it("reset('car') restores every part to attached with ~zero displacement", async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);

			runCrashScenario(sim, feature);
			expect(feature.hooks.detachedCount()).toBeGreaterThan(0);

			sim.reset();
			feature.reset('car');

			expect(feature.bodyCount()).toBe(27);
			expect(feature.hooks.detachedCount()).toBe(0);
			for (const d of feature.hooks.displacements()) {
				expect(d).toBeLessThan(0.05);
			}

			// Step a further second post-reset to confirm nothing NaNs / no dangling-handle traps
			// (feature.ts's warning #1 -- destroyed bodies must never be getTransform()'d).
			for (let i = 0; i < 60; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				feature.afterFixedStep(FIXED_DT);
				assertAllFinite(sim, feature);
			}

			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	it("reset('world') is also idempotent/safe (fires after reset('car') per feature.ts's contract)", async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			runCrashScenario(sim, feature);

			sim.reset();
			feature.reset('car');
			feature.reset('world');

			expect(feature.bodyCount()).toBe(27);
			expect(feature.hooks.detachedCount()).toBe(0);
			for (let i = 0; i < 30; i++) {
				sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
				feature.afterFixedStep(FIXED_DT);
				assertAllFinite(sim, feature);
			}
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});
});
