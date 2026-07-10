// DIAGNOSTIC (crush M1, TEMP): escalation-3 repro -- elevated-platform no-wall 55km/h stop; traces
// the rears' flight, FSM states and ground estimates to see why a striker stalls.
// Run: CRUSH_DEBUG=1 npx vite-node sim/diag/crush-flee-probe.mjs
import { createSim } from '../harness.mjs';
import { crashSetup } from '../../src/damage/scenario.ts';
import { createDamageSystem, stepDamageSystem } from '../../src/damage/system.ts';

import {
	createOccupant,
	createSeatPan,
	matchOccupantVelocity,
	matchSeatPanVelocity,
	pollOccupantRestraint,
	teardownOccupant,
	teardownSeatPan,
} from '../../src/world/features/occupants/physics.ts';
import { createOccupantRuntime, resetOccupantAccelBaseline, updateOccupantActive } from '../../src/world/features/occupants/active.ts';
import { SEAT_KEYS, CHASSIS_ORIGIN_HEIGHT_M } from '../../src/world/features/occupants/tuning.ts';
import { CHASSIS_ORIGIN_HEIGHT_M as COH } from '../../src/vehicle/tuning.ts';
import { BodyType } from '../../../src/ts/index.ts';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const PLATFORM_TOP_Y = 1.2;

const sim = await createSim({ x: 0, y: COH + PLATFORM_TOP_Y, z: 0 });
const slab = sim.world.createBody({ type: BodyType.Static, position: { x: 0, y: PLATFORM_TOP_Y - 0.5, z: 0 } });
slab.createBoxShape({ halfExtents: { x: 150, y: 0.5, z: 150 }, friction: 0.8 });

const chassis = sim.vehicle.chassis;
const t0 = chassis.getTransform();
const pans = [];
const occupants = [];
const runtimes = [];
SEAT_KEYS.forEach((seatKey, i) => {
	pans.push(createSeatPan(sim.world, chassis, seatKey, t0.position, t0.rotation));
	occupants.push(createOccupant(sim.world, chassis, i, seatKey, t0.position, t0.rotation));
	runtimes.push(createOccupantRuntime());
});
const damage = createDamageSystem(sim.vehicle);

function activeCtx() {
	const t = chassis.getTransform();
	return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: chassis.getLinearVelocity(), world: sim.world };
}
function stepAll() {
	sim.step(NEUTRAL);
	stepDamageSystem(damage, sim.world, 1 / 60);
	const ctx = activeCtx();
	occupants.forEach((o, k) => {
		pollOccupantRestraint(o);
		updateOccupantActive(o, runtimes[k], 1 / 60, ctx);
	});
}

for (let i = 0; i < (process.env.SETTLE ? +process.env.SETTLE : 30); i++) stepAll();

{
	const t = chassis.getTransform();
	const q = t.rotation;
	const pitchDeg = (Math.asin(Math.max(-1, Math.min(1, 2 * (q.w * q.x - q.y * q.z)))) * 180) / Math.PI;
	console.log(`[settle] chassis pos=(${t.position.x.toFixed(3)},${t.position.y.toFixed(3)},${t.position.z.toFixed(3)}) pitchDeg=${pitchDeg.toFixed(3)}`);
	occupants.forEach((o) => {
		const h = o.parts.head.body.getPosition();
		const pv = o.parts.pelvis.body.getPosition();
		console.log(`[settle] ${o.seatKey}: head=(${h.x.toFixed(3)},${h.y.toFixed(3)},${h.z.toFixed(3)}) pelvis=(${pv.x.toFixed(3)},${pv.y.toFixed(3)},${pv.z.toFixed(3)})`);
	});
}

