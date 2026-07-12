// SPDX-License-Identifier: MIT
//
// Reference-driven crash-realism matrix (docs/build-log/specs/crash-deformation-reference.md). Judges
// the damage model against real crash-test behaviour on three axes:
//   (1) DIRECTION-AWARE welds  -- doors NEVER break/loosen in a frontal or offset-frontal impact at
//       ANY speed (FMVSS-206: door separation is a lateral / rollover / complex-loading event, not a
//       clean frontal), but a strong SIDE impact DOES detach a door -- proving the model discriminates
//       direction, not just "doors never break".
//   (2) CRUSH DEPTH scales with closing speed (a 40 km/h tap caves the nose in visibly less than an
//       80 km/h hit) and caves INWARD (the pre-fix model bulged the nose outward -- see crumple.ts).
//   (3) OFFSET front-right concentrates crush on the struck side.
// Measured numbers backing each band are in the console output; see crash-realism-harness.mjs.
import { describe, expect, it } from 'vitest';
import { createCrashRealismSim } from './crash-realism-harness.mjs';
import { panelDirectionalFactor, doorLateralFraction } from '../src/damage/welds.ts';
import { PANEL_VULNERABILITY } from '../src/damage/damage-tuning.ts';

const brokenList = (states) => Object.entries(states).filter(([, s]) => s === 'broken').map(([k]) => k);
// S90 swap 2026-07-11: extended to all 4 doors (front + rear) -- rear doors carry the identical
// lateral-only PANEL_VULNERABILITY as the front doors (damage-tuning.ts), so a frontal must leave ALL
// 4 attached and a genuine side impact may legitimately detach a rear door too (the door-centred side
// wall below spans chassis-local z in [-1.2, 1.2], which now geometrically overlaps the S90's rear
// door z~-0.62 as well as the front door z~0.34 -- see spawnSideWall()'s doc comment).
const ALL_DOORS = ['doorL', 'doorR', 'doorRL', 'doorRR'];
const doorsBroken = (states) => ALL_DOORS.filter((k) => states[k] === 'broken');
const doorsTouched = (states) => ALL_DOORS.filter((k) => states[k] !== 'attached');

async function frontal(speed, steps = 300) {
	const sim = await createCrashRealismSim();
	try {
		sim.spawnWall(10);
		sim.crashFrontal(speed);
		sim.settle(steps);
		const dt = sim.damageTelemetry();
		const c = sim.crushDepth();
		return { states: dt.panelStates, crush: c.rearZ, deep: c.deep, dented: dt.dentedVertexCount };
	} finally {
		sim.destroy();
	}
}

