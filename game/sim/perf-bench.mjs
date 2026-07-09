// SPDX-License-Identifier: MIT
//
// Headless perf gate (G4/G5 spec): full world (car + all destructibles), a scripted 5s full-throttle
// run straight into wall-center (the perf-bench's "wall #1 mid-pile" target -- see
// game/src/world/tuning.ts's WALL_CONFIGS doc comment: it sits directly ahead of spawn), with EVERY
// destructible body force-woken up front (defeating the sleep optimization on purpose, so this
// measures the genuine worst case rather than the best case where most bodies are still asleep).
// Measures world.step() wall-clock time per fixed step over >=300 steps, reports avg/p95/max ms.
//
// REQUIRED: avg < 8ms on this machine. Run via `npm run bench` (wired to `vite-node`, same TS-aware
// module transform vitest itself uses under the hood -- see game/sim/harness.mjs's own doc comment on
// why a plain `node` invocation can't resolve this project's .ts module graph directly: our .ts files
// import sibling modules by their eventual ".js" path, which plain Node's built-in type-stripping does
// not remap back to ".ts" on disk).
//
// Usage:
//   npm run bench                  -- uses vehicle/tuning.ts's exported FIXED_SUBSTEPS
//   npm run bench -- --substeps=8  -- overrides the substep count for exploration (does NOT edit
//                                     tuning.ts -- see that flag's doc comment below for why this
//                                     script accepts an override rather than mutating source).

import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, stepVehicle } from '../src/vehicle/vehicle.ts';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';
import { createDestructibleWorld } from '../src/world/bodies.ts';

const argSubsteps = process.argv.find((a) => a.startsWith('--substeps='));
// Substeps is passed straight to world.step(dt, N) as a per-call argument (NOT read from
// vehicle/tuning.ts's FIXED_SUBSTEPS export at every call site elsewhere in the codebase) -- this
// lets the perf-gate PROCEDURE (see this file's header + README-style task notes) explore alternate
// substep counts here first, cheaply, before actually editing tuning.ts's FIXED_SUBSTEPS and re-running
// the full game/sim/*.test.mjs matrix to confirm nothing regressed at that lower value.
const substeps = argSubsteps ? Number(argSubsteps.split('=')[1]) : FIXED_SUBSTEPS;

const STEPS = 300; // 5s @ 60Hz -- spec's ">=300 steps"

async function main() {
	const native = await init();
	const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
	createGroundBody(world);
	const vehicle = createVehicle(world, { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 });
	const destructibles = createDestructibleWorld(world);

	const dynamicBodyCount = destructibles.bodies.length;
	const staticRampCount = destructibles.ramps.length;
	console.log(`[perf-bench] destructible dynamic bodies: ${dynamicBodyCount} (+ ${staticRampCount} static ramps)`);
	console.log(`[perf-bench] substeps under test: ${substeps} (tuning.ts's FIXED_SUBSTEPS is ${FIXED_SUBSTEPS})`);

	// Force-wake EVERY destructible body up front: spawning asleep is the normal/optimized path (see
	// bodies.ts's createDestructibleWorld() doc comment), but the perf GATE explicitly wants the worst
	// case ("everything woken") measured, not the best case where most of the field never wakes up
	// during a single scripted run.
	for (const b of destructibles.bodies) b.body.setAwake(true);

	const stepTimesMs = [];
	const input = { throttle: 1, brake: 0, steer: 0, handbrake: false };

	for (let i = 0; i < STEPS; i++) {
		stepVehicle(vehicle, input, FIXED_DT);
		const t0 = performance.now();
		world.step(FIXED_DT, substeps);
		stepTimesMs.push(performance.now() - t0);
	}

	const finalPos = vehicle.chassis.getPosition();
	const finalSpeedKmh = Math.sqrt(
		vehicle.chassis.getLinearVelocity().x ** 2 + vehicle.chassis.getLinearVelocity().y ** 2 + vehicle.chassis.getLinearVelocity().z ** 2,
	) * 3.6;
	console.log(`[perf-bench] final chassis Z=${finalPos.z.toFixed(1)}m (wall-center is at z=18) speed=${finalSpeedKmh.toFixed(0)}km/h`);

	const sorted = [...stepTimesMs].sort((a, b) => a - b);
	const avg = stepTimesMs.reduce((s, v) => s + v, 0) / stepTimesMs.length;
	const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
	const max = sorted[sorted.length - 1];

	console.log(`[perf-bench] world.step() wall time over ${STEPS} steps: avg=${avg.toFixed(3)}ms p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms`);
	const pass = avg < 8;
	console.log(`[perf-bench] REQUIRED avg < 8ms: ${pass ? 'PASS' : 'FAIL'} (avg=${avg.toFixed(3)}ms)`);

	world.destroy();
	process.exit(pass ? 0 : 1);
}

main().catch((err) => {
	console.error('[perf-bench] ERROR', err);
	process.exit(1);
});
