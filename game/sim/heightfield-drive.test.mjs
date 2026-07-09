// SPDX-License-Identifier: MIT
//
// Drives the real vehicle over a bumpy dirt-style heightfield (LOCAL to this test -- harness.mjs's
// shared createSim()/createGroundBody() default is untouched) and checks:
//  1. Per-wheel suspension deflection variance is substantially higher than on flat ground.
//  2. The car stays controllable: finishes >100m displacement, upDot > 0.9 throughout.
//  3. No NaN/wasm traps.
//
// This is NOT a harness.mjs change -- it builds its own World + heightfield ground body directly
// (like top-speed-bounded.test.mjs and kicker-jump.test.mjs already do for their own reasons),
// reusing only the read-only vehicle helpers from game/src/vehicle/vehicle.ts.
import { describe, expect, it } from 'vitest';
import { init, World, BodyType } from '../../src/ts/index.ts';
import {
	createGroundBody,
	createVehicle,
	stepVehicle,
	getTelemetry,
	getSuspensionDeflection,
} from '../src/vehicle/vehicle.ts';
import { FIXED_DT, FIXED_SUBSTEPS, CHASSIS_ORIGIN_HEIGHT_M, WHEEL_SPAWN_SETTLE_MARGIN_M } from '../src/vehicle/tuning.ts';

const WHEEL_KEYS = ['fl', 'fr', 'rl', 'rr'];
const DRIVE_INPUT = { throttle: 1, brake: 0, steer: 0, handbrake: false };
const STEPS_15S = 900; // 15s @ 60Hz

// Grid: 41 columns x 601 rows, 1.5m x 1m cell size -> 60m wide, 600m long. Sized generously past
// the ~400-500m a 15s full-throttle run covers (top-speed-bounded.test.mjs: settles ~230km/h over
// 45s), so the car never drives off the field's edge into undefined territory.
const COUNT_X = 41;
const COUNT_Z = 601;
const SCALE = { x: 1.5, y: 1, z: 1 };
const HALF_WIDTH = ( ( COUNT_X - 1 ) * SCALE.x ) / 2; // 30m
const GROUND_Z_OFFSET = -10; // local z=0 maps to world z=-10, field runs to world z=590

// Gentle multi-frequency bumps + periodic shallow potholes along the drive line, kept well inside
// the vehicle's +-0.12m suspension travel (tuning.ts SUSPENSION_LOWER/UPPER_LIMIT_M) so wheels
// don't bottom out hard even at the worst-case bump+pothole overlap (~0.02+0.08=0.10m).
function terrainHeight(x, z) {
	let h = 0.02 * Math.sin(z * 0.2) + 0.015 * Math.sin(x * 0.3) * Math.cos(z * 0.15);
	for (let zc = 40; zc <= 560; zc += 40) {
		const d2 = (z - zc) ** 2;
		h -= 0.08 * Math.exp(-d2 / (2 * 3 * 3));
	}
	return h;
}

function buildHeights() {
	const heights = new Float32Array(COUNT_X * COUNT_Z);
	for (let row = 0; row < COUNT_Z; row++) {
		for (let col = 0; col < COUNT_X; col++) {
			const worldX = col * SCALE.x - HALF_WIDTH;
			const worldZ = row * SCALE.z + GROUND_Z_OFFSET;
			heights[row * COUNT_X + col] = terrainHeight(worldX, worldZ);
		}
	}
	return heights;
}

function createHeightfieldGroundBody(world) {
	const ground = world.createBody({ type: BodyType.Static, position: { x: -HALF_WIDTH, y: 0, z: GROUND_Z_OFFSET } });
	const heights = buildHeights();
	ground.createHeightFieldShape(heights, COUNT_X, COUNT_Z, SCALE, { friction: 0.95 });
	return ground;
}

function variance(samples) {
	const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
	return samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
}

/** Drives 15s full throttle straight, sampling per-wheel suspension deflection every step. */
function driveAndSample(world, vehicle) {
	const deflections = { fl: [], fr: [], rl: [], rr: [] };
	let minUpDot = 1;
	let sawNaN = false;
	for (let i = 0; i < STEPS_15S; i++) {
		stepVehicle(vehicle, DRIVE_INPUT, FIXED_DT);
		world.step(FIXED_DT, FIXED_SUBSTEPS);
		const t = getTelemetry(vehicle);
		if (!Number.isFinite(t.chassisPos.x) || !Number.isFinite(t.chassisPos.y) || !Number.isFinite(t.chassisPos.z)) {
			sawNaN = true;
		}
		minUpDot = Math.min(minUpDot, t.upDot);
		for (const key of WHEEL_KEYS) deflections[key].push(getSuspensionDeflection(vehicle, key));
	}
	const finalTelemetry = getTelemetry(vehicle);
	return { deflections, minUpDot, sawNaN, finalTelemetry };
}

describe('heightfield-drive', () => {
	it('bumpy heightfield ground: suspension deflection variance is substantially higher than flat ground; car stays controllable', async () => {
		const native = await init();

		// --- Flat baseline (shared vehicle.ts createGroundBody -- read-only import, not modified) ---
		const flatWorld = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		let flatResult;
		try {
			createGroundBody(flatWorld);
			const flatVehicle = createVehicle(flatWorld);
			flatResult = driveAndSample(flatWorld, flatVehicle);
		} finally {
			flatWorld.destroy();
		}

		// --- Heightfield run ---
		const hfWorld = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		let hfResult;
		try {
			createHeightfieldGroundBody(hfWorld);
			const spawnY = terrainHeight(0, 0) + CHASSIS_ORIGIN_HEIGHT_M - WHEEL_SPAWN_SETTLE_MARGIN_M;
			const hfVehicle = createVehicle(hfWorld, { x: 0, y: spawnY, z: 0 });
			hfResult = driveAndSample(hfWorld, hfVehicle);

			expect(hfResult.sawNaN).toBe(false);
			expect(hfWorld.isValid()).toBe(true);

			const displacementZ = hfResult.finalTelemetry.chassisPos.z;
			const varianceReport = {};
			for (const key of WHEEL_KEYS) {
				varianceReport[key] = {
					flat: variance(flatResult.deflections[key]),
					hf: variance(hfResult.deflections[key]),
				};
			}
			// eslint-disable-next-line no-console
			console.log(
				`[heightfield-drive] displacement=${displacementZ.toFixed(1)}m minUpDot(hf)=${hfResult.minUpDot.toFixed(4)} ` +
					`minUpDot(flat)=${flatResult.minUpDot.toFixed(4)} finalSpeed=${hfResult.finalTelemetry.speedKmh.toFixed(1)}km/h`,
			);
			for (const key of WHEEL_KEYS) {
				const { flat, hf } = varianceReport[key];
				// eslint-disable-next-line no-console
				console.log(
					`[heightfield-drive] wheel ${key} deflection variance: flat=${flat.toExponential(3)} heightfield=${hf.toExponential(3)} ratio=${(hf / Math.max(flat, 1e-12)).toFixed(1)}x`,
				);
			}

			expect(hfResult.minUpDot).toBeGreaterThan(0.9);
			expect(displacementZ).toBeGreaterThan(100);

			for (const key of WHEEL_KEYS) {
				const { flat, hf } = varianceReport[key];
				// Substantially higher: heightfield variance must clear both an absolute floor (guards
				// against a near-zero flat baseline making any ratio look "big") and a healthy multiple
				// of the flat baseline.
				expect(hf).toBeGreaterThan(1e-6);
				expect(hf).toBeGreaterThan(flat * 3);
			}
		} finally {
			hfWorld.destroy();
		}
	});
});
