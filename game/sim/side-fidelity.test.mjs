// SPDX-License-Identifier: MIT
//
// Stream C slice C3 -- LATERAL structural crush field (scene/structuralCrush.ts). Guards the gap this
// slice closes: side-impact / small-overlap crashes only ever produced LOCAL contact dents (damage/
// crumple.ts) -- from a TOP VIEW the struck flank's silhouette barely changed, because vehicle/
// segments.ts's telemetry (the front/rear field's only driver) has no lateral channel at all. The fix
// derives a per-flank cave-depth/center/spread statistic straight from the crumple registry's own
// accumulated offsets on CHASSIS-kind meshes and feeds it through the SAME hysteresis/version machinery
// the front/rear field already uses.
//
// Two layers, same split as structural-crush-visual.test.mjs:
//   (1) synthetic-mesh unit tests, driven directly against crumple.ts's buildGridPlane() proxies and
//       structuralCrush.ts's pure functions -- no physics, fully deterministic.
//   (2) one harness test: a real side-50 crash through crash-realism-harness.mjs, reading the ACTUAL
//       registry the crash produced.
import { describe, expect, it } from 'vitest';
import { buildGridPlane, registerDeformable, applyImpactToMesh } from '../src/damage/crumple.ts';
import { registerDeformable as registerWithSystem } from '../src/damage/system.ts';
import {
	createStructuralCrushState,
	updateStructuralCrush,
	resetStructuralCrush,
	structuralFieldFor,
	lateralInputsFromRegistry,
	maxStructuralOffsetM,
} from '../src/scene/structuralCrush.ts';
import { createCrashRealismSim } from './crash-realism-harness.mjs';

const ZERO_FRONTAL = { frontCrushM: 0, rearCrushM: 0, frontPosM: 0, frontNegM: 0 };

/** Synthetic stand-ins spanning the CABIN/flank z-region (unlike structural-crush-visual.test.mjs's
 * front-shell-only proxies) -- a chassis "sill/flank" plate crossing the centerline (so both sides can
 * be probed from ONE mesh) plus a struck-side (doorL, +x) and intact-side (doorR, -x) door panel plate,
 * mirroring carDeformables.ts's real registration (panel worldQuat identity -- see structuralCrush.ts's
 * DOOR_FLANK_SIGN doc comment). */
function makeFlankHandles() {
	const flank = buildGridPlane({ center: { x: 0, y: 0.35, z: 0 }, halfU: 0.95, halfV: 0.85, axisU: 'x', axisV: 'z', segsU: 12, segsV: 10 });
	const doorL = buildGridPlane({ center: { x: 0, y: 0, z: 0 }, halfU: 0.5, halfV: 0.6, axisU: 'y', axisV: 'z', segsU: 4, segsV: 4 });
	const doorR = buildGridPlane({ center: { x: 0, y: 0, z: 0 }, halfU: 0.5, halfV: 0.6, axisU: 'y', axisV: 'z', segsU: 4, segsV: 4 });
	return {
		flank: registerDeformable('chassis-flank', 'chassis', 'chassis', flank.positions, flank.indices),
		doorL: registerDeformable('panel-doorL', 'panel', 'doorL', doorL.positions, doorL.indices),
		doorR: registerDeformable('panel-doorR', 'panel', 'doorR', doorR.positions, doorR.indices),
	};
}

/** Dents the +x flank of `mesh` at chassis-local z=`zCenter` -- a localized side-impact-style crumple,
 * mirroring what a real side-mdb/pole hit's applyCrumpleEvent() call deposits on the chassis shell. */
function dentPosFlank(mesh, zCenter, approachSpeedMs = 12) {
	applyImpactToMesh(mesh, { x: 0.85, y: 0.35, z: zCenter }, { x: -1, y: 0, z: 0 }, approachSpeedMs);
}

describe('lateral structural field: driver-stats derivation (lateralInputsFromRegistry)', () => {
	it('struck (+x) flank reads a nonzero depth centered near the strike; intact (-x) flank reads EXACTLY zero', () => {
		const h = makeFlankHandles();
		dentPosFlank(h.flank, 0.1);
		const { sidePos, sideNeg } = lateralInputsFromRegistry([h.flank]);
		expect(sidePos.depthM).toBeGreaterThan(0.02);
		expect(sidePos.centerZ).toBeGreaterThan(-0.15);
		expect(sidePos.centerZ).toBeLessThan(0.35);
		expect(sideNeg).toEqual({ depthM: 0, centerZ: 0, spanM: expect.any(Number) });
		expect(sideNeg.depthM).toBe(0);
		console.log(`[side-fidelity] sidePos=${JSON.stringify(sidePos)} sideNeg=${JSON.stringify(sideNeg)}`);
	});

	it('a narrower, more concentrated hit (pole-style) reads a smaller spanM than a broader one (MDB-style)', () => {
		const hNarrow = makeFlankHandles();
		dentPosFlank(hNarrow.flank, 0.1, 14); // single localized impact point -- pole
		const narrow = lateralInputsFromRegistry([hNarrow.flank]).sidePos;

		const hBroad = makeFlankHandles();
		// MDB face: several impact points spread along z -- a broader contact patch.
		for (const z of [-0.5, -0.25, 0, 0.25, 0.5]) applyImpactToMesh(hBroad.flank, { x: 0.85, y: 0.35, z }, { x: -1, y: 0, z: 0 }, 12);
		const broad = lateralInputsFromRegistry([hBroad.flank]).sidePos;

		expect(narrow.spanM).toBeLessThan(broad.spanM);
		console.log(`[side-fidelity] narrow.spanM=${narrow.spanM.toFixed(3)} broad.spanM=${broad.spanM.toFixed(3)}`);
	});
});