describe('crash-realism: direction-aware welds', () => {
	// --- Unit-level proof of the mechanism, fully deterministic (no physics) ---
	it('directional factor: doors are lateral-only, hood is frontal-weak', () => {
		const frontalDir = { x: 0, y: 0, z: 1 }; // nose impact: +Z in chassis-local
		const sideDir = { x: 1, y: 0, z: 0 }; // side impact: +X
		// Hood takes ~full stress from a frontal hit (it buckles/tears -- kept as-is).
		expect(panelDirectionalFactor(PANEL_VULNERABILITY.hood, frontalDir)).toBeCloseTo(1, 5);
		// Doors take ~zero from a frontal hit ...
		expect(panelDirectionalFactor(PANEL_VULNERABILITY.doorL, frontalDir)).toBeLessThan(0.01);
		expect(panelDirectionalFactor(PANEL_VULNERABILITY.doorR, frontalDir)).toBeLessThan(0.01);
		// ... but ~full stress from a lateral (side) hit -- so a real side impact still tears them off.
		expect(panelDirectionalFactor(PANEL_VULNERABILITY.doorR, sideDir)).toBeCloseTo(1, 5);
		expect(panelDirectionalFactor(PANEL_VULNERABILITY.doorL, sideDir)).toBeCloseTo(1, 5);
		// A door with a little incidental yaw in a frontal (dir.x ~ 0.3) still gets almost nothing.
		expect(panelDirectionalFactor(PANEL_VULNERABILITY.doorR, { x: 0.3, y: 0, z: 0.95 })).toBeLessThan(0.05);
	});

	it('NO door breaks or even loosens in a frontal crash at 40/64/80/120 km/h', async () => {
		for (const speed of [40, 64, 80, 120]) {
			const r = await frontal(speed);
			console.log(`[realism] FRONTAL ${speed}km/h crush=${r.crush.toFixed(3)}m states=${JSON.stringify(r.states)}`);
			expect(doorsTouched(r.states)).toEqual([]); // doorL/doorR both still fully 'attached'
			expect(r.states.trunk).toBe('attached');
		}
	}, 40000);

	it('a strong SIDE impact DOES detach a door (lateral load, not frontal)', async () => {
		const sim = await createCrashRealismSim();
		try {
			sim.spawnSideWall(1.1); // short door-centred barrier at the +X flank (Mustang half-width ~0.97m)
			sim.crashSideways(130); // extreme side closing speed -- door detachment is an extreme-event outcome
			sim.settle(300);
			const dt = sim.damageTelemetry();
			console.log(`[realism] SIDE 130km/h broken=[${brokenList(dt.panelStates)}] states=${JSON.stringify(dt.panelStates)}`);
			expect(doorsBroken(dt.panelStates).length).toBeGreaterThanOrEqual(1);
		} finally {
			sim.destroy();
		}
	}, 20000);

	// C3b (2026-07-12): a real side-struck door JAMS SHUT and caves -- it does not swing open on its
	// hinge (springing/swinging free is a FRONTAL/oblique phenomenon, not a squarely lateral one -- see
	// damage-tuning.ts's DOOR_SPRUNG_LATERAL_FRACTION_MAX doc comment). Guards the fix: a moderate
	// side-mdb-style impact (50 km/h, matching the crash lab's side-mdb-50 protocol -- same proxy
	// side-fidelity.test.mjs's harness test already uses) must never show ANY door as 'sprung'.
	it('doorLateralFraction: predominantly-lateral accumulated stress reads high, predominantly-oblique reads low', () => {
		expect(doorLateralFraction({ stress: 0, lateralStressWeighted: 0 })).toBe(0);
		expect(doorLateralFraction({ stress: 100, lateralStressWeighted: 95 })).toBeCloseTo(0.95, 5);
		expect(doorLateralFraction({ stress: 100, lateralStressWeighted: 30 })).toBeCloseTo(0.3, 5);
	});

	it('a MODERATE side impact (50 km/h, side-mdb-50 style) jams doors instead of springing them open', async () => {
		const sim = await createCrashRealismSim();
		try {
			sim.spawnSideWall(1.05); // matches side-fidelity.test.mjs's side-mdb-50 harness proxy
			sim.crashSideways(50); // side-mdb-50's own closing speed
			sim.settle(300);
			const dt = sim.damageTelemetry();
			console.log(`[realism] SIDE-MDB-50 states=${JSON.stringify(dt.panelStates)}`);
			// PRE-FIX (measured in the real crash lab, verify/side-fidelity/side-fidelity-measurements.json
			// before this slice): the struck-side doors (doorL/doorRL) read 'sprung' at settle -- the bug
			// this slice fixes. POST-FIX: no door may ever read 'sprung' here -- a predominantly-lateral
			// impact either jams (loosened) or, if severe enough, tears the door off outright (broken),
			// but never swings it open on the hinge.
			const sprungDoors = ALL_DOORS.filter((k) => dt.panelStates[k] === 'sprung');
			expect(sprungDoors).toEqual([]);
			// Real damage still lands somewhere (not a silent no-op fix) -- at least one door shows
			// jammed/caved (loosened) or torn off (broken), not pristine 'attached'.
			expect(doorsTouched(dt.panelStates).length).toBeGreaterThanOrEqual(1);
		} finally {
			sim.destroy();
		}
	}, 20000);
});

