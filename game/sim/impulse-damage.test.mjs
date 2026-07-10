// SPDX-License-Identifier: MIT
//
// Mass-aware damage acceptance (the user's "2kg plank at 30km/h reads like a wall" case). Proves the
// damage system now weights every APPROACH-SPEED-driven car-damage contribution (plastic-crumple depth
// + accumulated weld stress) by the OTHER body's effective mass ratio e = m_other/(m_other+m_car):
//
//   - A light fence plank (2kg) transmits e ~= 0.0014 of a wall's crush/stress at the same closing
//     speed -> driving THROUGH a fence line at 60km/h leaves the car pristine (0 panels loosened, dents
//     far under 10% of a wall hit) while still scattering the fence.
//   - A solid WALL is a STATIC body (no registered foreign mass) -> e = 1 exactly -> crush/stress are
//     bit-identical to the pre-mass-aware code. The full pre-existing crash-realism + damage suites
//     staying byte-green (crush 0.193/0.439/0.532/0.580m, dented=27 @ moderate) is the standing
//     regression proof of "wall/tree/ground behavior unchanged EXACTLY"; this file additionally records
//     the wall-hit numbers and asserts the plank-vs-wall distinction directly.
//
// The solver-driven triggers (direct weld constraint-force spike + wheel-detach force test) were left
// untouched -- they already read the real mass-aware contact response out of the solver, so a light
// body already fails to spike them; only the approach-speed heuristics needed the explicit weighting.
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';
import { spawnFenceLine, destroyFenceLine, crashSetup } from '../src/damage/scenario.ts';
import { setForeignMass } from '../src/damage/system.ts';
import { massAwareDamageFactor } from '../src/damage/welds.ts';

const NEUTRAL = { throttle: 0, brake: 0, steer: 0, handbrake: false };
const CRASH_KMH = 60;

function loosenedOrBroken(dt) {
	return Object.values(dt.panelStates).filter((s) => s !== 'attached').length;
}

/** Coast the car into a solid static wall at CRASH_KMH and return its post-crash telemetry -- the
 * "heavy obstacle" reference (static body -> e = 1 -> unchanged pre-mass-aware behavior). */
async function runWallHit() {
	const sim = await createDamageSim();
	try {
		sim.spawnWall(6);
		sim.crash(CRASH_KMH);
		for (let i = 0; i < 180; i++) sim.step(NEUTRAL);
		return sim.damageTelemetry();
	} finally {
		// leave native handles to GC with the sim; no cross-test state kept
	}
}

/** Coast the car THROUGH a registered light fence line at CRASH_KMH; returns telemetry + how far the
 * pickets were scattered (max displacement from their spawn position). */
async function runFenceDriveThrough() {
	const sim = await createDamageSim();
	const planks = spawnFenceLine(sim.world, sim.vehicle, { distanceAhead: 8, plankCount: 15, spanWidth: 6, plankMassKg: 2, firstEntityId: 1000 });
	for (const p of planks) setForeignMass(sim.damage, p.entityId, p.massKg);

	sim.crash(CRASH_KMH);
	for (let i = 0; i < 180; i++) sim.step(NEUTRAL);

	const dt = sim.damageTelemetry();
	let maxScatter = 0;
	for (const p of planks) {
		const pos = p.body.getPosition();
		const d = Math.hypot(pos.x - p.spawnPos.x, pos.y - p.spawnPos.y, pos.z - p.spawnPos.z);
		if (d > maxScatter) maxScatter = d;
	}
	destroyFenceLine(planks);
	return { dt, maxScatter };
}

