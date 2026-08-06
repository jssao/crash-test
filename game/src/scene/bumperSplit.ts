// SPDX-License-Identifier: MIT
//
// BUG R004 (deliverable 2 -- HANGING BUMPERS): the S90 GLB's "BodyShell" node is a single glTF mesh
// with 7 material primitives (Car Paint / Plastic / Chrome / Black Glossy / rubber / Glass / Metal
// Turnsignal), which three's GLTFLoader realizes as a Group of 7 THREE.Mesh children -- there is NO
// separable bumper node. This module carves the FRONT and REAR bumper regions out of those primitive
// GEOMETRIES at LOAD TIME (never the source GLB) into their own meshes, parented under a per-end hinge
// pivot, so a severe frontal/rear crash can visually detach one end of a bumper and let it hang/drag
// with a damped pendulum swing. Pure visual -- no physics body.
//
// DEFORMABLE-REGISTRY CONSISTENCY (the landmine): scene/carDeformables.ts registers EVERY mesh under
// car.root as a crumple deformable and syncs the (deformed) registry positions back into each mesh's
// BufferGeometry every fixed step; the lab's deformableSyncCheck() asserts rendered-vs-registry
// agreement to <1mm. This split runs INSIDE loadCar() -- i.e. BEFORE registerCarDeformables() runs in
// main.ts/lab/main.ts -- and it *replaces* each source primitive's geometry with the SHELL remainder
// while emitting the front/rear bumper triangles as brand-new sibling meshes. Registration then simply
// sees shell + bumperFront-parts + bumperRear-parts as separate `chassis` deformables (every original
// vertex is present in exactly one of them, none double-counted), so the pipeline stays whole.
//
// WHY THE HINGE MATH DOESN'T BREAK THE SYNC: each bumper sub-mesh keeps its geometry attribute values
// in the SAME body-local frame the source primitive used (we copy vertices verbatim, no rebasing). The
// hinge is expressed structurally -- a `pivot` Object3D placed at the hinge corner C with a `holder`
// child at -C carrying the sub-meshes -- so at rest (pivot rotation = identity) the net transform is
// identity and every sub-mesh renders EXACTLY where the un-split shell would. At registration time the
// sub-mesh's matrixWorld therefore equals the BodyShell group's matrixWorld (identical to the shell
// primitives'), and deformableSyncCheck compares in mesh-LOCAL attribute space, which is invariant
// under the pivot's later rotation -- so detaching/swinging a bumper can never perturb the sync error.

import * as THREE from 'three';
import { CAR_MAP } from '../assets/car-map';

// ---------------------------------------------------------------------------------------------
// Split thresholds (chassis-local meters; +Z forward/nose, -Z rear/tail, Y-up, wheel-bottoms ~Y=0 --
// car-map.ts axisConvention). Derived from the measured BodyShell geometry bounds at split time plus
// these depth/height constants rather than hard-coded absolute z's, so a future GLB re-export can't
// silently drift the cut off the actual bumper.
// ---------------------------------------------------------------------------------------------

/** How far back from the nose tip (m) the front-bumper cut reaches -- the front fascia depth. */
const FRONT_BUMPER_DEPTH_M = 0.52;
/** How far forward from the tail tip (m) the rear-bumper cut reaches. */
const REAR_BUMPER_DEPTH_M = 0.52;
/** Body-local height (m) below which a bumper-region triangle is taken -- keeps the cut to the lower
 * fascia/valance/grille band and off the hood line, headlights, and beltline above it. */
const BUMPER_TOP_Y_M = 0.74;
/** Safety floor: the front cut must stay ahead of the front axle (never eat cabin/door structure) --
 * a guard against a pathological measured-bounds read; the depth-derived cut already clears it. */
const FRONT_AXLE_Z_M = CAR_MAP.wheels.frontLeft.centerMm[2] / 1000;
const REAR_AXLE_Z_M = CAR_MAP.wheels.rearLeft.centerMm[2] / 1000;

// ---------------------------------------------------------------------------------------------
// Detach + swing tuning (all visual-only).
// ---------------------------------------------------------------------------------------------

/** Plastic front/rear crush (m, vehicle/segments.ts SegmentTelemetry.*CrushPlasticM) at/above which the
 * corresponding bumper detaches. Comfortably ABOVE the NHTSA-56 frontal's ~0.33-0.44m (so a standard
 * 56 km/h nose-scuff shot keeps its bumper attached) but well below the 100-130 km/h "hanging bumper"
 * tier's crush. */
