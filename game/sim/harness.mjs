// SPDX-License-Identifier: MIT
//
// Headless drive-test harness. Plain module (no three/DOM) -- imports only the box3d-js binding and
// the renderer-free vehicle physics core (game/src/vehicle/*.ts), same as the browser game does.
// Run through vitest (game/package.json's `test:sim` script) rather than raw `node --test`: the
// binding + vehicle core are authored in TypeScript, and vitest's Vite-powered module graph
// transforms every file it imports (regardless of the importing file's own extension) without a
// separate build step -- this file itself contains no TypeScript syntax, so it would run unmodified
// under a plain `node --test` + ts-node/tsx loader too.
//
// Requires ../../build/wasm/box3d.mjs to exist (scripts/build-wasm.sh at the repo root).

import { init, World } from '../../src/ts/index.ts';
import { createGroundBody, createVehicle, getTelemetry, resetVehicle, stepVehicle, NEUTRAL_INPUT } from '../src/vehicle/vehicle.ts';
import { CHASSIS_ORIGIN_HEIGHT_M, FIXED_DT, FIXED_SUBSTEPS } from '../src/vehicle/tuning.ts';

let cachedNative = null;

function loadNative() {
	if (cachedNative === null) {
		cachedNative = init();
	}
	return cachedNative;
}

/** One headless world + vehicle + ground, with a fixed-step drive() helper the tests script against. */
export class Sim {
	constructor(native, spawnPosition = { x: 0, y: CHASSIS_ORIGIN_HEIGHT_M, z: 0 }, sprungBallast = []) {
		this.world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
		this.ground = createGroundBody(this.world);
		// sprungBallast (default none): sim-only chassis ballast emulating the full game's cardetail +
		// occupant feature load, so ride-height / suspension-feel tests can measure the LADEN operating
		// point. See createVehicle()'s SprungBallastPoint doc comment.
		this.vehicle = createVehicle(this.world, spawnPosition, undefined, sprungBallast);
		this.timeSec = 0;
	}

	/** Advances the vehicle control layer + physics by one fixed step (1/60s, 4 substeps). */
	step(input = NEUTRAL_INPUT) {
		stepVehicle(this.vehicle, input, FIXED_DT);
		this.world.step(FIXED_DT, FIXED_SUBSTEPS);
		this.timeSec += FIXED_DT;
	}

	/** Advances N fixed steps with a constant input, returning the telemetry after each step. */
	drive(input, steps) {
		const history = [];
		for (let i = 0; i < steps; i++) {
			this.step(input);
			history.push(this.telemetry());
		}
		return history;
	}

	telemetry() {
		return getTelemetry(this.vehicle);
	}

	reset() {
		resetVehicle(this.vehicle);
		this.timeSec = 0;
	}

	destroy() {
		this.world.destroy();
	}
}

export async function createSim(spawnPosition, sprungBallast = []) {
	const native = await loadNative();
	return new Sim(native, spawnPosition, sprungBallast);
}

export { loadNative };