describe('impulse-damage: mass-aware car damage', () => {
	it('massAwareDamageFactor: static/unknown -> 1, light body -> tiny e, matches the reference numbers', () => {
		const carMassKg = 1438; // ~ createVehicle()'s chassis+wheels+panels total (probed)
		// Static / unknown other body -> effectively infinite mass -> full damage, byte-identical path.
		expect(massAwareDamageFactor(undefined, carMassKg)).toBe(1);
		expect(massAwareDamageFactor(0, carMassKg)).toBe(1); // a static body's mass reads 0 -> still 1
		expect(massAwareDamageFactor(-5, carMassKg)).toBe(1); // defensive: nonsense mass -> 1
		// Light bodies: the objective's worked examples. 2.7kg brick ~= 0.002; a plank is far under 1.
		expect(massAwareDamageFactor(2.7, carMassKg)).toBeCloseTo(0.00187, 4);
		expect(massAwareDamageFactor(2, carMassKg)).toBeLessThan(0.01);
		// A same-mass collider would split damage evenly (sanity anchor on the formula).
		expect(massAwareDamageFactor(carMassKg, carMassKg)).toBeCloseTo(0.5, 6);
	});

	it('driving through a fence line at 60km/h leaves the car pristine but scatters the fence', async () => {
		const wall = await runWallHit();
		const wallDented = wall.dentedVertexCount;
		const wallDisturbed = loosenedOrBroken(wall);
		console.log(`[impulse-damage] WALL @${CRASH_KMH}km/h: dentedVertexCount=${wallDented} panelStates=${JSON.stringify(wall.panelStates)}`);

		const { dt: fence, maxScatter } = await runFenceDriveThrough();
		console.log(`[impulse-damage] FENCE @${CRASH_KMH}km/h: dentedVertexCount=${fence.dentedVertexCount} panelStates=${JSON.stringify(fence.panelStates)} maxScatter=${maxScatter.toFixed(2)}m`);

		// The wall reference must itself be a real, substantial crash (otherwise "<10% of it" is vacuous).
		// Measured on this chassis: 49 dented vertices + hood broken at 60km/h; floor at 40 leaves margin
		// without over-fitting the exact count.
		expect(wallDented).toBeGreaterThanOrEqual(40);
		expect(wallDisturbed).toBeGreaterThanOrEqual(1);

		// ACCEPTANCE: fence drive-through loosens/breaks ZERO panels...
		expect(loosenedOrBroken(fence)).toBe(0);
		// ...and dents far under 10% of the wall hit at the same speed (cosmetic scuffs at most)...
		expect(fence.dentedVertexCount).toBeLessThan(0.1 * wallDented);
		// ...while the fence itself is genuinely plowed through and scattered (car didn't just stop short).
		expect(maxScatter).toBeGreaterThan(0.5);
	});

	it('plank-vs-wall: the SAME closing speed produces categorically different car damage', async () => {
		const wall = await runWallHit();
		const { dt: fence } = await runFenceDriveThrough();

		// Categorical, not marginal: the wall must dent at least an order of magnitude more, and disturb
		// panels the fence never touches. This is the whole point -- a light body can't read as a wall.
		expect(fence.dentedVertexCount * 10).toBeLessThan(wall.dentedVertexCount);
		expect(loosenedOrBroken(wall)).toBeGreaterThan(loosenedOrBroken(fence));
		expect(loosenedOrBroken(fence)).toBe(0);
		console.log(
			`[impulse-damage] DISTINCTION: wallDented=${wall.dentedVertexCount} fenceDented=${fence.dentedVertexCount} ` +
				`wallDisturbed=${loosenedOrBroken(wall)} fenceDisturbed=${loosenedOrBroken(fence)}`,
		);
	});

	it('a registered light body does NOT attenuate an unrelated static wall hit (opt-in, per-body)', async () => {
		// Registering a fence plank's mass must not leak onto contacts with OTHER bodies: a wall hit in
		// the SAME sim (wall is static, unregistered) stays full-damage. Guards the entity-id keying.
		const sim = await createDamageSim();
		setForeignMass(sim.damage, 1000, 2); // register a light body id that is never actually spawned
		sim.spawnWall(6);
		sim.crash(CRASH_KMH);
		for (let i = 0; i < 180; i++) sim.step(NEUTRAL);
		const dt = sim.damageTelemetry();
		console.log(`[impulse-damage] WALL with an unrelated light-body registration: dentedVertexCount=${dt.dentedVertexCount} panelStates=${JSON.stringify(dt.panelStates)}`);
		expect(dt.dentedVertexCount).toBeGreaterThanOrEqual(40);
		expect(loosenedOrBroken(dt)).toBeGreaterThanOrEqual(1);
	});
});
