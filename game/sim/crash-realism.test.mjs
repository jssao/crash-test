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
import { panelDirectionalFactor } from '../src/damage/welds.ts';
import { PANEL_VULNERABILITY } from '../src/damage/damage-tuning.ts';

const brokenList = (states) => Object.entries(states).filter(([, s]) => s === 'broken').map(([k]) => k);
const doorsBroken = (states) => ['doorL', 'doorR'].filter((k) => states[k] === 'broken');
const doorsTouched = (states) => ['doorL', 'doorR'].filter((k) => states[k] !== 'attached');

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
			expect(r.states.hatch).toBe('attached');
		}
	}, 40000);

	it('a strong SIDE impact DOES detach a door (lateral load, not frontal)', async () => {
		const sim = await createCrashRealismSim();
		try {
			sim.spawnSideWall(0.93); // wall ~3cm outboard of the right flank
			sim.crashSideways(130); // extreme side closing speed -- door detachment is an extreme-event outcome
			sim.settle(300);
			const dt = sim.damageTelemetry();
			console.log(`[realism] SIDE 130km/h broken=[${brokenList(dt.panelStates)}] states=${JSON.stringify(dt.panelStates)}`);
			expect(doorsBroken(dt.panelStates).length).toBeGreaterThanOrEqual(1);
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
		expect(r40.crush).toBeGreaterThan(0.15);
		expect(r40.crush).toBeLessThan(0.35);
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
			sim.spawnOffsetWall(10, 1.1, 1.6); // barrier offset to the right, ~40% overlap
			sim.crashFrontal(40);
			sim.settle(300);
			const dt = sim.damageTelemetry();
			const ext = sim.dentLateralExtent();
			const c = sim.crushDepth();
			console.log(`[realism] OFFSET 40km/h crush=${c.rearZ.toFixed(3)} dentL=${ext.left.toFixed(2)} dentR=${ext.right.toFixed(2)} states=${JSON.stringify(dt.panelStates)}`);
			expect(c.rearZ).toBeGreaterThan(0.12); // real crush on the struck corner
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
				sim.spawnOffsetWall(10, 1.1, 1.6);
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
