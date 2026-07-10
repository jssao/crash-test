// DIAGNOSTIC (crush M1, TEMP): reproduces occupants-active's 70km/h ejection scenario and traces
// (a) the chassis forward-speed pulse, (b) occupant ejection timing, (c) pane strikes (via the TEMP
// CRUSH_DEBUG log in damage/system.ts). Run: CRUSH_DEBUG=1 npx vite-node sim/diag/crush-eject-probe.mjs
// A/B: run identically in a worktree at baseline HEAD.
import { createSim } from '../harness.mjs';
import { spawnTestWall, crashSetup } from '../../src/damage/scenario.ts';
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
import { SEAT_KEYS } from '../../src/world/features/occupants/tuning.ts';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };

const sim = await createSim();
const chassis = sim.vehicle.chassis;

function activeCtx() {
	const t = chassis.getTransform();
	return { chassisPos: t.position, chassisRot: t.rotation, chassisVel: chassis.getLinearVelocity(), world: sim.world };
}
function pelvisDist(o) {
	const p = o.parts.pelvis.body.getPosition();
	const c = chassis.getPosition();
	return Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z);
}

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

for (let i = 0; i < 60; i++) {
	sim.step(NEUTRAL);
	stepDamageSystem(damage, sim.world, 1 / 60);
	const ctx = activeCtx();
	occupants.forEach((o, k) => {
		pollOccupantRestraint(o);
		updateOccupantActive(o, runtimes[k], 1 / 60, ctx);
	});
}

spawnTestWall(sim.world, sim.vehicle, 20);
crashSetup(sim.vehicle, 70);
const v = chassis.getLinearVelocity();
occupants.forEach((o, k) => {
	matchOccupantVelocity(o, v);
	resetOccupantAccelBaseline(o, runtimes[k]);
});
for (const p of pans) matchSeatPanVelocity(p, v);

let prevSpeed = Math.hypot(v.x, v.y, v.z);
let peakDecelG = 0;
const ejectStep = occupants.map(() => -1);
const peakSep = occupants.map(() => 0);
let headSpeedAtEject = occupants.map(() => 0);

for (let step = 0; step < 360; step++) {
	sim.step(NEUTRAL);
	stepDamageSystem(damage, sim.world, 1 / 60);
	const cv = chassis.getLinearVelocity();
	const speed = Math.hypot(cv.x, cv.y, cv.z);
	const decelG = (prevSpeed - speed) * 60 / 9.81;
	if (decelG > peakDecelG) peakDecelG = decelG;
	if (step < 120 && (step % 5 === 0 || decelG > 2)) {
		console.log(`[trace] step=${step} chassisSpeed=${speed.toFixed(2)} decelG=${decelG.toFixed(1)}`);
	}
	prevSpeed = speed;
	const ctx = activeCtx();
	if (step >= 62 && step <= 110 && step % 2 === 0) {
		const t = chassis.getTransform();
		const inv = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
		const rot = (q, v) => {
			const { x, y, z, w } = q;
			const tx = 2 * (y * v.z - z * v.y), ty = 2 * (z * v.x - x * v.z), tz = 2 * (x * v.y - y * v.x);
			return { x: v.x + w * tx + y * tz - z * ty, y: v.y + w * ty + z * tx - x * tz, z: v.z + w * tz + x * ty - y * tx };
		};
		const loc = (pos) => rot(inv(t.rotation), { x: pos.x - t.position.x, y: pos.y - t.position.y, z: pos.z - t.position.z });
		const parts = [];
		for (const k of [2, 3]) {
			const h = loc(occupants[k].parts.head.body.getPosition());
			parts.push(`${occupants[k].seatKey}head=(${h.x.toFixed(2)},${h.y.toFixed(2)},${h.z.toFixed(2)})`);
		}
		const hood = damage.panels.hood;
		const hp = loc(hood.body.getPosition());
		parts.push(`hood[${hood.state}]=(${hp.x.toFixed(2)},${hp.y.toFixed(2)},${hp.z.toFixed(2)})`);
		console.log(`[flight] step=${step} ${parts.join(' ')}`);
	}
	occupants.forEach((o, k) => {
		pollOccupantRestraint(o);
		updateOccupantActive(o, runtimes[k], 1 / 60, ctx);
		if (o.ejected && ejectStep[k] === -1) {
			ejectStep[k] = step;
			const hv = o.parts.head.body.getLinearVelocity();
			headSpeedAtEject[k] = Math.hypot(hv.x - cv.x, hv.y - cv.y, hv.z - cv.z);
		}
		if (o.ejected) peakSep[k] = Math.max(peakSep[k], pelvisDist(o));
	});
}

console.log(`[result] peakChassisDecelG=${peakDecelG.toFixed(1)}`);
occupants.forEach((o, k) => {
	console.log(
		`[result] ${o.seatKey}: ejected=${o.ejected} ejectStep=${ejectStep[k]} relHeadSpeedAtEject=${headSpeedAtEject[k].toFixed(2)} peakSep=${peakSep[k].toFixed(2)}`,
	);
});
console.log(`[result] windshieldPane=${sim.vehicle.glass.windshield.shape === null ? 'DESTROYED' : 'ALIVE'}`);

for (const o of occupants) teardownOccupant(o);
for (const p of pans) teardownSeatPan(p);
sim.destroy();
