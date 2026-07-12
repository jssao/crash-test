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
		//
		// PHASE R CRASH-PULSE RECALIBRATION (2026-07-12): every band shifted by a uniform +0.05m. ROOT
		// CAUSE of the R3 debt (lab NHTSA-56 chassisPeakDecelG measured 91.7g, target [35,55]g): the
		// crush core (vehicle/geometry.ts's CRUSH_CORE_INITIAL_RECESS_M) is a shape mounted DIRECTLY ON
		// THE CHASSIS body, recessed only 0.1m behind the segments' pristine nose position. At NCAP
		// closing speed (15.56 m/s) that 0.1m is traversed in under one fixed step (~6.4ms of a 16.7ms
		// step), so the chassis's own rigid core reaches the wall and takes a near-instantaneous, near-
		// total velocity kill (the plastic-retreat bookkeeping only updates AFTER world.step() resolves
		// that step's contact, so the FIRST contact is always against a not-yet-retreated, effectively
		// rigid face).
		//
		// FIX part 1: widened CRUSH_CORE_INITIAL_RECESS_M 0.1 -> 0.15m, giving the compliant segment
		// chain (its own soft welds, tuning.ts TIER_WELD_HERTZ) real additional distance/time to shed
		// speed before the chassis's rigid core engages. Measured directly (56km/h, raw per-step
		// metric): peak decel 88.8g -> 47.1g in this sim rig. CAVEAT discovered while closing the LAB
		// side of the same debt (src/lab/instrumentation.ts's ChassisDecelTracker doc carries the full
		// story): the sharp 0.13/0.14 -> 0.15 threshold in that sweep is largely contact-TOI SAMPLING
		// PHASE (whether the 1-2-step solver stop's big velocity bin straddles a fixed-step boundary),
		// not pure compliance -- which is why the headline lab metric was ALSO de-aliased to a 2-step
		// windowed measurement (FIX part 2, instrumentation.ts). The recess widening itself remains
		// real, kept, and is what the crush-depth arithmetic below keys off.
		//
		// SIDE EFFECT (and its fix): the recess is an ADDITIVE offset baked into every reported depth
		// (frontCrushM = recess + retreat, once retreat's ramp-in completes) -- verified by direct
		// measurement that the WHOLE crush-vs-speed curve translates by *exactly* the +0.05m recess
		// delta (40: 0.256->0.306, 56: 0.388->0.438, 64: 0.461->0.511, 80: 0.544->0.594, 120:
		// 0.580->0.630 -- all +0.050 to 3 decimal places), so CORE_STAGE_DECEL_MS2's depth thresholds
		// (segments.ts) and every hardcoded RATCHET_ZONE_START_M literal were shifted by the same +0.05m
		// to preserve the ORIGINAL retreat-budget-per-stage and carry-along-onset physics exactly (only
		// beam/rearL/rearR, which already reference CRUSH_CORE_INITIAL_RECESS_M directly, auto-tracked).
		// This is why the bands below are the OLD bands + 0.05m rather than independently re-fitted --
		// the underlying ordering/ratios/shape the reference doc asks for (crash-deformation-reference.md)
		// are unchanged, only the absolute game-scale numbers shift by the documented, measured amount.
		// 120's band gets +0.01m extra headroom (0.63 -> 0.64) since the measured value (0.630) landed
		// within 1mm of a bare +0.05 shift -- not a knife-edge worth re-tuning further.
		const bands = [
			{ speed: 40, min: 0.23, max: 0.4 },
			{ speed: 56, min: 0.38, max: 0.52 },
			{ speed: 64, min: 0.43, max: 0.57 },
			{ speed: 80, min: 0.5, max: 0.61 },
			{ speed: 120, min: 0.55, max: 0.64 },
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
			// Total crush still lands in the 64km/h band (the struck side carries it). PHASE R (2026-07-12):
			// shifted +0.05m with the frontal band above (same CRUSH_CORE_INITIAL_RECESS_M widening).
			expect(t.frontCrushM).toBeGreaterThanOrEqual(0.43);
			expect(t.frontCrushM).toBeLessThanOrEqual(0.57);
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
