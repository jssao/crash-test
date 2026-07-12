// SPDX-License-Identifier: MIT
//
// EXTREME TIER matrix (Stream C slice C2, docs/loom/2026-07-11-s90-swap-plan.md "Stream C condition"
// + docs/build-log/specs/crash-deformation-reference.md): 100/120/200mph (161/193/322 km/h) frontal
// rigid-barrier crashes must deform WAY past the game's NCAP-class 0.58m crush cap -- crush to the
// A-pillar at 100mph, cabin collapse + wheels torn by 120mph, near-total destruction by 200mph -- via
// the ADDITIVE, speed-gated extreme tier (damage-tuning.ts's chassisSpeedCrushCapM(), segments.ts's
// coreMaxRetreatFrontM()/segmentCrushCapM(), structuralCrush.ts's cabin-extension field). The second
// describe block below is the HARD GUARD: every ≤80 km/h crash in the existing calibrated matrix
// must measure BYTE-IDENTICAL to its pre-extreme-tier value (this file pins the exact numbers).
import { describe, expect, it } from 'vitest';
import { createDamageSim } from './damage-harness.mjs';
import { add, rotateVector } from '../src/vehicle/mathUtil.ts';

const EXTREME_SPEEDS_KMH = [161, 193, 322]; // 100mph, ~120mph, ~200mph

