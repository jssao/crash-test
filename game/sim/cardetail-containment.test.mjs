// SPDX-License-Identifier: MIT
//
// Numeric containment gate for the 'cardetail' WorldFeature (docs/build-log/specs/engine-bay-spec.md):
// asserts every ATTACHED component's chassis-local AABB sits inside the real car body envelope
// (car-map.ts's measured overallDimsMm, via the BodyUnderside chassis node, which happens to equal
// overallDimsMm exactly -- see this file's ENVELOPE_LOCAL_MM derivation), plus tighter per-zone checks
// for interior parts, plus the exterior-proxy invisible-while-attached visibility policy
// (tuning.ts's EXTERIOR_PROXY_IDS). This is the regression gate for the numeric audit that found and
// fixed the orchestrator's screenshot-confirmed "grey boxes poking out of the car" defects -- see
// tuning.ts's per-component comments (mufflerTailpipe/rearBumperBeam/taillightL/R/headlightL/R/
// mirrorL/R/dashboard) for the specific corrections this guards.
//
// Same headless-import pattern as features-cardetail.test.mjs (imports the feature module directly,
// skipping registry.ts's vite-only import.meta.glob -- see feature.ts's doc comment).

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Sim, loadNative } from './harness.mjs';
import { spawnTestWall, crashSetup } from '../src/damage/scenario.ts';
import { FIXED_DT, CHASSIS_ORIGIN_HEIGHT_M } from '../src/vehicle/tuning.ts';
import createCarDetailFeature from '../src/world/features/cardetail/index.ts';
import { CAR_DETAIL_SPECS, EXTERIOR_PROXY_IDS } from '../src/world/features/cardetail/tuning.ts';
import { CAR_MAP } from '../src/assets/car-map.ts';

async function makeFeature(sim) {
	const ctx = {
		world: sim.world,
		scene: new THREE.Scene(),
		getVehicle: () => sim.vehicle,
		carRoot: new THREE.Object3D(),
		quality: { level: 'high', shadowMapSize: 1024, pixelRatioCap: 2, antialias: false, envMapSize: 256 },
	};
	return { ctx, feature: await createCarDetailFeature(ctx) };
}

// ---------------------------------------------------------------------------------------------
// Envelope + zone geometry, derived from car-map.ts measured data (ground truth) the same way the
// orchestrator's numeric audit derived it: car-map.ts's 'BodyUnderside' chassis node's centerMm/
// sizeMm is exactly the whole-body bounding box (equals overallDimsMm exactly -- verified below),
// recorded in WORLD mm (ground = Y 0). Converted to chassis-local METERS the same way tuning.ts's
// mm() helper does (X/Z unit-convert only, Y shifted by CHASSIS_ORIGIN_HEIGHT_M since the chassis's
// own local origin sits at hub height, not ground).
// ---------------------------------------------------------------------------------------------

const bu = CAR_MAP.chassis.BodyUnderside;
// (module-scope sanity check, not a vitest assertion -- keeps the derivation honest without
// depending on vitest's `expect` being callable at import time)
if (bu.sizeMm[0] !== CAR_MAP.overallDimsMm.width || bu.sizeMm[1] !== CAR_MAP.overallDimsMm.height || bu.sizeMm[2] !== CAR_MAP.overallDimsMm.length) {
	throw new Error('cardetail-containment.test.mjs: BodyUnderside no longer matches overallDimsMm -- re-derive ENVELOPE_LOCAL_MM');
}

function worldMmToLocalM(centerMm, sizeMm) {
	const halfMm = [sizeMm[0] / 2, sizeMm[1] / 2, sizeMm[2] / 2];
	return {
		xMin: (centerMm[0] - halfMm[0]) / 1000,
		xMax: (centerMm[0] + halfMm[0]) / 1000,
		yMin: (centerMm[1] - halfMm[1]) / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		yMax: (centerMm[1] + halfMm[1]) / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		zMin: (centerMm[2] - halfMm[2]) / 1000,
		zMax: (centerMm[2] + halfMm[2]) / 1000,
	};
}

/** Whole-body envelope (chassis-local meters) -- every attached part's AABB must sit inside this. */
const ENVELOPE = worldMmToLocalM(bu.centerMm, bu.sizeMm);

