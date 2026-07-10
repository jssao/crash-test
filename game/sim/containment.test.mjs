// SPDX-License-Identifier: MIT
//
// Headless regression coverage for the world-containment / kicker-beaching / reset-reliability fix
// (containment-fix brief). Three independent concerns, one file since they share the same real-terrain
// world setup:
//   1. The containment BERM (world/terrain/heightfield.ts's bermRise()) actually stops a fast runaway
//      at the +-400m field edge instead of the old infinite-freefall bug (measured pre-fix: 668km/h at
//      y=-3969, game/verify/playtest-r3/diag-topspeed.mjs).
//   2. resetCar()'s underlying mechanism (destroyVehicle()+createVehicle() at the fixed spawn pose,
//      exactly what main.ts's doCarRepair() does) is an ABSOLUTE recovery from ANY starting pose --
//      including a constructed "beached on the kicker ridge" wedge matching diag-gate5.mjs's observed
//      telemetry, a deep freefall, and upside-down.
//   3. A real straight-north full-throttle drive (diag-gate5.mjs's exact repro pattern) through the
//      fixed kicker ramp AND the fixed forest corridor never permanently stalls, across repeated
//      attempts (the codebase's own kicker-jump.test.mjs documents real chaotic sensitivity to tiny
//      numerical differences between runs, so this is checked across several independent attempts,
//      not just one).
//
// (The kill-plane's own auto-trigger wiring -- main.ts's doFixedStep() checking chassis y < -10 --
// lives in a DOM/three.js-driven module that can't be imported into a headless vitest run; that half is
// covered separately by a browser CDP script, game/verify/playtest-r3/verify-safety-net.mjs, which
// exercises the real running game via the new debugForceFreefall() hook. What IS covered headlessly
// here is the thing the kill-plane calls into: the exact same "absolute recovery from any pose"
// mechanism proven in concern 2 above.)

import { describe, expect, it } from 'vitest';
import { init, World } from '../../src/ts/index.ts';
import { createVehicle, destroyVehicle, stepVehicle, getTelemetry } from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M } from '../src/vehicle/tuning.ts';
import { quatFromAxisAngle, LOCAL_RIGHT, dot, rotateVector, LOCAL_UP } from '../src/vehicle/mathUtil.ts';
import { createTerrainGroundBody } from '../src/world/terrain/terrainBody.ts';
import { TERRAIN_HALF_M, BERM_WIDTH_M, BERM_HEIGHT_M } from '../src/world/terrain/heightfield.ts';
import { createDestructibleWorld } from '../src/world/bodies.ts';
import { createTreesWorld, stepTreesWorld } from '../src/world/features/trees/bodies.ts';

let cachedNative = null;
async function loadNative() {
	if (cachedNative === null) cachedNative = init();
	return cachedNative;
}

function upDot(rotation) {
	return dot(rotateVector(rotation, LOCAL_UP), { x: 0, y: 1, z: 0 });
}

/** Mirrors main.ts's doCarRepair() core (minus the THREE/HUD/damage-system bits, which don't exist
 * headlessly) -- the SAME destroyVehicle()+createVehicle() absolute teleport, plus the same explicit
 * zero-velocity/awake hardening. Returns the fresh vehicle. */
function hardReset(world, oldVehicle, spawnPos, spawnRot) {
	destroyVehicle(oldVehicle);
	const vehicle = createVehicle(world, spawnPos, spawnRot);
	vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: 0 });
	vehicle.chassis.setAngularVelocity({ x: 0, y: 0, z: 0 });
	vehicle.chassis.setAwake(true);
	for (const w of Object.values(vehicle.wheels)) {
		w.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		w.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		w.body.setAwake(true);
	}
	return vehicle;
}

