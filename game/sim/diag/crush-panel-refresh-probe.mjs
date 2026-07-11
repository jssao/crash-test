// DIAGNOSTIC (crush M3, TEMP): what does a frontal crash do to the HOOD panel mesh + hull refresh?
// Run: SPEED=40 npx vite-node sim/diag/crush-panel-refresh-probe.mjs
import { createCrashRealismSim } from '../crash-realism-harness.mjs';
import { BodyType } from '../../../src/ts/index.ts';
import { OCCUPANT_EJECTED_COLLIDABLE_BIT } from '../../src/vehicle/tuning.ts';

// DROP=1: skip the crash; drop an ejectee-masked heavy box on the hood and trace.
if (process.env.DROP) {
	const sim = await createCrashRealismSim();
	for (let i = 0; i < 30; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
	const hood = sim.vehicle.panels.hood;
	const hp0 = hood.body.getPosition();
	console.log(`[drop] hood body=(${hp0.x.toFixed(2)},${hp0.y.toFixed(2)},${hp0.z.toFixed(2)}) half=${JSON.stringify(hood.halfExtents)}`);
	const box = sim.world.createBody({ type: BodyType.Dynamic, position: { x: hp0.x, y: hp0.y + 2.0, z: hp0.z } });
	box.createBoxShape({ halfExtents: { x: 0.3, y: 0.15, z: 0.3 }, density: 500, friction: 0.7, maskBits: OCCUPANT_EJECTED_COLLIDABLE_BIT });
	for (let i = 0; i < 180; i++) {
		sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		if (i % 20 === 0) {
			const st = sim.damage.panelHull.perPanel.hood;
			const m = sim.damage.registry.meshes.find((mm) => mm.kind === 'panel' && mm.attachedTo === 'hood');
			let mn = 0, sum = 0;
			for (let v = 0; v < m.vertexCount; v++) { mn = Math.min(mn, m.offsets[v * 3 + 1]); sum += m.offsets[v * 3 + 1]; }
			console.log(`[drop] step=${i} boxY=${box.getPosition().y.toFixed(3)} minY=${mn.toFixed(3)} meanY=${(sum / m.vertexCount).toFixed(3)} refreshes=${sim.damage.panelHull.refreshes.hood} lastStep=${st.lastRefreshStep} aabbAtRef.minY=${st.aabbAtRefresh ? st.aabbAtRefresh.min.y.toFixed(3) : 'null'}`);
		}
	}
	const mesh = sim.damage.registry.meshes.find((m) => m.kind === 'panel' && m.attachedTo === 'hood');
	let minY = 0, maxAbs = 0;
	for (let v = 0; v < mesh.vertexCount; v++) {
		minY = Math.min(minY, mesh.offsets[v * 3 + 1]);
		maxAbs = Math.max(maxAbs, Math.hypot(mesh.offsets[v * 3], mesh.offsets[v * 3 + 1], mesh.offsets[v * 3 + 2]));
	}
	console.log(`[drop] final boxY=${box.getPosition().y.toFixed(3)} hoodY=${hood.body.getPosition().y.toFixed(3)} dentMinY=${minY.toFixed(3)} maxOff=${maxAbs.toFixed(3)} dented=${sim.damageTelemetry().dentedVertexCount} refreshes=${JSON.stringify(sim.damage.panelHull.refreshes)}`);
	const mins = [Infinity, Infinity, Infinity];
	const maxs = [-Infinity, -Infinity, -Infinity];
	for (let v = 0; v < mesh.vertexCount; v++) for (let a = 0; a < 3; a++) {
		mins[a] = Math.min(mins[a], mesh.offsets[v * 3 + a]);
		maxs[a] = Math.max(maxs[a], mesh.offsets[v * 3 + a]);
	}
	console.log(`[drop] offset ranges x=[${mins[0].toFixed(3)},${maxs[0].toFixed(3)}] y=[${mins[1].toFixed(3)},${maxs[1].toFixed(3)}] z=[${mins[2].toFixed(3)},${maxs[2].toFixed(3)}] hoodQuat=${JSON.stringify(hood.body.getRotation())}`);
	sim.destroy();
	process.exit(0);
}

const speed = process.env.SPEED ? +process.env.SPEED : 40;
const sim = await createCrashRealismSim();
sim.spawnWall(10);
sim.crashFrontal(speed);
sim.settle(300);

const dt = sim.damageTelemetry();
const mesh = sim.damage.registry.meshes.find((m) => m.kind === 'panel' && m.attachedTo === 'hood');
let maxOff = 0;
for (let v = 0; v < mesh.vertexCount; v++) {
	const m = Math.hypot(mesh.offsets[v * 3], mesh.offsets[v * 3 + 1], mesh.offsets[v * 3 + 2]);
	if (m > maxOff) maxOff = m;
}
console.log(`[panel-refresh] ${speed}km/h hoodState=${dt.panelStates.hood} hoodMeshMaxOffset=${maxOff.toFixed(3)} refreshes=${JSON.stringify(sim.damage.panelHullRefreshes ?? sim.damage.panelHull.refreshes)}`);
{
	const st = sim.damage.panelHull.perPanel.hood;
	const min = { x: Infinity, y: Infinity, z: Infinity };
	const max = { x: -Infinity, y: -Infinity, z: -Infinity };
	for (let v = 0; v < mesh.vertexCount; v++) {
		const x = mesh.basePositions[v * 3] + mesh.offsets[v * 3];
		const y = mesh.basePositions[v * 3 + 1] + mesh.offsets[v * 3 + 1];
		const z = mesh.basePositions[v * 3 + 2] + mesh.offsets[v * 3 + 2];
		min.x = Math.min(min.x, x); min.y = Math.min(min.y, y); min.z = Math.min(min.z, z);
		max.x = Math.max(max.x, x); max.y = Math.max(max.y, y); max.z = Math.max(max.z, z);
	}
	console.log(`[panel-refresh-dbg] fixedStep=${sim.damage.panelHull.fixedStep} meshAabb0=${JSON.stringify(st.meshAabb0)} aabbAtRefresh=${JSON.stringify(st.aabbAtRefresh)} nowMin=${JSON.stringify(min)} nowMax=${JSON.stringify(max)} lastRefreshStep=${st.lastRefreshStep}`);
}

// Probe sphere: drop onto the hood dent region and see where it rests (world y).
const hood = sim.vehicle.panels.hood;
const hp = hood.body.getPosition();
const probe = sim.world.createBody({ type: BodyType.Dynamic, position: { x: hp.x, y: hp.y + 1.5, z: hp.z } });
probe.createSphereShape({ radius: 0.06, density: 300, friction: 0.6 });
for (let i = 0; i < 240; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
console.log(`[panel-refresh] probe rest y=${probe.getPosition().y.toFixed(3)} hoodBodyY=${hood.body.getPosition().y.toFixed(3)} hoodTopPristine=${(hood.body.getPosition().y + hood.halfExtents.y).toFixed(3)}`);
sim.destroy();