crashSetup(sim.vehicle, process.env.SPEED ? +process.env.SPEED : 55);
const v = chassis.getLinearVelocity();
occupants.forEach((o, k) => {
	matchOccupantVelocity(o, v);
	resetOccupantAccelBaseline(o, runtimes[k]);
});
for (const p of pans) matchSeatPanVelocity(p, v);
const zero = { x: 0, y: 0, z: 0 };
chassis.setLinearVelocity(zero);
for (const w of Object.values(sim.vehicle.wheels)) w.body.setLinearVelocity(zero);
for (const pnl of Object.values(sim.vehicle.panels)) pnl.body.setLinearVelocity(zero);
if (sim.vehicle.segments) { for (const h of Object.values(sim.vehicle.segments.bodies)) h.body.setLinearVelocity(zero); }
// Elimination switches: NO_CORES=1 destroys the two crush-core chassis shapes; NO_SEGS=1 destroys
// the 9 segment bodies (+welds) outright, pre-crash.
// FULL_MASS=1: re-stamp the chassis with the RECOMPOSED full parity mass (undo the segment
// deduction) to test whether the lighter/rear-shifted chassis remainder is what changes the launch.
if (process.env.FULL_MASS) {
	const { composeSegmentsWithChassis } = await import('../../src/vehicle/geometry.ts');
	const { segmentMassSpecs } = await import('../../src/vehicle/segments.ts');
	const md = chassis.getMassData();
	const cur = { mass: md.mass, center: md.center, inertia: md.inertia };
	const composite = composeSegmentsWithChassis(cur, segmentMassSpecs(), md.center);
	chassis.setMassData({ mass: composite.mass, center: composite.center, inertia: composite.inertia });
	console.log(`[esc3] FULL MASS restamped: ${md.mass.toFixed(1)} -> ${composite.mass.toFixed(1)}`);
}
if (process.env.NO_CORES && sim.vehicle.segments) {
	sim.vehicle.segments.cores.front.shape.destroy(false);
	sim.vehicle.segments.cores.rear.shape.destroy(false);
	sim.vehicle.segments.cores.front.shape = null;
	sim.vehicle.segments.cores.rear.shape = null;
	console.log('[esc3] CORES DESTROYED');
}
if (process.env.NO_SEGS && sim.vehicle.segments) {
	for (const w of sim.vehicle.segments.welds) { if (w.joint) { w.joint.destroy(); w.joint = null; } }
	for (const h of Object.values(sim.vehicle.segments.bodies)) { h.shape.destroy(false); h.body.destroy(); }
	sim.vehicle.segments.bodies = {};
	sim.vehicle.segments.welds = [];
	console.log('[esc3] SEGMENTS DESTROYED');
}
for (const p of pans) p.body.setLinearVelocity(zero);

for (let step = 0; step < 1800; step++) {
	stepAll();
	if ((step < 60 && step % 4 === 0) || (step < 600 && step % 60 === 0) || step % 300 === 0) {
		const parts = [2, 3].map((k) => {
			const o = occupants[k];
			const p = o.parts.pelvis.body.getPosition();
			const h = o.parts.head.body.getPosition();
			return `${o.seatKey}[${runtimes[k].state}] pelvis=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) headY=${h.y.toFixed(2)} gY=${runtimes[k].groundY === null ? 'null' : runtimes[k].groundY.toFixed(2)}`;
		});
		console.log(`[esc3] step=${step} ${parts.join(' | ')}`);
	}
}
const carPos = chassis.getPosition();
occupants.forEach((o, k) => {
	const p = o.parts.pelvis.body.getPosition();
	console.log(
		`[esc3-final] ${o.seatKey}: state=${runtimes[k].state} alive=${runtimes[k].alive} ejected=${o.ejected} dist=${Math.hypot(p.x - carPos.x, p.z - carPos.z).toFixed(1)} pelvisY=${p.y.toFixed(2)} groundY=${runtimes[k].groundY === null ? 'null' : runtimes[k].groundY.toFixed(2)}`,
	);
});
console.log(`[esc3-final] windshield=${sim.vehicle.glass.windshield.shape === null ? 'DESTROYED' : 'ALIVE'} carPos=(${carPos.x.toFixed(2)},${carPos.y.toFixed(2)},${carPos.z.toFixed(2)})`);
for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
