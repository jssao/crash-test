// Diagnostic-only (C3b measurement pass): logs each door's panel.stress + doorLateralFraction() for
// the 4 scenarios named in the task brief, BEFORE picking DOOR_SPRUNG_LATERAL_FRACTION_MAX's real
// value. Not part of the deliverable -- scratchpad only.
//
// NOTE: plain `node` can't resolve the .ts imports (no extension-less TS resolution outside vitest) --
// the actual measurement run used an equivalent throwaway sim/_probe-lateral-fraction.test.mjs (run via
// `npx vitest run`, then deleted). This file is kept only as a readable record of that probe's logic;
// see damage-tuning.ts's DOOR_SPRUNG_LATERAL_FRACTION_MAX doc comment for the resulting measured
// fractions.
import { createDamageSim } from '../../sim/damage-harness.mjs';
import { createCrashRealismSim } from '../../sim/crash-realism-harness.mjs';
import { doorLateralFraction } from '../../src/damage/welds.ts';
import { BodyType } from '../../../src/ts/index.ts';

const DOORS = ['doorL', 'doorR', 'doorRL', 'doorRR'];

function report(label, sim) {
	console.log(`\n=== ${label} ===`);
	for (const key of DOORS) {
		const p = sim.vehicle.panels[key];
		const frac = doorLateralFraction(p);
		console.log(`  ${key}: state=${p.state} stress=${p.stress.toFixed(2)} lateralStressWeighted=${p.lateralStressWeighted.toFixed(2)} fraction=${frac.toFixed(3)}`);
	}
}

async function sideMdb50() {
	const sim = await createCrashRealismSim();
	try {
		sim.spawnSideWall(1.05); // matches side-fidelity.test.mjs's side-mdb-50 proxy
		sim.crashSideways(50);
		sim.settle(300);
		report('side-mdb-50 (proxy: spawnSideWall(1.05) + crashSideways(50))', sim);
	} finally {
		sim.destroy();
	}
}

async function sidePole32() {
	const sim = await createCrashRealismSim();
	try {
		// Narrow pole proxy (mirrors lab/barriers.ts's rigid-pole capsule, radius 0.15) at the +X flank,
		// door-height band -- crashSideways launches the car into it (car-moves-into-static-pole, same
		// relative-closing-speed equivalence the existing spawnSideWall proxy already relies on).
		const spawn = sim.vehicle.spawnPosition;
		const position = { x: spawn.x + 1.05, y: 0.6, z: spawn.z };
		const pole = sim.world.createBody({ type: BodyType.Static, position });
		pole.createCapsuleShape({ center1: { x: 0, y: -1.0, z: 0 }, center2: { x: 0, y: 1.6, z: 0 }, radius: 0.15, friction: 0.6, density: 1 });
		sim.crashSideways(32);
		sim.settle(300);
		report('side-pole-32 (proxy: rigid capsule pole + crashSideways(32))', sim);
	} finally {
		sim.destroy();
	}
}

async function frontal(speedKmh) {
	const sim = await createDamageSim();
	try {
		sim.spawnWall(12);
		sim.crash(speedKmh);
		for (let i = 0; i < 400; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		report(`frontal ${speedKmh} km/h`, sim);
	} finally {
		sim.destroy();
	}
}

await sideMdb50();
await sidePole32();
await frontal(161);
await frontal(193);
