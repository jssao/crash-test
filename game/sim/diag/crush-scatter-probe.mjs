// DIAGNOSTIC (crush M1, TEMP): features-cardetail hard-frontal repro -- per-part break step, impact
// speed, final displacements. Run: npx vite-node sim/diag/crush-scatter-probe.mjs
import * as THREE from 'three';
import { Sim, loadNative } from '../harness.mjs';
import { spawnTestWall } from '../../src/damage/scenario.ts';
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
const ENGINE_BAY_IDS = CAR_DETAIL_SPECS.filter((s) => s.engineBay).map((s) => s.id);

spawnTestWall(sim.world, sim.vehicle, 60);
const breakStep = {};
let prevStates = feature.hooks.states();
let peakSpeed = 0;
let impactStep = -1;
let prevSpeed = 0;
for (let i = 0; i < 320 + 240; i++) {
	const input = i < 320 ? { throttle: 1, brake: 0, steer: 0, handbrake: false } : { throttle: 0, brake: 0, steer: 0, handbrake: false };
	sim.step(input);
	feature.afterFixedStep(FIXED_DT);
	const cv = sim.vehicle.chassis.getLinearVelocity();
	const speed = Math.hypot(cv.x, cv.y, cv.z);
	if (speed > peakSpeed) peakSpeed = speed;
	if (impactStep === -1 && prevSpeed - speed > 3) {
		impactStep = i;
		console.log(`[scatter] impact at step ${i}: ${(prevSpeed * 3.6).toFixed(0)}km/h -> ${(speed * 3.6).toFixed(0)}km/h`);
	}
	prevSpeed = speed;
	const states = feature.hooks.states();
	for (const id of Object.keys(states)) {
		if (states[id] !== prevStates[id] && states[id] !== 'attached') breakStep[id] = i;
	}
	prevStates = states;
}
const states = feature.hooks.states();
const disp = feature.hooks.displacements();
const idToIndex = new Map(CAR_DETAIL_SPECS.map((s, i) => [s.id, i]));
console.log(`[scatter] peakSpeed=${(peakSpeed * 3.6).toFixed(0)}km/h`);
for (const id of ENGINE_BAY_IDS) {
	if (states[id] !== 'attached') console.log(`[scatter] ${id}: state=${states[id]} brokeAt=${breakStep[id]} disp=${disp[idToIndex.get(id)].toFixed(2)}m`);
}
const det = ENGINE_BAY_IDS.filter((id) => states[id] !== 'attached');
console.log(`[scatter-final] detached=${det.length} ge1.5m=${det.filter((id) => disp[idToIndex.get(id)] >= 1.5).length}`);
feature.dispose?.();
sim.destroy();