/** Cabin footprint (X/Z only) for the interior-parts sub-check, from the real measured InteriorCage
 * chassis node -- padded +60mm on every side (the node itself measures the glazed cage/greenhouse,
 * slightly narrower than the full footwell-to-parcel-shelf cabin volume the interior parts occupy). */
const IC = CAR_MAP.chassis.InteriorCage;
const CABIN_PAD_MM = 60;
const CABIN_X = { min: (IC.centerMm[0] - IC.sizeMm[0] / 2 - CABIN_PAD_MM) / 1000, max: (IC.centerMm[0] + IC.sizeMm[0] / 2 + CABIN_PAD_MM) / 1000 };
// Z padded further forward (+280mm) than the flat pad to accommodate the steering column's firewall-
// mount end (tuning.ts's steeringColumn spans to chassis-local Z~1.32m -- documented there as
// deliberately crossing toward the firewall, matching a real column's mounting point).
const CABIN_Z = { min: (IC.centerMm[2] - IC.sizeMm[2] / 2 - CABIN_PAD_MM) / 1000, max: (IC.centerMm[2] + IC.sizeMm[2] / 2 + 280) / 1000 };

/** Per-shape chassis-local AABB half-extents, matching index.ts's createShapeFor()/buildMeshFor()
 * geometry exactly (box: dims are already half-extents; capsule: full reach along its own axis is
 * length/2 + radius, and radius perpendicular to it). */
function halfExtents(spec) {
	if (spec.phys === 'box') {
		const { hx, hy, hz } = spec.dims;
		return { hx, hy, hz };
	}
	const { length, radius } = spec.dims;
	const axialHalf = length / 2 + radius;
	if (spec.phys === 'capsuleX') return { hx: axialHalf, hy: radius, hz: radius };
	return { hx: radius, hy: radius, hz: axialHalf };
}

function aabbOf(spec) {
	const c = spec.localCenter;
	const { hx, hy, hz } = halfExtents(spec);
	return { xMin: c.x - hx, xMax: c.x + hx, yMin: c.y - hy, yMax: c.y + hy, zMin: c.z - hz, zMax: c.z + hz };
}

function within(box, bound) {
	return box.xMin >= bound.xMin - 1e-9 && box.xMax <= bound.xMax + 1e-9 && box.yMin >= bound.yMin - 1e-9 && box.yMax <= bound.yMax + 1e-9 && box.zMin >= bound.zMin - 1e-9 && box.zMax <= bound.zMax + 1e-9;
}

// Interior parts: everything neither engine-bay nor an exterior extremity/underbody-mechanical part.
// (underbody/extremity mechanicals -- subframes, driveshaft, control arms, cat converter, fuel tank,
// muffler, bumper beams, lights, mirrors -- legitimately sit outside the cabin footprint.)
const UNDERBODY_EXTREMITY_IDS = new Set([
	'catConverter',
	'mufflerTailpipe',
	'fuelTank',
	'frontSubframe',
	'rearSubframe',
	'driveshaft',
	'flControlArm',
	'frControlArm',
	'rlControlArm',
	'rrControlArm',
	...EXTERIOR_PROXY_IDS,
]);