async function frontalCrash(speedKmh, { wallDistanceM = 12, settleSteps = 400 } = {}) {
	const sim = await createDamageSim();
	try {
		const wall = sim.spawnWall(wallDistanceM);
		sim.crash(speedKmh);
		for (let i = 0; i < settleSteps; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		const dt = sim.damageTelemetry();
		const wallZ = wall.getPosition().z;
		const chassisZ = sim.vehicle.chassis.getPosition().z;
		return {
			frontCrushM: dt.segments.frontCrushM,
			wheelStates: dt.wheelStates,
			windshieldShattered: sim.vehicle.glass.windshield.shape === null,
			rearWindowShattered: sim.vehicle.glass.rearWindow.shape === null,
			wallZ,
			chassisZ,
			panelStates: dt.panelStates,
		};
	} finally {
		sim.destroy();
	}
}

describe('extreme tier: 161/193/322 km/h frontal', () => {
	it('mechanical front crush is strictly monotonic across tiers and 161 reaches >=1.0m', async () => {
		const results = {};
		for (const speed of EXTREME_SPEEDS_KMH) {
			results[speed] = await frontalCrash(speed);
			console.log(`[extreme-tier] ${speed}km/h frontCrushM=${results[speed].frontCrushM.toFixed(3)} wheels=${JSON.stringify(results[speed].wheelStates)} windshield=${results[speed].windshieldShattered}`);
		}
		expect(results[161].frontCrushM).toBeGreaterThanOrEqual(1.0);
		expect(results[193].frontCrushM).toBeGreaterThan(results[161].frontCrushM);
		expect(results[322].frontCrushM).toBeGreaterThan(results[193].frontCrushM);
		// Comfortably past the old 0.58m NCAP clamp at every extreme tier.
		for (const speed of EXTREME_SPEEDS_KMH) expect(results[speed].frontCrushM).toBeGreaterThan(0.58);
	}, 60000);

	it('windshield shatters at 161+ km/h (mech-crush-coupled, WINDSHIELD_SHATTER_FRONT_CRUSH_M)', async () => {
		for (const speed of EXTREME_SPEEDS_KMH) {
			const r = await frontalCrash(speed);
			expect(r.windshieldShattered).toBe(true);
		}
	}, 60000);

	it('at least one wheel detaches at 193+ km/h', async () => {
		for (const speed of [193, 322]) {
			const r = await frontalCrash(speed);
			const detached = Object.values(r.wheelStates).filter((s) => s === 'detached');
			console.log(`[extreme-tier] ${speed}km/h wheelStates=${JSON.stringify(r.wheelStates)}`);
			expect(detached.length).toBeGreaterThanOrEqual(1);
		}
	}, 40000);

	it('no wall tunneling: the car never ends up past the wall plane', async () => {
		for (const speed of EXTREME_SPEEDS_KMH) {
			const r = await frontalCrash(speed);
			console.log(`[extreme-tier] ${speed}km/h chassisZ=${r.chassisZ.toFixed(2)} wallZ=${r.wallZ.toFixed(2)}`);
			// The wall's own half-depth is 0.5m (spawnTestWall) -- "short of the wall plane" means the
			// chassis origin stays behind the wall's CENTER, with a margin (a car that reached the wall's
			// center would already have driven its whole front clip + more through the wall's near face).
			expect(r.chassisZ).toBeLessThan(r.wallZ - 0.5);
		}
	}, 60000);

	it('determinism: two runs at 193 km/h produce identical crush/wheel/glass outcomes', async () => {
		const a = await frontalCrash(193);
		const b = await frontalCrash(193);
		expect(a.frontCrushM).toBe(b.frontCrushM);
		expect(a.wheelStates).toEqual(b.wheelStates);
		expect(a.windshieldShattered).toBe(b.windshieldShattered);
		expect(a.chassisZ).toBe(b.chassisZ);
	}, 30000);
});

describe('extreme tier: guard -- 40/64/80 km/h stay byte-identical to the pre-extreme-tier measured values', () => {
	it('40/64/80 km/h frontal mechanical front crush (dt.segments.frontCrushM) is BYTE-IDENTICAL', async () => {
		// PINNED values, measured against this exact harness/scenario with the extreme tier active.
		// PROVEN byte-identical to "no extreme tier at all" by construction, not just by measurement:
		// every extreme-tier helper (damage-tuning.ts's chassisSpeedCrushCapM, segments.ts's
		// coreMaxRetreatFrontM/segmentCrushCapM/coreMaxRetreatStepM, welds.ts's wheel-detach debounce
		// gate) reduces to `x + 0*extra` or an early `return 0`/`return flat` for any peak/approach
		// speed at or under its gate (24 m/s for the crush tiers, 40 m/s for wheel debounce) -- IEEE-754
		// exact identities, not an approximation. Measured peak speed at 40/64/80 km/h is 11.1/17.8/22.2
		// m/s, all comfortably under every gate. VERIFIED empirically too: forcing
		// segments.ts's EXTREME_GATE_SPEED_MS to 1e9 (fully disabling the extreme tier) reproduced these
		// exact same three floats. (NOTE: a naive git-stash-revert comparison of segments.ts is NOT valid
		// here -- that file also carries substantial unrelated, legitimately-uncommitted Phase R re-mass/
		// crash-pulse work from a concurrent slice, which a full-file revert undoes too, producing a
		// false-looking "diff" that has nothing to do with this extreme-tier addition.)
		const r40 = await frontalCrash(40, { wallDistanceM: 10, settleSteps: 300 });
		const r64 = await frontalCrash(64, { wallDistanceM: 10, settleSteps: 300 });
		const r80 = await frontalCrash(80, { wallDistanceM: 10, settleSteps: 300 });
		console.log(`[extreme-tier guard] 40=${r40.frontCrushM.toFixed(6)} 64=${r64.frontCrushM.toFixed(6)} 80=${r80.frontCrushM.toFixed(6)}`);
		expect(r40.frontCrushM).toBe(0.30632897524318664);
		expect(r64.frontCrushM).toBe(0.5108898830363962);
		expect(r80.frontCrushM).toBe(0.5935763075761368);
		expect(r80.frontCrushM).toBeLessThanOrEqual(0.63 + 1e-6); // never past the mechanical core-retreat ceiling
		expect(r40.windshieldShattered).toBe(false);
		expect(r64.windshieldShattered).toBe(false);
		expect(r80.windshieldShattered).toBe(false);
		for (const r of [r40, r64, r80]) {
			expect(Object.values(r.wheelStates).every((s) => s === 'attached')).toBe(true);
			// DOOR SPRUNG guard (Stream C slice C1): the door speed gates (damage-tuning.ts's
			// DOOR_SPRUNG_GATE_MS=40m/s) sit well above every one of these peak speeds (11.1/17.8/22.2
			// m/s) and the accumulated door stress at these speeds never approaches the (also unchanged)
			// stress-path threshold either -- doors must still read fully 'attached' here.
			for (const doorKey of ['doorL', 'doorR', 'doorRL', 'doorRR']) {
				expect(r.panelStates[doorKey]).toBe('attached');
			}
		}
	}, 60000);
});

// ---------------------------------------------------------------------------------------------
// DOOR SPRUNG (Stream C slice C1): doors get a real hinge (RevoluteJoint) instead of tearing off
// outright once their latch fails. See damage/panels.ts's sprungPanelWeld() + damage-tuning.ts's
// DOOR_SPRUNG_GATE_MS doc comment for the mechanism + why the escalation is gated the way it is.
// ---------------------------------------------------------------------------------------------
async function frontalCrashDoors(speedKmh, { wallDistanceM = 12, settleSteps = 400 } = {}) {
	const sim = await createDamageSim();
	try {
		sim.spawnWall(wallDistanceM);
		sim.crash(speedKmh);
		for (let i = 0; i < settleSteps; i++) sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
		const dt = sim.damageTelemetry();
		const chassisT = sim.vehicle.chassis.getTransform();
		const doorDistFromChassis = {};
		for (const key of ['doorL', 'doorR', 'doorRL', 'doorRR']) {
			const panel = sim.vehicle.panels[key];
			const p = panel.body.getPosition();
			// "Distance from the chassis" for a HINGED door means distance from the car's own body, not
			// a straight line to the chassis origin (a point ~0.8-1m from ANY door's rest position on
			// this car, purely from its own width/length -- an origin-relative distance would fail even
			// while perfectly closed). Measure against the door's own hinge anchor instead -- a fixed
			// chassis-local point (panel.localCenter's own edge, see panels.ts's sprungPanelWeld()) that
			// IS rigidly part of the chassis at all times, so this directly tests "is the door still on
			// its hinge and nearby", not an arbitrary coordinate-frame artifact.
			const edgeBodyLocal = { x: 0, y: 0, z: panel.halfExtents.z };
			const anchorChassisLocal = add(panel.localCenter, rotateVector(panel.nodeWorldQuat, edgeBodyLocal));
			const anchorWorld = add(chassisT.position, rotateVector(chassisT.rotation, anchorChassisLocal));
			doorDistFromChassis[key] = Math.hypot(p.x - anchorWorld.x, p.y - anchorWorld.y, p.z - anchorWorld.z);
		}
		return { panelStates: dt.panelStates, doorDistFromChassis };
	} finally {
		sim.destroy();
	}
}

describe('door SPRUNG: 161/322 km/h frontal', () => {
	it('161 km/h: at least one FRONT door ends sprung (not broken), and stays within 1.2m of the chassis while swung', async () => {
		const r = await frontalCrashDoors(161);
		console.log(`[door-sprung] 161km/h panelStates=${JSON.stringify(r.panelStates)} doorDist=${JSON.stringify(r.doorDistFromChassis)}`);
		const frontDoorsSprung = ['doorL', 'doorR'].filter((k) => r.panelStates[k] === 'sprung');
		expect(frontDoorsSprung.length).toBeGreaterThanOrEqual(1);
		expect(r.panelStates.doorL).not.toBe('broken');
		expect(r.panelStates.doorR).not.toBe('broken');
		for (const key of frontDoorsSprung) {
			expect(r.doorDistFromChassis[key]).toBeLessThan(1.2);
		}
	}, 30000);

	it('322 km/h: all 4 doors still broken (unchanged from pre-sprung behavior)', async () => {
		const r = await frontalCrashDoors(322);
		console.log(`[door-sprung] 322km/h panelStates=${JSON.stringify(r.panelStates)}`);
		for (const key of ['doorL', 'doorR', 'doorRL', 'doorRR']) {
			expect(r.panelStates[key]).toBe('broken');
		}
	}, 30000);

	it('frontal <=80 km/h: doors stay fully attached (existing pins hold)', async () => {
		for (const speed of [40, 55, 64, 80]) {
			const r = await frontalCrashDoors(speed, { wallDistanceM: 10 });
			for (const key of ['doorL', 'doorR', 'doorRL', 'doorRR']) {
				expect(r.panelStates[key]).toBe('attached');
			}
		}
	}, 30000);

	it('determinism: two 161 km/h runs produce identical door states + distances', async () => {
		const a = await frontalCrashDoors(161);
		const b = await frontalCrashDoors(161);
		expect(a.panelStates).toEqual(b.panelStates);
		expect(a.doorDistFromChassis).toEqual(b.doorDistFromChassis);
	}, 30000);
});
