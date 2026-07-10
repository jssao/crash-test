// SPDX-License-Identifier: MIT
//
// Crush M2 gate (crush-architecture.md §A step 2): the yield mechanic makes structural crush
// MECHANICAL -- the front segment chain + plastically-retreating crush cores (vehicle/segments.ts
// stepSegmentYield) genuinely shorten under a crash and STAY shortened, with depth staged by impact
// energy. This test asserts the load-bearing claims against the reference bands
// (docs/build-log/specs/crash-deformation-reference.md):
//   1. STAGED, MONOTONIC frontal crush: 40/56/64/80/120 km/h rigid-barrier depths land in the
//      reference bands, monotonic in speed, clamped at the structural budget (~0.58m).
//   2. TIERED structure: beam yields deepest, then front cells, then rear cells, cradle least
//      (staged resistance), all PERMANENT (stable after the wreck settles).
//   3. INTRUSION: the cradle's plastic shift toward the firewall grows with speed and stays under
//      the FMVSS-208-inspired 0.15m leg-injury line through 120km/h.
//   4. OFFSET ASYMMETRY (IIHS moderate-overlap style): a 40%-overlap barrier collapses ONLY the
//      struck side -- struck half-core retreats, struck rail cells shorten, intact side unmoved.
//   5. NO FALSE CRUSH: a frontal crash leaves the REAR chain untouched (the momentum surge of the
//      light welded rear bodies must not read as crush -- the directional gate + contact-evidence
//      latch), and plain hard driving yields nothing at all.
//   6. RESET heals all plastic state (in-place resetVehicle path).
// Measured baseline (2026-07-10, calibration run): frontal mech crush 0.247 / 0.382 / 0.456 /
// 0.542 / 0.580; intrusion 0 / 0 / 0.016 / 0.102 / 0.140; offset pos=0.356 neg=0.000.
import { describe, expect, it } from 'vitest';
import { createCrashRealismSim } from './crash-realism-harness.mjs';

/** Frontal rigid-barrier run; returns the segment telemetry after the wreck settles + a stability
 * re-read 60 steps later (plasticity must hold, not creep). */
async function frontal(speedKmh) {
	const sim = await createCrashRealismSim();
	try {
		sim.spawnWall(10);
		sim.crashFrontal(speedKmh);
		sim.settle(300);
		const t = sim.damageTelemetry().segments;
		sim.settle(60);
		const later = sim.damageTelemetry().segments;
		return { t, later };
	} finally {
		sim.destroy();
	}
}