describe('cardetail containment (numeric audit gate)', () => {
	it('ENVELOPE is non-empty and matches car-map.ts overallDimsMm (sanity)', () => {
		expect(ENVELOPE.xMax - ENVELOPE.xMin).toBeCloseTo(CAR_MAP.overallDimsMm.width / 1000, 6);
		expect(ENVELOPE.yMax - ENVELOPE.yMin).toBeCloseTo(CAR_MAP.overallDimsMm.height / 1000, 6);
		expect(ENVELOPE.zMax - ENVELOPE.zMin).toBeCloseTo(CAR_MAP.overallDimsMm.length / 1000, 6);
	});

	it('every one of the 39 components has a distinct id and a mass-bearing shape (table sanity)', () => {
		expect(CAR_DETAIL_SPECS.length).toBe(39);
		expect(new Set(CAR_DETAIL_SPECS.map((s) => s.id)).size).toBe(39);
	});

	it('every attached part sits fully inside the real car body envelope (no protruding proxy boxes)', () => {
		const offenders = [];
		for (const spec of CAR_DETAIL_SPECS) {
			const box = aabbOf(spec);
			if (!within(box, ENVELOPE)) offenders.push({ id: spec.id, box, ENVELOPE });
		}
		if (offenders.length) console.log('[cardetail-containment] envelope offenders:', JSON.stringify(offenders, null, 2));
		expect(offenders).toEqual([]);
	});

	it('interior parts sit inside the real cabin footprint (X/Z), not spilling into the engine bay or trunk', () => {
		const interiorIds = new Set(CAR_DETAIL_SPECS.filter((s) => !s.engineBay && !UNDERBODY_EXTREMITY_IDS.has(s.id)).map((s) => s.id));
		// Sanity: this is exactly the spec's §2 interior list (8 components).
		expect(interiorIds.size).toBe(8);

		const offenders = [];
		for (const spec of CAR_DETAIL_SPECS) {
			if (!interiorIds.has(spec.id)) continue;
			const box = aabbOf(spec);
			const cabinBound = { xMin: CABIN_X.min, xMax: CABIN_X.max, yMin: ENVELOPE.yMin, yMax: ENVELOPE.yMax, zMin: CABIN_Z.min, zMax: CABIN_Z.max };
			if (!within(box, cabinBound)) offenders.push({ id: spec.id, box, cabinBound });
		}
		if (offenders.length) console.log('[cardetail-containment] cabin offenders:', JSON.stringify(offenders, null, 2));
		expect(offenders).toEqual([]);
	});

	it('exterior proxy parts (headlights/taillights/mirrors/bumper beams) start INVISIBLE while attached', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			const visible = feature.hooks.meshVisible();
			const states = feature.hooks.states();
			expect(EXTERIOR_PROXY_IDS.size).toBeGreaterThan(0);
			for (const id of EXTERIOR_PROXY_IDS) {
				expect(states[id]).toBe('attached');
				expect(visible[id]).toBe(false);
			}
			// Interior/underbody (non-engine-bay, non-exterior-proxy) parts stay visible throughout.
			for (const spec of CAR_DETAIL_SPECS) {
				if (spec.engineBay || EXTERIOR_PROXY_IDS.has(spec.id)) continue;
				expect(visible[spec.id]).toBe(true);
			}
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});

	it('exterior proxy parts become visible once they actually detach (flying debris on impact)', async () => {
		const native = await loadNative();
		const sim = new Sim(native);
		try {
			const { feature } = await makeFeature(sim);
			// crashSetup() (velocity-teleport, same convenience path verify/feature-cardetail.mjs uses)
			// rather than a real drive-up: this test only needs SOME exterior proxy to detach so the
			// visibility invariant below is actually exercised, not a physically-realistic frontal-impact
			// distribution (that's features-cardetail.test.mjs's job, via a real drive-up). Escalating
			// speed across a couple of tries covers the same run-to-run float jitter that verify script's
			// own comment documents.
			let states = null;
			for (const speedKmh of [110, 160, 220]) {
				spawnTestWall(sim.world, sim.vehicle, 8);
				crashSetup(sim.vehicle, speedKmh);
				for (let i = 0; i < 300; i++) {
					sim.step({ throttle: 0, brake: 0, steer: 0, handbrake: false });
					feature.afterFixedStep(FIXED_DT);
				}
				states = feature.hooks.states();
				if ([...EXTERIOR_PROXY_IDS].some((id) => states[id] !== 'attached')) break;
			}
			feature.applyVisuals(1);

			const visible = feature.hooks.meshVisible();
			const detachedExterior = [...EXTERIOR_PROXY_IDS].filter((id) => states[id] !== 'attached');
			console.log(`[cardetail-containment] detached exterior proxies after crash: ${detachedExterior.length}/${EXTERIOR_PROXY_IDS.size}`, JSON.stringify(states));
			expect(detachedExterior.length).toBeGreaterThan(0);
			for (const id of detachedExterior) {
				expect(visible[id]).toBe(true);
			}
			// Every still-attached exterior part (didn't break this run) must remain invisible.
			for (const id of EXTERIOR_PROXY_IDS) {
				if (states[id] === 'attached') expect(visible[id]).toBe(false);
			}
			feature.dispose?.();
		} finally {
			sim.destroy();
		}
	});
});