describe('lateral structural field: buildChassisField + door cave field', () => {
	it('struck side caves INWARD (toward centerline) at the strike center; intact side is identically zero', () => {
		const h = makeFlankHandles();
		dentPosFlank(h.flank, 0.1);
		const { sidePos, sideNeg } = lateralInputsFromRegistry([h.flank]);
		const state = createStructuralCrushState(Object.values(h));
		expect(updateStructuralCrush(state, { ...ZERO_FRONTAL, sidePos, sideNeg })).toBe(true);

		const flankField = structuralFieldFor(state, h.flank);
		expect(flankField.active).toBe(true);
		let structDepth = 0; // max inward (-x) displacement on the struck (+x) side
		let intactMax = 0; // max |any component| on the intact (-x) side -- must be exactly 0
		for (let i = 0; i < h.flank.vertexCount; i++) {
			const bx = h.flank.basePositions[i * 3];
			const ox = flankField.offsets[i * 3];
			const oy = flankField.offsets[i * 3 + 1];
			const oz = flankField.offsets[i * 3 + 2];
			if (bx > 0.3) structDepth = Math.max(structDepth, -ox);
			if (bx < -0.3) intactMax = Math.max(intactMax, Math.abs(ox), Math.abs(oy), Math.abs(oz));
		}
		expect(structDepth).toBeGreaterThan(0.02);
		expect(intactMax).toBe(0); // "intact side gets NOTHING"

		const doorLField = structuralFieldFor(state, h.doorL);
		const doorRField = structuralFieldFor(state, h.doorR);
		expect(doorLField.active).toBe(true); // doorL sits on the struck (+x) flank
		expect(doorRField.active).toBe(false); // doorR sits on the intact (-x) flank: untouched
		let doorLDepth = 0;
		for (let i = 0; i < h.doorL.vertexCount; i++) doorLDepth = Math.max(doorLDepth, -doorLField.offsets[i * 3]);
		expect(doorLDepth).toBeGreaterThan(0.01); // door skin follows the silhouette
		console.log(`[side-fidelity] structDepth=${structDepth.toFixed(3)} doorLDepth=${doorLDepth.toFixed(3)} intactMax=${intactMax}`);
	});

	it('UNDERSIDE COHERENCE: combined lateral + frontal fields never cross (or fold through) the centerline', () => {
		const h = makeFlankHandles();
		dentPosFlank(h.flank, 0.1, 20);
		const { sidePos, sideNeg } = lateralInputsFromRegistry([h.flank]);
		const state = createStructuralCrushState(Object.values(h));
		// A deep, asymmetric FRONTAL input stacked on top of the lateral cave (worst-case combine) --
		// same struck (+x) side deep, intact (-x) side shallow, mirroring a small-overlap corner hit.
		updateStructuralCrush(state, { frontCrushM: 0.5, rearCrushM: 0, frontPosM: 0.5, frontNegM: 0.05, sidePos, sideNeg });
		const field = structuralFieldFor(state, h.flank);
		for (let i = 0; i < h.flank.vertexCount; i++) {
			const bx = h.flank.basePositions[i * 3];
			const ox = field.offsets[i * 3];
			const finalX = bx + ox;
			// Never crosses the centerline (stays the same sign as its own rest position, or lands
			// exactly on it) -- the fold-through guard.
			if (bx > 0) expect(finalX).toBeGreaterThanOrEqual(-1e-9);
			if (bx < 0) expect(finalX).toBeLessThanOrEqual(1e-9);
		}
	});

	it('deterministic: identical inputs produce byte-identical fields', () => {
		const a = makeFlankHandles();
		const b = makeFlankHandles();
		dentPosFlank(a.flank, 0.1);
		dentPosFlank(b.flank, 0.1);
		const inA = lateralInputsFromRegistry([a.flank]);
		const inB = lateralInputsFromRegistry([b.flank]);
		expect(inA).toEqual(inB);
		const sa = createStructuralCrushState(Object.values(a));
		const sb = createStructuralCrushState(Object.values(b));
		updateStructuralCrush(sa, { ...ZERO_FRONTAL, ...inA });
		updateStructuralCrush(sb, { ...ZERO_FRONTAL, ...inB });
		expect(Array.from(structuralFieldFor(sa, a.flank).offsets)).toEqual(Array.from(structuralFieldFor(sb, b.flank).offsets));
		expect(Array.from(structuralFieldFor(sa, a.doorL).offsets)).toEqual(Array.from(structuralFieldFor(sb, b.doorL).offsets));
		resetStructuralCrush(sa);
		expect(maxStructuralOffsetM(sa)).toBe(0);
	});

	it('hysteresis: sub-epsilon drift in the lateral driver stats does not trigger a rebuild', () => {
		const h = makeFlankHandles();
		dentPosFlank(h.flank, 0.1);
		const { sidePos, sideNeg } = lateralInputsFromRegistry([h.flank]);
		const state = createStructuralCrushState(Object.values(h));
		updateStructuralCrush(state, { ...ZERO_FRONTAL, sidePos, sideNeg });
		const v = state.version;
		const drifted = { ...sidePos, depthM: sidePos.depthM + 0.001 }; // < STRUCT_REBUILD_EPSILON_M (0.005)
		expect(updateStructuralCrush(state, { ...ZERO_FRONTAL, sidePos: drifted, sideNeg })).toBe(false);
		expect(state.version).toBe(v);
	});

	it('a PURE side hit (zero mechanical front/rear crush) still switches the field on', () => {
		const h = makeFlankHandles();
		dentPosFlank(h.flank, 0.1);
		const { sidePos, sideNeg } = lateralInputsFromRegistry([h.flank]);
		const state = createStructuralCrushState(Object.values(h));
		expect(updateStructuralCrush(state, { ...ZERO_FRONTAL, sidePos, sideNeg })).toBe(true);
		expect(structuralFieldFor(state, h.flank).active).toBe(true);
	});

	it('front-field results are BYTE-IDENTICAL whether sidePos/sideNeg are omitted or explicitly zero (no side hits)', () => {
		const FRONTAL = { frontCrushM: 0.42, rearCrushM: 0, frontPosM: 0.42, frontNegM: 0.42 };
		const h1 = makeFlankHandles();
		const h2 = makeFlankHandles();
		const s1 = createStructuralCrushState(Object.values(h1));
		const s2 = createStructuralCrushState(Object.values(h2));
		updateStructuralCrush(s1, FRONTAL); // sidePos/sideNeg omitted entirely
		updateStructuralCrush(s2, { ...FRONTAL, sidePos: { depthM: 0, centerZ: 0, spanM: 0.12 }, sideNeg: { depthM: 0, centerZ: 0, spanM: 0.12 } });
		expect(Array.from(structuralFieldFor(s1, h1.flank).offsets)).toEqual(Array.from(structuralFieldFor(s2, h2.flank).offsets));
		// Neither door engages -- a pure frontal input carries no side-hit signal at all.
		expect(structuralFieldFor(s1, h1.doorL).active).toBe(false);
		expect(structuralFieldFor(s1, h1.doorR).active).toBe(false);
	});
});