describe('containment: berm stops a world-edge runaway', () => {
	it('a 200km/h straight-north run into the +-400m field edge never falls through and never exits the field', async () => {
		const native = await loadNative();
		const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		try {
			createTerrainGroundBody(world);
			// Deep in the meadow (past the forest ring, ~50m short of the edge), already moving fast --
			// same teleport+velocity technique as damage/scenario.ts's crashSetup(). Bypasses ~350m of
			// acceleration driving so the test is fast; the physical question (does the ground shape
			// contain a fast body) doesn't depend on how it got up to speed.
			const spawnPos = { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: TERRAIN_HALF_M - 50 };
			let vehicle = createVehicle(world, spawnPos);
			const speedMs = 200 / 3.6;
			vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: speedMs });
			for (const w of Object.values(vehicle.wheels)) w.body.setLinearVelocity({ x: 0, y: 0, z: speedMs });

			let minY = Infinity;
			let maxZ = -Infinity;
			let anyNaN = false;
			const STEPS = 360; // 6s @ 60Hz -- comfortably enough to reach and climb the berm from 50m out
			for (let i = 0; i < STEPS; i++) {
				stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
				world.step(FIXED_DT, FIXED_SUBSTEPS);
				const p = vehicle.chassis.getPosition();
				const v = vehicle.chassis.getLinearVelocity();
				if (!Number.isFinite(p.y) || !Number.isFinite(v.z)) anyNaN = true;
				minY = Math.min(minY, p.y);
				maxZ = Math.max(maxZ, p.z);
			}
			const finalPos = vehicle.chassis.getPosition();
			const finalSpeedKmh = Math.hypot(...Object.values(vehicle.chassis.getLinearVelocity())) * 3.6;
			console.log(
				`[containment] minY=${minY.toFixed(2)} maxZ=${maxZ.toFixed(2)} finalPos=${JSON.stringify(finalPos)} finalSpeedKmh=${finalSpeedKmh.toFixed(1)} fieldEdge=${TERRAIN_HALF_M} bermWidth=${BERM_WIDTH_M.toFixed(2)} bermHeight=${BERM_HEIGHT_M}`,
			);

			expect(anyNaN).toBe(false);
			// The old bug: y=-3969 (freefall through a nonexistent floor past the edge). -10 is the
			// kill-plane's own threshold -- proving the berm alone (no kill-plane involved in this test)
			// keeps the car nowhere near it.
			expect(minY).toBeGreaterThan(-5);
			// Never actually exits the field's physical extent.
			expect(maxZ).toBeLessThan(TERRAIN_HALF_M);
			// The berm's steep climb bleeds most of the entry speed -- a car that sailed over/through it
			// unimpeded would still be near 200km/h; one genuinely stopped by a ~70deg berm is not.
			expect(finalSpeedKmh).toBeLessThan(100);

			destroyVehicle(vehicle);
		} finally {
			world.destroy();
		}
	});
});

describe('containment: reset is an absolute recovery from any pose', () => {
	const spawnPos = { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 };
	const spawnRot = { x: 0, y: 0, z: 0, w: 1 };

	const wedgeCases = [
		{
			name: 'beached on the kicker ridge (diag-gate5.mjs signature: nose-down, near-zero speed, z~46.8)',
			apply(vehicle) {
				// Matches the observed diag-gate5.mjs telemetry: frozen at z~46.8-46.9, pitched, resting on
				// the ramp ridge rather than the flat ground -- constructed directly (not re-driven into the
				// ramp) so this case is immune to whether the ramp fix still happens to be reproducible.
				const pitch = quatFromAxisAngle(LOCAL_RIGHT, (18 * Math.PI) / 180);
				vehicle.chassis.setTransform({ x: 0, y: 1.2, z: 46.85 }, pitch);
				vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: 0 });
				vehicle.chassis.setAwake(true);
			},
		},
		{
			name: 'deep freefall (pre-berm-fix signature: y=-3969, still falling fast)',
			apply(vehicle) {
				vehicle.chassis.setTransform({ x: 241, y: -3969, z: 1357 }, { x: 0, y: 0, z: 0, w: 1 });
				vehicle.chassis.setLinearVelocity({ x: 12, y: -180, z: 8 });
				vehicle.chassis.setAwake(true);
			},
		},
		{
			name: 'upside down and stationary',
			apply(vehicle) {
				const flip = quatFromAxisAngle(LOCAL_RIGHT, Math.PI);
				vehicle.chassis.setTransform({ x: -5, y: 0.6, z: 90 }, flip);
				vehicle.chassis.setLinearVelocity({ x: 0, y: 0, z: 0 });
				vehicle.chassis.setAwake(true);
			},
		},
	];

	for (const wedgeCase of wedgeCases) {
		it(`recovers to spawn pose, settled, and drivable from: ${wedgeCase.name}`, async () => {
			const native = await loadNative();
			const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
			try {
				createTerrainGroundBody(world);
				let vehicle = createVehicle(world, spawnPos, spawnRot);

				// Force the wedged/fallen pose, let a few steps pass exactly as the live game would between
				// the hazard occurring and the player hitting R (or the kill-plane firing).
				wedgeCase.apply(vehicle);
				for (let i = 0; i < 5; i++) {
					stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
					world.step(FIXED_DT, FIXED_SUBSTEPS);
				}

				// The R / kill-plane recovery itself.
				vehicle = hardReset(world, vehicle, spawnPos, spawnRot);

				// Immediately-after-reset assertions (no settle steps yet): exact spawn pose, zero velocity.
				const rp = vehicle.chassis.getPosition();
				const rv = vehicle.chassis.getLinearVelocity();
				const rw = vehicle.chassis.getAngularVelocity();
				expect(rp.x).toBeCloseTo(spawnPos.x, 6);
				expect(rp.y).toBeCloseTo(spawnPos.y, 6);
				expect(rp.z).toBeCloseTo(spawnPos.z, 6);
				expect(Math.hypot(rv.x, rv.y, rv.z)).toBeLessThan(1e-6);
				expect(Math.hypot(rw.x, rw.y, rw.z)).toBeLessThan(1e-6);
				expect(upDot(vehicle.chassis.getRotation())).toBeCloseTo(1, 6);

				// Settle, then confirm drivable: full throttle moves it a real distance in a straight line.
				for (let i = 0; i < 30; i++) {
					stepVehicle(vehicle, { throttle: 0, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
					world.step(FIXED_DT, FIXED_SUBSTEPS);
				}
				const settledUpDot = upDot(vehicle.chassis.getRotation());
				const grounded = Object.values(vehicle.wheelGrounded).every(Boolean);

				const posBefore = vehicle.chassis.getPosition();
				for (let i = 0; i < 180; i++) {
					stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
					world.step(FIXED_DT, FIXED_SUBSTEPS);
				}
				const posAfter = vehicle.chassis.getPosition();
				const driveDisp = Math.hypot(posAfter.x - posBefore.x, posAfter.z - posBefore.z);
				console.log(`[reset:${wedgeCase.name}] settledUpDot=${settledUpDot.toFixed(3)} grounded=${grounded} driveDisp=${driveDisp.toFixed(2)}m`);

				expect(settledUpDot).toBeGreaterThan(0.99);
				expect(grounded).toBe(true);
				expect(driveDisp).toBeGreaterThan(10);

				destroyVehicle(vehicle);
			} finally {
				world.destroy();
			}
		});
	}
});

