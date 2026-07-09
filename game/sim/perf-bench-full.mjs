// SPDX-License-Identifier: MIT
//
// FULL-WORLD headless perf bench (PLAN-2.md item 11 spec: "physics step avg < 8ms in the worst-case
// scene mid-crash"). Extends perf-bench.mjs's staged worst-case measurement to the COMPLETE world:
// 131 legacy destructibles (world/bodies.ts) + all 4 WorldFeatures -- cardetail (39 welded car parts),
// occupants (4 seat pans + 4x11 ragdoll parts = 48), trees (~40: saplings/mids/larges across the near
// + far sites), buildings (~216: shed/house-corner/brick-wall/fences) -- roughly 520 physics bodies
// total, matching the object being gated.
//
// Each feature's physics-only module is imported DIRECTLY (skip world/features/registry.ts's
// import.meta.glob, a vite-ism -- exactly the convention game/sim/features-*.test.mjs already uses).
// cardetail has no separate bodies.ts (its physics lives inline in index.ts), so it's instantiated via
// the real WorldFeatureFactory against a minimal fake ctx (THREE.Scene()/Object3D() need no DOM --
// same trick features-cardetail.test.mjs uses), reading its bodies back via the read-only
// hooks.bodies() diagnostic added alongside this bench (index.ts's hooks object, additive-only, no
// behavior change -- see that file's comment).
//
// THREE STAGES:
//   (i)   IDLE (5s, zero input, fresh spawn) -- reports awake-body count over time. Destructibles/
//         trees/buildings spawn create-then-ASLEEP (0 contribution once settled); cardetail spawns
//         AWAKE (rigidly welded to the chassis, settles+sleeps); occupants spawn AWAKE and settle
//         under their own restraint spring, then sleep -- see each feature's own module doc comment.
//   (ii)  CHAOS -- force EVERY dynamic body in the world awake (perf-bench.mjs's own "defeat the sleep
//         optimization on purpose, so this measures the genuine worst case" convention, extended here
//         to every feature), then a REAL gradual full-throttle drive-up into the brick-wall structure
//         (same "real drive, not an instant-velocity teleport" approach as features-cardetail.test.mjs
//         uses and documents -- an instant teleport desyncs the welded cardetail parts' velocity from
//         the chassis on step 1 and spuriously shatters all 39 before the car ever reaches the wall).
//         Every OTHER structure/tree/destructible is simultaneously awake (contact-solved even where
//         not directly hit) for the whole window -- this is the "worst-case scene mid-crash" the gate
//         is about. Reports world.step() wall time avg/p95/max over this window.
//   (iii) SETTLE -- continues stepping at zero input, polling awake count each step, until it returns
//         near zero (or a generous step cap is hit) -- reports how long re-settling took.
//
// REQUIRED (gate): CHAOS-window avg < 8ms. Run via `npm run bench:full`.
//
// Usage:
//   npm run bench:full                  -- uses vehicle/tuning.ts's exported FIXED_SUBSTEPS
//   npm run bench:full -- --substeps=8  -- override (exploration only, see perf-bench.mjs's doc on
//                                          why this is a per-call arg rather than an edit to tuning.ts)

import * as THREE from 'three';
import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../src/world/bodies.ts';
import { createTreesWorld, stepTreesWorld, treesBodyCount } from '../src/world/features/trees/bodies.ts';
import { buildAllStructures, pollStructureBreaks, totalPieceCount } from '../src/world/features/buildings/structures.ts';
import { BRICK_WALL_CENTER } from '../src/world/features/buildings/tuning.ts';
import createCarDetailFeature from '../src/world/features/cardetail/index.ts';
import {
	createOccupant,
	createSeatPan,
	pollOccupantRestraint,
} from '../src/world/features/occupants/physics.ts';
import { SEAT_KEYS } from '../src/world/features/occupants/tuning.ts';

