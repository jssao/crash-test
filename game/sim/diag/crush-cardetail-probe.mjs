// DIAGNOSTIC (crush M1, TEMP): cardetail-containment 140km/h wall crash repro -- why do ZERO parts
// break? Traces chassis/cradle speed, sample part weld forces, break states.
// Run: npx vite-node sim/diag/crush-cardetail-probe.mjs
import * as THREE from 'three';
import { Sim, loadNative } from '../harness.mjs';
import { spawnTestWall, crashSetup } from '../../src/damage/scenario.ts';
import { FIXED_DT } from '../../src/vehicle/tuning.ts';
import createCarDetailFeature from '../../src/world/features/cardetail/index.ts';
import { CAR_DETAIL_SPECS } from '../../src/world/features/cardetail/tuning.ts';

const native = await loadNative();
const sim = new Sim(native);
const ctx = {
	world: sim.world,
	scene: new THREE.Scene(),
	getVehicle: () => sim.vehicle,
	carRoot: new THREE.Object3D(),
	quality: { level: 'high', shadowMapSize: 1024, pixelRatioCap: 2, antialias: false, envMapSize: 256 },
};
const feature = await createCarDetailFeature(ctx);

spawnTestWall(sim.world, sim.vehicle, 8);
crashSetup(sim.vehicle, 140);

const SAMPLE = ['battery', 'radiatorFan', 'headlightL', 'frontBumperBeam', 'engineBlock', 'coolantReservoir'];
for (let i = 0; i < 300; i++) {
	sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	feature.afterFixedStep(FIXED_DT);
	const cv = sim.vehicle.chassis.getLinearVelocity();
	const speed = Math.hypot(cv.x, cv.y, cv.z);
	if (i < 40 || i % 50 === 0) {
		const forces = feature.hooks.constraintForces();
		const cradle = sim.vehicle.segments?.bodies.engineCradle;
		const cs = cradle ? cradle.body.getLinearVelocity() : { x: 0, y: 0, z: 0 };
		const fstr = SAMPLE.map((id) => `${id}=${forces[id] === null ? 'FREE' : forces[id].toFixed(0)}`).join(' ');
		if (i < 25 || i % 50 === 0 || speed > 1)
			console.log(`[cd] step=${i} chassis=${speed.toFixed(2)} cradleV=${Math.hypot(cs.x, cs.y, cs.z).toFixed(2)} ${fstr}`);
	}
}
const states = feature.hooks.states();
const broken = CAR_DETAIL_SPECS.filter((s) => states[s.id] !== 'attached');
console.log(`[cd-final] broken=${broken.length}: ${broken.map((s) => s.id).join(',')}`);
const chassisPos = sim.vehicle.chassis.getPosition();
console.log(`[cd-final] chassisPos z=${chassisPos.z.toFixed(2)} (wall at 8m + halfcar)`);
feature.dispose?.();
sim.destroy();
