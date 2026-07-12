// SPDX-License-Identifier: MIT
//
// scene/structuralCrush.ts -- the STRUCTURAL crush visual pass (rendered shell follows the mechanical
// crush). Pure typed-array math (no three/DOM), so it is testable headlessly against the same
// synthetic grid-plane proxies the damage sim tests use (crumple.ts's buildGridPlane). Guards the
// user-playtest fix "0.42m of telemetry crush yet the car renders pristine" (2026-07-10): the field
// must actually shorten the nose in silhouette, tent the hood, stay off below the noise floor, stay
// deterministic, and never touch meshes it doesn't own (doors/glass).
import { describe, expect, it } from 'vitest';
import { buildGridPlane, registerDeformable } from '../src/damage/crumple.ts';
import {
	createStructuralCrushState,
	updateStructuralCrush,
	resetStructuralCrush,
	structuralFieldFor,
	structuralInputsFromTelemetry,
	maxStructuralOffsetM,
} from '../src/scene/structuralCrush.ts';

/** Synthetic stand-ins mirroring damage-harness.mjs's proxies: a chassis-front shell plate (spanning
 * the crush zone, firewall->nose), a hood plate (hood-body-local), a door plate, a glass plate. */
function makeHandles() {
	const shell = buildGridPlane({ center: { x: 0, y: 0.5, z: 1.5 }, halfU: 0.8, halfV: 0.9, axisU: 'x', axisV: 'z', segsU: 8, segsV: 8 });
	const hood = buildGridPlane({ center: { x: 0, y: 0, z: 0 }, halfU: 0.7, halfV: 0.65, axisU: 'x', axisV: 'z', segsU: 8, segsV: 8 });
	const door = buildGridPlane({ center: { x: 0, y: 0, z: 0 }, halfU: 0.5, halfV: 0.6, axisU: 'y', axisV: 'z', segsU: 4, segsV: 4 });
	const glass = buildGridPlane({ center: { x: 0, y: 0.9, z: 0.9 }, halfU: 0.6, halfV: 0.3, axisU: 'x', axisV: 'z', segsU: 4, segsV: 4 });
	return {
		shell: registerDeformable('chassis-front', 'chassis', 'chassis', shell.positions, shell.indices),
		hood: registerDeformable('panel-hood', 'panel', 'hood', hood.positions, hood.indices),
		door: registerDeformable('panel-doorL', 'panel', 'doorL', door.positions, door.indices),
		glass: registerDeformable('glass-windshield', 'glass', 'chassis', glass.positions, glass.indices),
	};
}

const FRONTAL_56 = { frontCrushM: 0.42, rearCrushM: 0, frontPosM: 0.42, frontNegM: 0.42 };