const DETACH_FRONT_CRUSH_M = 0.5;
const DETACH_REAR_CRUSH_M = 0.42;

/** Damped-swing target droop about the hinge's lateral (X) axis (rad) -- the bumper tips down toward the
 * ground. ~0.5 rad (~29deg) hangs the free lower edge to near-ground (dragging) without spearing through
 * it once the crashed nose has also pitched down. */
const DROOP_ANGLE = 0.5;
/** Secondary "cocked off to one side" roll about the longitudinal (Z) axis (rad) -- small (the ~2m-wide
 * bumper's far end is only ~0.5m off the ground, so a large roll would spear it into the pad); enough to
 * read as a broken, asymmetric dangle rather than a neat fold-down. */
const COCK_ANGLE = 0.15;
/** Extra detach TRANSLATION applied to the hinge as the swing settles (m): the bumper physically pulls
 * DOWN and OUT past the nose/tail so it reads as a genuinely detached part gapping away from the body,
 * not just a hinge-fold flush against it. Z is signed forward(front)/rearward(rear) by droopSign. */
const DETACH_DROP_M = 0.12;
const DETACH_OUT_M = 0.18;
/** Spring stiffness / damping of the swing toward its hanging pose (undamped-ish -> a couple of visible
 * swings before it settles). */
const SWING_STIFFNESS = 42;
const SWING_DAMPING = 5.2;
/** Initial angular kick imparted at detachment (drives the overshoot of the first swing). */
const SWING_KICK = 3.0;

interface BumperEnd {
	pivot: THREE.Object3D;
	/** Hinge corner (pivot rest position, body-local) -- the detach translation is added on top of this. */
	hinge: THREE.Vector3;
	/** +1 front (droops about +X, gaps forward), -1 rear (droops about -X, gaps rearward). */
	droopSign: 1 | -1;
	detached: boolean;
	/** Normalized swing state: 0 = flush/attached pose, ~1 = settled hanging pose (overshoots past 1). */
	swing: number;
	swingVel: number;
}

export interface BumperSplit {
	readonly hasFront: boolean;
	readonly hasRear: boolean;
	/** Call once per fixed step with the current plastic crush telemetry: triggers detachment past the
	 * crush thresholds and advances the damped swing of whichever ends have detached. */
	update(dt: number, frontCrushPlasticM: number, rearCrushPlasticM: number): void;
	/** Re-seats both bumpers flush (car repaired / new run) -- mirrors crashFx.reset()'s role. */
	reset(): void;
	/** Verify/diagnostic readout. */
	debug(): { hasFront: boolean; hasRear: boolean; frontDetached: boolean; rearDetached: boolean; frontSwing: number; rearSwing: number };
}

const NOOP_SPLIT: BumperSplit = {
	hasFront: false,
	hasRear: false,
	update() {},
	reset() {},
	debug: () => ({ hasFront: false, hasRear: false, frontDetached: false, rearDetached: false, frontSwing: 0, rearSwing: 0 }),
};

/** Collects every Mesh in `root`'s subtree (inclusive). */
function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
	const out: THREE.Mesh[] = [];
	root.traverse((o) => {
		const m = o as THREE.Mesh;
		if (m.isMesh && m.geometry) out.push(m);
	});
	return out;
}

type Bucket = 'shell' | 'front' | 'rear';

/** Rebuilds a compacted, re-indexed BufferGeometry from the source geometry using only the triangles
 * whose flattened vertex-index list is `triVertIdx` -- preserves within-bucket vertex sharing, position/
 * normal/uv attributes, and produces a fresh index buffer. */