describe('containment: straight-north full-throttle drive no longer beaches or snags', () => {
	// SCOPE NOTE + FIX HISTORY (see world/tuning.ts's KICKER_ANGLE_DEG doc comment for the full,
	// measured writeup): the shipped fix gentles the kicker's up-face from 30deg to 25deg (a "flat
	// deck before the drop" attempt measured WORSE -- 3/10 -> 6/10 real-browser permanent stalls -- and
	// a same-angle "roof" down-slope measured no better AND broke asymmetric-launch.test.mjs's
	// free-flight assumption). A genuinely blind full-throttle, zero-correction drive still has a
	// narrow (~1 in 20 finely-swept steer values), PRE-EXISTING chaotic-rollover band where the car
	// flips onto its roof/side after the jump and stays there -- confirmed present (same rough rate) in
	// BOTH the original 30deg ramp and the shipped 25deg one (this is the same documented vehicle-
	// dynamics sensitivity kicker-jump.test.mjs already characterizes, not a ramp-collision defect). A
	// rolled car is a legitimate crash outcome the player recovers from via R (proven absolute in the
	// 'reset is an absolute recovery' block above), same as any other crash in this sandbox -- it is NOT
	// the reported defect. What IS the reported defect, and what this test asserts against, is
	// "beaching": the car stuck immobile AT/NEAR the ramp or the corridor snag while still UPRIGHT
	// (up>0.5) -- wedged by the geometry itself, not crashed. Also note headless box3d-js is fully
	// deterministic given identical inputs (verified: 20 repeated resetCar()+drive cycles in one
	// persistent world land byte-identical every time) -- the browser-measured "~1/3" stall rate
	// (diag-gate5.mjs, real Brave/V8 WASM) reflects a cross-engine float/JIT difference this headless
	// suite cannot reproduce (headless never stalled at ANY tested geometry); the real fix validation
	// was done directly against the built game (repeated diag-gate5.mjs + a long-wait no-recovery
	// probe), and this headless sweep is a fast regression net on top of that, not a replacement for it.
	it('a fine sweep of small steer offsets never leaves the car beached (upright + immobile) at the kicker or the old corridor snag', async () => {
		const native = await loadNative();
		const STEPS = 1000; // comfortably covers the kicker, the old corridor snag (z~155), and well into the loop
		const STEER_VALUES = Array.from({ length: 21 }, (_, i) => (i - 10) * 0.003); // -0.03 .. +0.03

		const beached = [];
		const rolled = [];
		const clean = [];
		for (const steer of STEER_VALUES) {
			const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
			try {
				createTerrainGroundBody(world);
				createDestructibleWorld(world); // real ramps, including the fixed (gentler-angle) kicker
				const trees = createTreesWorld(world); // real forest, including the fixed north corridor
				const vehicle = createVehicle(world);

				for (let i = 0; i < STEPS; i++) {
					stepVehicle(vehicle, { throttle: 1, brake: 0, steer, handbrake: false }, FIXED_DT);
					world.step(FIXED_DT, FIXED_SUBSTEPS);
					stepTreesWorld(trees);
				}
				const t = getTelemetry(vehicle);
				const row = { steer, z: +t.chassisPos.z.toFixed(2), speed: +t.speedKmh.toFixed(2), up: +t.upDot.toFixed(3) };
				const nearKickerOrSnag = (row.z >= 38 && row.z <= 53) || (row.z > 145 && row.z < 165);
				if (nearKickerOrSnag && row.speed < 3 && row.up > 0.5) beached.push(row);
				else if (row.up <= 0.5) rolled.push(row);
				else clean.push(row);

				destroyVehicle(vehicle);
			} finally {
				world.destroy();
			}
		}
		console.log(
			`[straight-north sweep, ${STEPS} steps, ${STEER_VALUES.length} steer values] beached=${JSON.stringify(beached)} rolled(pre-existing, out of scope)=${JSON.stringify(rolled)} clean=${clean.length}`,
		);
		expect(beached).toEqual([]);
	});
});