describe('lateral structural field: real side-50 crash harness', () => {
	it('side-50 crash: struck-flank registry-derived cave depth lands in a sane band; intact flank reads 0', async () => {
		const sim = await createCrashRealismSim();
		try {
			// The default DamageSim registration (damage-harness.mjs) only proxies the FRONT bumper
			// plate as a 'chassis' mesh -- add a flank/sill proxy spanning the cabin z-region (what the
			// real browser registration provides via the whole GLB shell) so the lateral driver has
			// real chassis-kind geometry to read near the door impact zone.
			const flank = buildGridPlane({ center: { x: 0, y: 0.35, z: 0 }, halfU: 0.95, halfV: 0.85, axisU: 'x', axisV: 'z', segsU: 12, segsV: 10 });
			const flankHandle = registerWithSystem(sim.damage, 'chassis-flank', 'chassis', 'chassis', flank.positions, flank.indices);

			sim.spawnSideWall(1.05); // door-centred barrier at the +X flank (matches crash-realism.test.mjs's convention)
			sim.crashSideways(50); // side-mdb-50's own closing speed
			sim.settle(300);

			const { sidePos, sideNeg } = lateralInputsFromRegistry([flankHandle]);
			console.log(`[side-fidelity] side-50 harness: sidePos=${JSON.stringify(sidePos)} sideNeg=${JSON.stringify(sideNeg)}`);
			expect(sidePos.depthM).toBeGreaterThan(0.01);
			expect(sidePos.depthM).toBeLessThan(0.6); // sane band -- not saturated/runaway
			expect(sideNeg.depthM).toBe(0); // intact flank: never touched
		} finally {
			sim.destroy();
		}
	}, 20000);
});