function buildSubGeometry(src: THREE.BufferGeometry, triVertIdx: number[]): THREE.BufferGeometry {
	const pos = src.getAttribute('position') as THREE.BufferAttribute;
	const nor = src.getAttribute('normal') as THREE.BufferAttribute | undefined;
	const uv = src.getAttribute('uv') as THREE.BufferAttribute | undefined;
	const remap = new Map<number, number>();
	const newIndex: number[] = [];
	const posArr: number[] = [];
	const norArr: number[] = [];
	const uvArr: number[] = [];
	for (const vi of triVertIdx) {
		let ni = remap.get(vi);
		if (ni === undefined) {
			ni = remap.size;
			remap.set(vi, ni);
			posArr.push(pos.getX(vi), pos.getY(vi), pos.getZ(vi));
			if (nor) norArr.push(nor.getX(vi), nor.getY(vi), nor.getZ(vi));
			if (uv) uvArr.push(uv.getX(vi), uv.getY(vi));
		}
		newIndex.push(ni);
	}
	const g = new THREE.BufferGeometry();
	g.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
	if (nor) g.setAttribute('normal', new THREE.Float32BufferAttribute(norArr, 3));
	if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
	g.setIndex(newIndex);
	return g;
}

/** Splits the S90's BodyShell primitives' front/rear bumper regions into their own hinged, swingable
 * meshes. Idempotent-safe (returns a no-op handle if the BodyShell node is absent or has no eligible
 * geometry). MUST be called BEFORE registerCarDeformables() (i.e. from loadCar()). */