const argSubsteps = process.argv.find((a) => a.startsWith('--substeps='));
const substeps = argSubsteps ? Number(argSubsteps.split('=')[1]) : FIXED_SUBSTEPS;

const IDLE_STEPS = 300; // 5s @ 60Hz
const CHAOS_DRIVE_STEPS = 320; // ~5.3s full-throttle drive-up (mirrors features-cardetail.test.mjs's own calibrated distance/timing)
const CHAOS_AFTERMATH_STEPS = 180; // 3s zero-input immediately after -- captures the impact + immediate scatter, still part of the "mid-crash" window
const SETTLE_CAP_STEPS = 1200; // 20s hard cap so a pathological "never fully sleeps" case can't hang the bench forever
const WALL_RUNWAY_M = 60; // spawn this far south of the brick wall, driving +Z (same order as features-cardetail.test.mjs's WALL_DISTANCE_M)

function percentile(sortedMs, p) {
	return sortedMs[Math.min(sortedMs.length - 1, Math.ceil(sortedMs.length * p) - 1)];
}

function stats(msArray) {
	const sorted = [...msArray].sort((a, b) => a - b);
	const avg = msArray.reduce((s, v) => s + v, 0) / msArray.length;
	return { avg, p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] };
}

async function main() {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world, 250);
	const vehicle = createVehicle(world, { x: BRICK_WALL_CENTER.x, y: CHASSIS_ORIGIN_HEIGHT_M, z: BRICK_WALL_CENTER.z - WALL_RUNWAY_M });

	// ---- Legacy destructibles (131 dynamic bodies, spawn asleep) ----
	const destructibles = createDestructibleWorld(world);

	// ---- trees (spawn asleep) ----
	const trees = createTreesWorld(world);

	// ---- buildings (spawn asleep) ----
	const structures = buildAllStructures(world);

	// ---- cardetail (spawns AWAKE, welded to chassis) -- instantiate via the real feature factory
	// against a minimal fake ctx (no DOM/renderer needed for THREE.Scene()/Object3D()), same trick
	// game/sim/features-cardetail.test.mjs uses. ----
	const cardetailCtx = {
		world,
		scene: new THREE.Scene(),
		getVehicle: () => vehicle,
		carRoot: new THREE.Object3D(),
		quality: { level: 'high', shadowMapSize: 1024, pixelRatioCap: 2, antialias: false, envMapSize: 256 },
	};
	const cardetail = await createCarDetailFeature(cardetailCtx);

	// ---- occupants (spawn AWAKE, settle under their own restraint spring, then sleep) ----
	const chassisT0 = vehicle.chassis.getTransform();
	const seatPans = [];
	const occupants = [];
	SEAT_KEYS.forEach((seatKey, seatIndex) => {
		seatPans.push(createSeatPan(world, vehicle.chassis, seatKey, chassisT0.position, chassisT0.rotation));
		occupants.push(createOccupant(world, vehicle.chassis, seatIndex, seatKey, chassisT0.position, chassisT0.rotation));
	});

	// ---- Body inventories for awake-count tracking + force-wake (dynamic bodies only -- statics
	// never contribute solver cost either way) ----
	const destructibleBodies = destructibles.bodies.map((b) => b.body);
	const treeBodies = [
		...trees.saplings.map((s) => s.trunk),
		...trees.mids.map((m) => m.trunk),
		...trees.larges.flatMap((l) => l.branches.map((b) => b.body)),
	];
	const buildingBodies = structures.flatMap((s) => s.pieces.filter((p) => !p.isStatic).map((p) => p.body));
	const cardetailBodies = cardetail.hooks.bodies();
	const occupantBodies = [...seatPans.map((p) => p.body), ...occupants.flatMap((o) => Object.values(o.parts).map((p) => p.body))];

	const groups = {
		destructibles: destructibleBodies,
		trees: treeBodies,
		buildings: buildingBodies,
		cardetail: cardetailBodies,
		occupants: occupantBodies,
	};
	const allDynamicBodies = Object.values(groups).flat();

	function awakeCounts() {
		const out = { total: 0 };
		for (const [name, bodies] of Object.entries(groups)) {
			const n = bodies.filter((b) => b.isAwake()).length;
			out[name] = n;
			out.total += n;
		}
		return out;
	}

	function forceWakeAll() {
		for (const b of allDynamicBodies) b.setAwake(true);
	}

	function afterStepPolling() {
		stepTreesWorld(trees);
		for (const s of structures) pollStructureBreaks(s);
		cardetail.afterFixedStep(FIXED_DT);
		for (const o of occupants) pollOccupantRestraint(o);
	}

	console.log('[perf-bench-full] body inventory:');
	console.log(`  destructibles: ${destructibleBodies.length} dynamic (+ ${destructibles.ramps.length} static ramps)`);
	console.log(`  trees: ${treeBodies.length} dynamic (of ${treesBodyCount(trees)} total incl. static anchors/trunks)`);
	console.log(`  buildings: ${buildingBodies.length} dynamic (of ${totalPieceCount(structures)} total incl. static footings)`);
	console.log(`  cardetail: ${cardetailBodies.length} dynamic`);
	console.log(`  occupants: ${occupantBodies.length} dynamic (4 seat pans + ${occupants.length * 11} ragdoll parts)`);
	console.log(`  TOTAL dynamic (features + destructibles, excl. vehicle itself): ${allDynamicBodies.length}`);
	console.log(`[perf-bench-full] substeps under test: ${substeps} (tuning.ts's FIXED_SUBSTEPS is ${FIXED_SUBSTEPS})`);

	const neutral = { throttle: 0, brake: 0, steer: 0, handbrake: false };

	// =================================================================================================
	// STAGE (i): IDLE -- 5s zero input from a fresh spawn, sampling awake counts every 1s.
	// =================================================================================================
	console.log('\n[perf-bench-full] === STAGE (i) IDLE (5s, zero input) ===');
	console.log(`  t=0.00s (pre-step): ${JSON.stringify(awakeCounts())}`);
	for (let i = 0; i < IDLE_STEPS; i++) {
		stepVehicle(vehicle, neutral, FIXED_DT);
		world.step(FIXED_DT, substeps);
		afterStepPolling();
		if ((i + 1) % 60 === 0) {
			console.log(`  t=${((i + 1) / 60).toFixed(2)}s: ${JSON.stringify(awakeCounts())}`);
		}
	}
	const idleFinal = awakeCounts();
	console.log(`[perf-bench-full] IDLE final (t=5s) awake total=${idleFinal.total} (sleep discipline expects near-zero, modulo cardetail/occupants' own settle noise)`);

	// =================================================================================================
	// STAGE (ii): CHAOS -- force-wake everything, real full-throttle drive-up into the brick wall,
	// measure world.step() wall time over the drive-up + immediate aftermath.
	// =================================================================================================
	console.log('\n[perf-bench-full] === STAGE (ii) CHAOS (force-wake all + drive into brick wall) ===');
	forceWakeAll();
	console.log(`  post-force-wake: ${JSON.stringify(awakeCounts())}`);

	const chaosStepTimesMs = [];
	const fullThrottle = { throttle: 1, brake: 0, steer: 0, handbrake: false };
	for (let i = 0; i < CHAOS_DRIVE_STEPS; i++) {
		stepVehicle(vehicle, fullThrottle, FIXED_DT);
		const t0 = performance.now();
		world.step(FIXED_DT, substeps);
		chaosStepTimesMs.push(performance.now() - t0);
		afterStepPolling();
	}
	const speedAtImpactWindow = vehicle.chassis.getLinearVelocity();
	const speedKmhMid = Math.hypot(speedAtImpactWindow.x, speedAtImpactWindow.y, speedAtImpactWindow.z) * 3.6;
	for (let i = 0; i < CHAOS_AFTERMATH_STEPS; i++) {
		stepVehicle(vehicle, neutral, FIXED_DT);
		const t0 = performance.now();
		world.step(FIXED_DT, substeps);
		chaosStepTimesMs.push(performance.now() - t0);
		afterStepPolling();
	}
	const chaosStats = stats(chaosStepTimesMs);
	const brickWall = structures.find((s) => s.id === 'brick-wall');
	const displacedBricks = brickWall
		? brickWall.pieces.filter((p) => p.kind === 'brick').filter((p) => {
				const pos = p.body.getPosition();
				return Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z) > 0.5;
			}).length
		: -1;
	console.log(`[perf-bench-full] speed at drive-up/impact boundary: ${speedKmhMid.toFixed(1)}km/h; displacedBricks(>0.5m)=${displacedBricks}`);
	console.log(
		`[perf-bench-full] CHAOS world.step() wall time over ${chaosStepTimesMs.length} steps: avg=${chaosStats.avg.toFixed(3)}ms p95=${chaosStats.p95.toFixed(3)}ms max=${chaosStats.max.toFixed(3)}ms`,
	);
	const chaosAwake = awakeCounts();
	console.log(`[perf-bench-full] awake count at end of CHAOS window: ${JSON.stringify(chaosAwake)}`);
	const chaosPass = chaosStats.avg < 8;
	console.log(`[perf-bench-full] REQUIRED CHAOS avg < 8ms: ${chaosPass ? 'PASS' : 'FAIL'} (avg=${chaosStats.avg.toFixed(3)}ms)`);

	// =================================================================================================
	// STAGE (iii): SETTLE -- continue zero input, poll awake count each step, until it returns near
	// zero (threshold: <=4, allowing for a couple of genuinely-detached/resting-but-still-integrating
	// bodies) or the step cap is hit.
	// =================================================================================================
	console.log('\n[perf-bench-full] === STAGE (iii) SETTLE (post-crash, zero input) ===');
	const NEAR_ZERO_AWAKE_THRESHOLD = 4;
	let settleSteps = -1;
	for (let i = 0; i < SETTLE_CAP_STEPS; i++) {
		stepVehicle(vehicle, neutral, FIXED_DT);
		world.step(FIXED_DT, substeps);
		afterStepPolling();
		const counts = awakeCounts();
		if (counts.total <= NEAR_ZERO_AWAKE_THRESHOLD) {
			settleSteps = i + 1;
			console.log(`[perf-bench-full] SETTLE: awake total dropped to ${counts.total} at step ${settleSteps} (${(settleSteps / 60).toFixed(2)}s post-crash)`);
			break;
		}
		if ((i + 1) % 120 === 0) console.log(`  t=${((i + 1) / 60).toFixed(1)}s post-crash: ${JSON.stringify(counts)}`);
	}
	if (settleSteps < 0) {
		const finalCounts = awakeCounts();
		console.log(`[perf-bench-full] SETTLE: did NOT reach near-zero within ${SETTLE_CAP_STEPS} steps (${(SETTLE_CAP_STEPS / 60).toFixed(1)}s) -- final awake=${JSON.stringify(finalCounts)}`);
	}

	console.log('\n[perf-bench-full] === SUMMARY ===');
	console.log(`  IDLE final awake (t=5s): ${idleFinal.total}`);
	console.log(`  CHAOS: avg=${chaosStats.avg.toFixed(3)}ms p95=${chaosStats.p95.toFixed(3)}ms max=${chaosStats.max.toFixed(3)}ms over ${chaosStepTimesMs.length} steps -- ${chaosPass ? 'PASS' : 'FAIL'} (<8ms avg required)`);
	console.log(`  SETTLE: ${settleSteps >= 0 ? `${settleSteps} steps (${(settleSteps / 60).toFixed(2)}s)` : `did not reach near-zero within ${SETTLE_CAP_STEPS} steps`}`);

	world.destroy();
	process.exit(chaosPass ? 0 : 1);
}

main().catch((err) => {
	console.error('[perf-bench-full] ERROR', err);
	process.exit(1);
});