describe('crash-realism: crush depth scales with speed and caves inward', () => {
	it('nose crush is monotonic 40<64<80 and lands in the per-class bands', async () => {
		const r40 = await frontal(40);
		const r64 = await frontal(64);
		const r80 = await frontal(80);
		const r120 = await frontal(120);
		console.log(`[realism] crush curve: 40=${r40.crush.toFixed(3)} 64=${r64.crush.toFixed(3)} 80=${r80.crush.toFixed(3)} 120=${r120.crush.toFixed(3)}`);
		// Inward crush present and speed-scaled (bands from crash-deformation-reference.md).
		// S90 SWAP RECALIBRATION (2026-07-11): lower bound 0.15 -> 0.08 (this floor's history: 0.15 ->
		// 0.08 -> 0.095 -- see the file's own note). That weakening was measured against 40km/h crush of
		// ~0.102m at the time.
		//
		// PHASE R RE-MASS/CRASH-PULSE CALIBRATION (2026-07-12): 40km/h crush is now measured at 0.164m --
		// the mass re-derivation (tuning.ts CHASSIS_MASS_KG) and the R3 crash-pulse recess fix (segments.ts
		// CORE_STAGE_DECEL_MS2 doc comment) between them restored the low-speed dent back toward the
		// reference's original 0.18-0.35m band without any direct CRUMPLE_* retune (damage-tuning.ts's
		// crumple magnitude constants are UNCHANGED this pass -- verified unnecessary: the measured value
		// already lands mid-band). Floor tightened 0.08 -> 0.14 (comfortably below the measured 0.164,
		// restoring most of the honest margin the swap-era weakening gave up) and the ceiling tightened
		// 0.35 -> 0.3, matching this pass's own ~0.15-0.3m target -- the previously-flagged jitter/density
		// interaction (S90's denser mesh making CRUMPLE_JITTER_FRACTION mesh-frequency-visible) no longer
		// dominates this statistic at the new, deeper baseline reading.
		expect(r40.crush).toBeGreaterThan(0.14);
		expect(r40.crush).toBeLessThan(0.3);
		expect(r64.crush).toBeGreaterThan(r40.crush + 0.08); // clearly deeper than 40
		expect(r64.crush).toBeGreaterThan(0.32);
		expect(r80.crush).toBeGreaterThan(r64.crush); // deeper still
		expect(r80.crush).toBeGreaterThan(0.42);
		// 120 is in the saturation band (near the absolute clamp), not necessarily deeper than 80.
		expect(r120.crush).toBeGreaterThan(0.42);
		expect(r80.crush).toBeLessThanOrEqual(0.58 + 1e-6); // never past the chassis clamp
	}, 40000);
});

describe('crash-realism: offset front-right concentrates crush on the struck side', () => {
	it('a 40 km/h front-right offset dents the right front, not the left', async () => {
		const sim = await createCrashRealismSim();
		try {
			sim.spawnOffsetWall(10, 1.55, 1.2); // barrier at the +X front corner (inner edge ~+0.35m, Mustang half-width ~0.97m)
			sim.crashFrontal(40);
			sim.settle(300);
			const dt = sim.damageTelemetry();
			const ext = sim.dentLateralExtent();
			const c = sim.crushDepth();
			console.log(`[realism] OFFSET 40km/h crush=${c.rearZ.toFixed(3)} dentL=${ext.left.toFixed(2)} dentR=${ext.right.toFixed(2)} states=${JSON.stringify(dt.panelStates)}`);
			// RECALIBRATED 0.12 -> 0.095 (coherent-crease-noise fix, 2026-07-11): this floor asserts a
			// MAX-single-vertex dent; the old per-vertex-index jitter statistically guaranteed a +25%
			// outlier right at the deepest vertex, while the coherent fixed-wavelength noise (crumple.ts
			// coherentCreaseNoise -- the "grocery bag wrinkle" playtest fix) can legitimately put the whole
			// deep region slightly under 1.0x. The underlying crush FIELD is unchanged (measured 0.107 here
			// vs 0.13-0.14 before; a dead mechanism reads ~0.03-0.05, so the floor stays falsifiable).
			//
			// PHASE R RE-MASS/CRASH-PULSE CALIBRATION (2026-07-12): re-measured at 0.224m (same re-mass +
			// R3 recess fix as the frontal test above, no CRUMPLE_* change). Tightened 0.095 -> 0.15,
			// comfortably below the measured value while restoring most of the honest margin.
			expect(c.rearZ).toBeGreaterThan(0.15); // real crush on the struck corner
			expect(ext.right).toBeGreaterThan(ext.left + 0.3); // concentrated on the struck (right) side
			expect(doorsBroken(dt.panelStates)).toEqual([]); // struck door jams but stays attached
		} finally {
			sim.destroy();
		}
	}, 20000);

	it('a 64/80 km/h offset still keeps both doors attached (jammed, not detached)', async () => {
		for (const speed of [64, 80]) {
			const sim = await createCrashRealismSim();
			try {
				sim.spawnOffsetWall(10, 1.55, 1.2);
				sim.crashFrontal(speed);
				sim.settle(300);
				const dt = sim.damageTelemetry();
				console.log(`[realism] OFFSET ${speed}km/h states=${JSON.stringify(dt.panelStates)}`);
				expect(doorsBroken(dt.panelStates)).toEqual([]);
			} finally {
				sim.destroy();
			}
		}
	}, 30000);
});