describe('structural crush visual pass', () => {
	it('shortens the nose: rearward displacement grows toward the front tip and reaches ~the mechanical crush', () => {
		const h = makeHandles();
		const state = createStructuralCrushState(Object.values(h));
		expect(updateStructuralCrush(state, FRONTAL_56)).toBe(true);
		const field = structuralFieldFor(state, h.shell);
		expect(field.active).toBe(true);
		// Max rearward (-z) displacement at the nose row vs a mid-zone row: monotonic accordion.
		let noseDz = 0;
		let midDz = 0;
		for (let i = 0; i < h.shell.vertexCount; i++) {
			const bz = h.shell.basePositions[i * 3 + 2];
			const dz = field.offsets[i * 3 + 2];
			if (bz > 2.35) noseDz = Math.min(noseDz, dz);
			if (bz > 1.4 && bz < 1.6) midDz = Math.min(midDz, dz);
		}
		// Nose caves ~the full mechanical crush (jitter is +/-22%); mid-zone caves less (t^1.7).
		expect(noseDz).toBeLessThan(-0.42 * 0.7);
		expect(noseDz).toBeGreaterThan(-0.42 * 1.35);
		expect(midDz).toBeGreaterThan(noseDz * 0.75); // strictly shallower than the nose
		console.log(`[structural] noseDz=${noseDz.toFixed(3)} midDz=${midDz.toFixed(3)}`);
	});

	it('buckles metal UP and OUT mid-zone (volume-conservation fold), not only inward', () => {
		const h = makeHandles();
		const state = createStructuralCrushState(Object.values(h));
		updateStructuralCrush(state, FRONTAL_56);
		const field = structuralFieldFor(state, h.shell);
		let maxDy = 0;
		let maxOutward = 0;
		for (let i = 0; i < h.shell.vertexCount; i++) {
			const bx = h.shell.basePositions[i * 3];
			maxDy = Math.max(maxDy, field.offsets[i * 3 + 1]);
			if (Math.abs(bx) > 0.5) maxOutward = Math.max(maxOutward, field.offsets[i * 3] * Math.sign(bx));
		}
		expect(maxDy).toBeGreaterThan(0.05); // fender-top rise
		expect(maxOutward).toBeGreaterThan(0.02); // outboard bulge at the fenders
		console.log(`[structural] maxDy=${maxDy.toFixed(3)} maxOutward=${maxOutward.toFixed(3)}`);
	});

	it('tents the hood: apex mid-span at ~HOOD_TENT_RATIO x crush, hinged (rear) edge stays put', () => {
		const h = makeHandles();
		const state = createStructuralCrushState(Object.values(h));
		updateStructuralCrush(state, FRONTAL_56);
		const field = structuralFieldFor(state, h.hood);
		expect(field.active).toBe(true);
		const amp = 0.55 * 0.42;
		let apex = 0;
		let rearEdgeDy = 0;
		let frontEdgeDz = 0;
		for (let i = 0; i < h.hood.vertexCount; i++) {
			const bz = h.hood.basePositions[i * 3 + 2];
			const dy = field.offsets[i * 3 + 1];
			apex = Math.max(apex, dy);
			if (bz < -0.6) rearEdgeDy = Math.max(rearEdgeDy, Math.abs(dy));
			if (bz > 0.6) frontEdgeDz = Math.min(frontEdgeDz, field.offsets[i * 3 + 2]);
		}
		expect(apex).toBeGreaterThan(amp * 0.7);
		expect(apex).toBeLessThan(amp * 1.25);
		expect(rearEdgeDy).toBeLessThan(0.03); // hinge/cowl edge essentially still
		expect(frontEdgeDz).toBeLessThan(-0.05); // free edge trails rearward with the radiator support
		console.log(`[structural] hood apex=${apex.toFixed(3)} (amp=${amp.toFixed(3)}) rearEdgeDy=${rearEdgeDy.toFixed(4)} frontEdgeDz=${frontEdgeDz.toFixed(3)}`);
	});

	it('leaves doors and glass to the contact-dent pipeline', () => {
		const h = makeHandles();
		const state = createStructuralCrushState(Object.values(h));
		updateStructuralCrush(state, FRONTAL_56);
		expect(structuralFieldFor(state, h.door).active).toBe(false);
		expect(structuralFieldFor(state, h.glass).active).toBe(false);
	});

	it('stays OFF below the structural noise floor and ignores sub-epsilon input churn', () => {
		const h = makeHandles();
		const state = createStructuralCrushState(Object.values(h));
		expect(updateStructuralCrush(state, { frontCrushM: 0.02, rearCrushM: 0, frontPosM: 0.02, frontNegM: 0.02 })).toBe(false);
		expect(maxStructuralOffsetM(state)).toBe(0);
		updateStructuralCrush(state, FRONTAL_56);
		const v = state.version;
		// 2mm drift < STRUCT_REBUILD_EPSILON_M: no rebuild, version stable.
		expect(updateStructuralCrush(state, { ...FRONTAL_56, frontCrushM: 0.422 })).toBe(false);
		expect(state.version).toBe(v);
	});

	it('is deterministic (same inputs -> byte-identical fields) and resets clean', () => {
		const a = makeHandles();
		const b = makeHandles();
		const sa = createStructuralCrushState(Object.values(a));
		const sb = createStructuralCrushState(Object.values(b));
		updateStructuralCrush(sa, FRONTAL_56);
		updateStructuralCrush(sb, FRONTAL_56);
		expect(Array.from(structuralFieldFor(sa, a.shell).offsets)).toEqual(Array.from(structuralFieldFor(sb, b.shell).offsets));
		expect(Array.from(structuralFieldFor(sa, a.hood).offsets)).toEqual(Array.from(structuralFieldFor(sb, b.hood).offsets));
		resetStructuralCrush(sa);
		expect(maxStructuralOffsetM(sa)).toBe(0);
		expect(structuralFieldFor(sa, a.shell).active).toBe(false);
	});

	it('offset crash: the struck (+x) side caves deeper than the intact side', () => {
		const h = makeHandles();
		const state = createStructuralCrushState(Object.values(h));
		updateStructuralCrush(state, { frontCrushM: 0.4, rearCrushM: 0, frontPosM: 0.4, frontNegM: 0.06 });
		const field = structuralFieldFor(state, h.shell);
		let posDz = 0;
		let negDz = 0;
		for (let i = 0; i < h.shell.vertexCount; i++) {
			const bx = h.shell.basePositions[i * 3];
			const bz = h.shell.basePositions[i * 3 + 2];
			if (bz < 2.3) continue; // nose row only
			const dz = field.offsets[i * 3 + 2];
			if (bx > 0.5) posDz = Math.min(posDz, dz);
			if (bx < -0.5) negDz = Math.min(negDz, dz);
		}
		expect(posDz).toBeLessThan(negDz - 0.1); // struck side visibly deeper
		console.log(`[structural] offset posDz=${posDz.toFixed(3)} negDz=${negDz.toFixed(3)}`);
	});

	it('derives inputs from telemetry: mechanical depth + per-side asymmetry ratio', () => {
		const inputs = structuralInputsFromTelemetry({
			frontCrushM: 0.45,
			rearCrushM: 0.02,
			intrusionM: 0.05,
			coreRetreatM: { front: 0.4, rear: 0 },
			coreRetreatFrontM: { pos: 0.4, neg: 0.1 },
			weldCrushM: {},
			tornWelds: [],
		});
		expect(inputs.frontCrushM).toBeCloseTo(0.45, 6);
		expect(inputs.frontPosM).toBeCloseTo(0.45, 6); // deeper side rescaled to the mechanical depth
		expect(inputs.frontNegM).toBeCloseTo(0.45 * (0.1 / 0.4), 6); // shallow side keeps its ratio
		expect(inputs.rearCrushM).toBeCloseTo(0.02, 6);
	});
});