describe('crush M2: mechanical segment yield (segments.ts stepSegmentYield)', () => {
	it('frontal mechanical crush is staged by speed: in reference bands, monotonic, clamped, permanent', async () => {
		// Reference bands (crash-deformation-reference.md, mech realization; 56 interpolated between
		// the 40 and 64 rows -- the NHTSA full-frontal speed the lab protocol runs).
		const bands = [
			{ speed: 40, min: 0.18, max: 0.35 },
			{ speed: 56, min: 0.33, max: 0.47 },
			{ speed: 64, min: 0.38, max: 0.52 },
			{ speed: 80, min: 0.45, max: 0.56 },
			{ speed: 120, min: 0.5, max: 0.58 },
		];
		const results = [];
		for (const b of bands) {
			const { t, later } = await frontal(b.speed);
			results.push({ ...b, t, later });
		}
		console.log(
			`[segment-yield] frontal mech crush: ${results.map((r) => `${r.speed}=${r.t.frontCrushM.toFixed(3)}`).join(' ')} intrusion: ${results.map((r) => `${r.speed}=${r.t.intrusionM.toFixed(3)}`).join(' ')}`,
		);
		for (const r of results) {
			// In-band.
			expect(r.t.frontCrushM, `${r.speed}km/h crush in band`).toBeGreaterThanOrEqual(r.min);
			expect(r.t.frontCrushM, `${r.speed}km/h crush in band`).toBeLessThanOrEqual(r.max);
			// PERMANENT: unchanged (within mm) 1s after the wreck settled -- a plastic set, not a spring.
			expect(Math.abs(r.later.frontCrushM - r.t.frontCrushM), `${r.speed}km/h permanence`).toBeLessThan(0.005);
			// NO FALSE REAR CRUSH in a frontal (the rear chain was never touched).
			expect(r.t.rearCrushM, `${r.speed}km/h rear untouched`).toBeLessThan(0.02);
			expect(r.t.weldCrushM.rearL, `${r.speed}km/h rearL weld pristine`).toBe(0);
			expect(r.t.weldCrushM.rearR, `${r.speed}km/h rearR weld pristine`).toBe(0);
			// Clean protocol runs never tear a segment off.
			expect(r.t.tornWelds, `${r.speed}km/h no tears`).toEqual([]);
		}
		// Monotonic in speed.
		for (let i = 1; i < results.length; i++) {
			expect(results[i].t.frontCrushM, `monotonic ${results[i - 1].speed}->${results[i].speed}`).toBeGreaterThan(results[i - 1].t.frontCrushM - 1e-6);
		}
		// STAGED RESISTANCE tiering at the deep end: beam >= front cells >= rear cells >= cradle > 0.
		const w = results[results.length - 1].t.weldCrushM;
		expect(w.beam).toBeGreaterThanOrEqual(w.cellFL - 1e-6);
		expect(w.cellFL).toBeGreaterThanOrEqual(w.cellRL - 1e-6);
		expect(w.cellRL).toBeGreaterThanOrEqual(w.cradle - 1e-6);
		expect(w.cradle).toBeGreaterThan(0.05); // densification: the engine cradle genuinely moved
		// INTRUSION: grows with speed, under the 0.15m leg-injury line through 120.
		expect(results[4].t.intrusionM).toBeGreaterThan(results[2].t.intrusionM);
		expect(results[4].t.intrusionM).toBeGreaterThan(0.08);
		expect(results[4].t.intrusionM).toBeLessThan(0.15);
	});

	it('a 64km/h 40%-overlap (IIHS moderate style) crash shortens ONLY the struck side', async () => {
		const sim = await createCrashRealismSim();
		try {
			// Barrier covers x 0.19..1.01 -- 40% of the ~1.94m width from the +x edge, never crossing
			// the centerline (an overlap barrier that clips the far half-core symmetrizes the crash).
			sim.spawnOffsetWall(10, 0.6, 0.41);
			sim.crashFrontal(64);
			sim.settle(300);
			const t = sim.damageTelemetry().segments;
			console.log(
				`[segment-yield] offset64 core pos=${t.coreRetreatFrontM.pos.toFixed(3)} neg=${t.coreRetreatFrontM.neg.toFixed(3)} cells struck=${t.weldCrushM.cellFL.toFixed(3)}/${t.weldCrushM.cellRL.toFixed(3)} intact=${t.weldCrushM.cellFR.toFixed(3)}/${t.weldCrushM.cellRR.toFixed(3)}`,
			);
			// Struck (+x) half-core collapses deeply; intact (-x) face never moves.
			expect(t.coreRetreatFrontM.pos).toBeGreaterThan(0.2);
			expect(t.coreRetreatFrontM.neg).toBeLessThan(0.02);
			// Struck-side rail cells mechanically shortened; intact side pristine (the lab's
			// struck-vs-intact TOP-view asymmetry, as rest-pose truth).
			expect(t.weldCrushM.cellFL).toBeGreaterThan(0.1);
			expect(t.weldCrushM.cellFR).toBeLessThan(0.02);
			expect(t.weldCrushM.cellRR).toBeLessThan(0.02);
			// Total crush still lands in the 64km/h band (the struck side carries it).
			expect(t.frontCrushM).toBeGreaterThanOrEqual(0.38);
			expect(t.frontCrushM).toBeLessThanOrEqual(0.52);
		} finally {
			sim.destroy();
		}
	});

	it('hard braking from speed yields NOTHING (below the crash gate; no contact evidence)', async () => {
		const sim = await createCrashRealismSim();
		try {
			sim.crashFrontal(120); // launch at speed, no wall
			for (let i = 0; i < 240; i++) sim.step({ throttle: 0, brake: 1, steer: 0, handbrake: false });
			const t = sim.damageTelemetry().segments;
			expect(t.frontCrushM).toBeLessThan(0.02);
			expect(t.rearCrushM).toBeLessThan(0.02);
			for (const v of Object.values(t.weldCrushM)) expect(v).toBe(0);
			expect(t.coreRetreatM.front).toBe(0);
			expect(t.coreRetreatM.rear).toBe(0);
		} finally {
			sim.destroy();
		}
	});

	it('the in-place reset (resetVehicle) heals all plastic state', async () => {
		const sim = await createCrashRealismSim();
		try {
			sim.spawnWall(10);
			sim.crashFrontal(80);
			sim.settle(300);
			expect(sim.damageTelemetry().segments.frontCrushM).toBeGreaterThan(0.4);
			sim.crashFrontal(0); // crashSetup(0) -> resetVehicle + zero velocity
			sim.settle(60);
			const t = sim.damageTelemetry().segments;
			expect(t.frontCrushM).toBeLessThan(0.02);
			expect(t.coreRetreatM.front).toBe(0);
			expect(t.coreRetreatFrontM.pos).toBe(0);
			expect(t.coreRetreatFrontM.neg).toBe(0);
			for (const v of Object.values(t.weldCrushM)) expect(v).toBe(0);
			expect(t.intrusionM).toBe(0);
		} finally {
			sim.destroy();
		}
	});
});
