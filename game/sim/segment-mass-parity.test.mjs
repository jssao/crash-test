// SPDX-License-Identifier: MIT
//
// Crush-architecture M1 groundwork (docs/build-log/specs/crush-architecture.md §A step 1): proves the
// mass-parity deduction math in geometry.ts. When the monolithic nose/tail crush volumes are replaced
// by a chain of REAL welded segment bodies, each segment's mass is DEDUCTED from the chassis so the
// rigid composite (chassis remainder + every welded segment) reproduces the captured single-hull
// mass/COM/inertia EXACTLY -- keeping total car mass/COM/inertia byte-stable (the M1 "pure structure
// swap" gate). This test is pure arithmetic (no physics/wasm): it stamps a known parity, deducts a set
// of segments, then recomposes the composite and asserts round-trip identity of mass, COM, and the full
// inertia tensor. The complementary EMPIRICAL finding (symmetric welded satellites perturb the chaotic
// drive suite only slightly and boundedly -- straight-line within 0.14%, no runaway/rollover/beaching)
// is recorded in the build log; see the crush-M1 worker report.
import { describe, expect, it } from 'vitest';
import {
	boxInertiaAboutCenter,
	composeSegmentsWithChassis,
	deductSegmentsFromParity,
	parallelAxisTensor,
	segmentCompositeMass,
} from '../src/vehicle/geometry.ts';
import { segmentMassSpecs } from '../src/vehicle/segments.ts';
import { CHASSIS_MASS_KG } from '../src/vehicle/tuning.ts';

/** A representative single-hull parity: a plausible chassis mass/COM plus a NON-trivial (off-diagonal,
 * asymmetric) inertia tensor, so the round-trip exercises every tensor term rather than a diagonal
 * special case. Symmetric (Iij == Iji) as a real inertia tensor must be. */
const PARITY = {
	mass: 1291,
	center: { x: 0, y: 0.28, z: -0.05 },
	inertia: {
		cx: { x: 900, y: 12, z: -8 },
		cy: { x: 12, y: 1600, z: 5 },
		cz: { x: -8, y: 5, z: 2100 },
	},
};

/** Front crush segments per crush-architecture.md §A (beam ~15, rails ~20 ea, cradle ~40), left/right
 * symmetric, filling the nose volume (chassis-local z 0.6..1.05). */
const SEGMENTS = [
	{ center: { x: 0, y: 0.2, z: 1.0 }, half: { x: 0.7, y: 0.12, z: 0.06 }, massKg: 15 },
	{ center: { x: 0.45, y: 0.2, z: 0.85 }, half: { x: 0.12, y: 0.1, z: 0.14 }, massKg: 20 },
	{ center: { x: -0.45, y: 0.2, z: 0.85 }, half: { x: 0.12, y: 0.1, z: 0.14 }, massKg: 20 },
	{ center: { x: 0, y: 0.15, z: 0.6 }, half: { x: 0.35, y: 0.15, z: 0.12 }, massKg: 40 },
];

const tensorClose = (a, b, tol = 1e-6) => {
	for (const row of ['cx', 'cy', 'cz']) {
		for (const axis of ['x', 'y', 'z']) {
			expect(Math.abs(a[row][axis] - b[row][axis])).toBeLessThan(tol);
		}
	}
};

describe('crush M1: segment mass-parity deduction (geometry.ts)', () => {
	it('deduct + recompose is an exact round trip of mass, COM, and inertia tensor', () => {
		const chassis = deductSegmentsFromParity(PARITY, SEGMENTS);
		// chassis mass = parity - sum(segments)
		const segTotal = segmentCompositeMass(SEGMENTS);
		expect(chassis.mass).toBeCloseTo(PARITY.mass - segTotal.mass, 9);
		expect(segTotal.mass).toBe(95);

		// Recompose composite about the parity COM and require it to reproduce PARITY exactly.
		const composite = composeSegmentsWithChassis(chassis, SEGMENTS, PARITY.center);
		expect(composite.mass).toBeCloseTo(PARITY.mass, 9);
		expect(composite.center.x).toBeCloseTo(PARITY.center.x, 9);
		expect(composite.center.y).toBeCloseTo(PARITY.center.y, 9);
		expect(composite.center.z).toBeCloseTo(PARITY.center.z, 9);
		tensorClose(composite.inertia, PARITY.inertia);
	});

	it('deducted chassis COM shifts opposite the (forward, +z) segment mass, holding aggregate COM', () => {
		const chassis = deductSegmentsFromParity(PARITY, SEGMENTS);
		// Segments sit forward (+z) of the parity COM, so the chassis remainder's COM must move rearward
		// (-z, away from them) to hold the aggregate COM at the parity value.
		expect(chassis.center.z).toBeLessThan(PARITY.center.z);
	});

	it('box inertia + parallel-axis primitives satisfy the standard identities', () => {
		// Uniform cube, half=0.5 (side 1), mass 12: I = m/6*side^2 = 2 on each principal axis.
		const cube = boxInertiaAboutCenter(12, { x: 0.5, y: 0.5, z: 0.5 });
		expect(cube.cx.x).toBeCloseTo(2, 9);
		expect(cube.cy.y).toBeCloseTo(2, 9);
		expect(cube.cz.z).toBeCloseTo(2, 9);
		expect(cube.cx.y).toBe(0); // diagonal for an axis-aligned box

		// Parallel-axis of a point mass m at distance d along x: adds m*d^2 to Iyy and Izz, 0 to Ixx.
		const pa = parallelAxisTensor(3, { x: 2, y: 0, z: 0 });
		expect(pa.cx.x).toBeCloseTo(0, 9);
		expect(pa.cy.y).toBeCloseTo(3 * 4, 9);
		expect(pa.cz.z).toBeCloseTo(3 * 4, 9);
	});

	it('throws if segments outweigh the parity mass (mis-set per-segment masses)', () => {
		expect(() => deductSegmentsFromParity({ ...PARITY, mass: 50 }, SEGMENTS)).toThrow(/chassis mass/);
	});

	// CRUSH M1 (landed): the REAL production segment table (vehicle/segments.ts, 9 bodies) round-trips
	// through the same deduction math -- 135kg of crush structure against the tuned chassis mass, exact
	// mass/COM/inertia recomposition. The engine-integrated equivalent (box3d's own mass integration of
	// the live bodies) is asserted by sim/segment-structure.test.mjs + hull-cabin-tub.test.mjs.
	it('the REAL segment table (segments.ts) deducts + recomposes exactly against the tuned chassis mass', () => {
		const real = segmentMassSpecs();
		const parity = { ...PARITY, mass: CHASSIS_MASS_KG };
		const total = segmentCompositeMass(real);
		expect(total.mass).toBeCloseTo(135, 9);
		const chassis = deductSegmentsFromParity(parity, real);
		expect(chassis.mass).toBeCloseTo(CHASSIS_MASS_KG - 135, 9);
		const composite = composeSegmentsWithChassis(chassis, real, parity.center);
		expect(composite.mass).toBeCloseTo(parity.mass, 9);
		expect(composite.center.x).toBeCloseTo(parity.center.x, 9);
		expect(composite.center.y).toBeCloseTo(parity.center.y, 9);
		expect(composite.center.z).toBeCloseTo(parity.center.z, 9);
		tensorClose(composite.inertia, parity.inertia);
	});
});