export function splitBumpers(carRoot: THREE.Object3D): BumperSplit {
	const bodyShell = carRoot.getObjectByName('BodyShell');
	if (!bodyShell) return NOOP_SPLIT;
	const sourceMeshes = collectMeshes(bodyShell);
	if (sourceMeshes.length === 0) return NOOP_SPLIT;

	// Measure the overall bounds over every source primitive (Car Paint dominates), in the primitives'
	// own local frame (== the BodyShell group's child frame). All primitives share that frame.
	let noseZ = -Infinity;
	let tailZ = Infinity;
	for (const m of sourceMeshes) {
		m.geometry.computeBoundingBox();
		const bb = m.geometry.boundingBox;
		if (!bb) continue;
		if (bb.max.z > noseZ) noseZ = bb.max.z;
		if (bb.min.z < tailZ) tailZ = bb.min.z;
	}
	if (!isFinite(noseZ) || !isFinite(tailZ)) return NOOP_SPLIT;

	const frontCut = Math.max(noseZ - FRONT_BUMPER_DEPTH_M, FRONT_AXLE_Z_M + 0.25);
	const rearCut = Math.min(tailZ + REAR_BUMPER_DEPTH_M, REAR_AXLE_Z_M - 0.25);

	const frontMeshes: THREE.Mesh[] = [];
	const rearMeshes: THREE.Mesh[] = [];
	// Region bounds, accumulated as sub-meshes are built, to place each hinge on the actual carved geometry.
	const frontBounds = new THREE.Box3().makeEmpty();
	const rearBounds = new THREE.Box3().makeEmpty();
	const _v = new THREE.Vector3();

	function classify(cy: number, cz: number): Bucket {
		if (cy < BUMPER_TOP_Y_M) {
			if (cz > frontCut) return 'front';
			if (cz < rearCut) return 'rear';
		}
		return 'shell';
	}

	let partIdx = 0;
	for (const src of sourceMeshes) {
		const geo = src.geometry;
		const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
		if (!pos) continue;
		const index = geo.getIndex();
		const triCount = index ? index.count / 3 : pos.count / 3;
		const shellIdx: number[] = [];
		const frontIdx: number[] = [];
		const rearIdx: number[] = [];
		for (let t = 0; t < triCount; t++) {
			const a = index ? index.getX(t * 3) : t * 3;
			const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
			const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
			const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
			const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
			const bucket = classify(cy, cz);
			const dst = bucket === 'front' ? frontIdx : bucket === 'rear' ? rearIdx : shellIdx;
			dst.push(a, b, c);
		}
		// Nothing eligible on this primitive (e.g. the cabin-only rubber/glass prims) -- leave it intact.
		if (frontIdx.length === 0 && rearIdx.length === 0) continue;

		// Replace the source primitive with just its shell remainder.
		const shellGeo = buildSubGeometry(geo, shellIdx);
		src.geometry = shellGeo;

		const mat = src.material;
		const mkSub = (idx: number[], tag: string): THREE.Mesh => {
			const sub = new THREE.Mesh(buildSubGeometry(geo, idx), mat);
			sub.name = `${tag}__${src.name || 'part'}${partIdx}`;
			sub.castShadow = src.castShadow;
			sub.receiveShadow = src.receiveShadow;
			sub.geometry.computeBoundingBox();
			const bb = sub.geometry.boundingBox!;
			(tag === 'BumperFront' ? frontBounds : rearBounds).union(bb);
			return sub;
		};
		if (frontIdx.length > 0) frontMeshes.push(mkSub(frontIdx, 'BumperFront'));
		if (rearIdx.length > 0) rearMeshes.push(mkSub(rearIdx, 'BumperRear'));
		partIdx++;
	}

	if (frontMeshes.length === 0 && rearMeshes.length === 0) return NOOP_SPLIT;

	// Build one hinge per end: pivot at the hinge corner C (top edge, at the region's rear for the front
	// bumper / front for the rear bumper, centered laterally), a `holder` child at -C carrying the sub-
	// meshes, so at rest the composite renders exactly as the un-split shell did. Parented under the
	// BodyShell group so both the pristine render AND the deformable registration frame match the shell.
	function makeEnd(meshes: THREE.Mesh[], bounds: THREE.Box3, isFront: boolean): BumperEnd | null {
		if (meshes.length === 0) return null;
		bounds.getCenter(_v);
		const cx = _v.x;
		const topY = bounds.max.y;
		const hingeZ = isFront ? bounds.min.z : bounds.max.z; // rear edge of front bumper / front edge of rear bumper
		const C = new THREE.Vector3(cx, topY, hingeZ);
		const pivot = new THREE.Object3D();
		pivot.name = isFront ? 'BumperFrontPivot' : 'BumperRearPivot';
		pivot.position.copy(C);
		const holder = new THREE.Object3D();
		holder.name = isFront ? 'BumperFrontHolder' : 'BumperRearHolder';
		holder.position.copy(C).multiplyScalar(-1);
		for (const m of meshes) holder.add(m);
		pivot.add(holder);
		bodyShell!.add(pivot);
		return { pivot, hinge: C.clone(), droopSign: isFront ? 1 : -1, detached: false, swing: 0, swingVel: 0 };
	}

	const front = makeEnd(frontMeshes, frontBounds, true);
	const rear = makeEnd(rearMeshes, rearBounds, false);

	const _euler = new THREE.Euler();
	function applyPose(end: BumperEnd): void {
		_euler.set(DROOP_ANGLE * end.droopSign * end.swing, 0, COCK_ANGLE * end.swing, 'XYZ');
		end.pivot.quaternion.setFromEuler(_euler);
		// Detach translation on top of the hinge rotation -- the bumper drops + gaps out past the nose/tail.
		end.pivot.position.set(
			end.hinge.x,
			end.hinge.y - DETACH_DROP_M * end.swing,
			end.hinge.z + end.droopSign * DETACH_OUT_M * end.swing,
		);
	}

	function advance(end: BumperEnd | null, dt: number, crush: number, threshold: number): void {
		if (!end) return;
		if (!end.detached && crush >= threshold) {
			end.detached = true;
			end.swingVel = SWING_KICK;
		}
		if (!end.detached) return;
		// Critically-ish damped spring toward the settled hanging pose (swing -> 1), with the detach kick
		// producing a visible overshoot -- a pure-visual pendulum, no physics body.
		end.swingVel += (SWING_STIFFNESS * (1 - end.swing) - SWING_DAMPING * end.swingVel) * dt;
		end.swing += end.swingVel * dt;
		if (end.swing < 0) {
			end.swing = 0;
			end.swingVel = 0;
		}
		applyPose(end);
	}

	function reset(): void {
		for (const end of [front, rear]) {
			if (!end) continue;
			end.detached = false;
			end.swing = 0;
			end.swingVel = 0;
			end.pivot.quaternion.identity();
			end.pivot.position.copy(end.hinge);
		}
	}

	return {
		hasFront: !!front,
		hasRear: !!rear,
		update(dt, frontCrushPlasticM, rearCrushPlasticM) {
			advance(front, dt, frontCrushPlasticM, DETACH_FRONT_CRUSH_M);
			advance(rear, dt, rearCrushPlasticM, DETACH_REAR_CRUSH_M);
		},
		reset,
		debug: () => ({
			hasFront: !!front,
			hasRear: !!rear,
			frontDetached: front?.detached ?? false,
			rearDetached: rear?.detached ?? false,
			frontSwing: front?.swing ?? 0,
			rearSwing: rear?.swing ?? 0,
		}),
	};
}
