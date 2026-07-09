// SPDX-License-Identifier: MIT
//
// Panel-mesh reparenting (G3 spec, INTEGRATION section): "while attached, panel meshes stay parented
// under the car group but must follow their OWN body transforms once loosened/broken". While a panel
// is attached, its mesh is just an ordinary descendant of car.root and needs no special per-frame
// handling (car.root's own transform, driven by the chassis, carries it along -- same as every other
// non-detachable body panel). The moment a panel loosens or breaks, this module reparents its node(s)
// to the scene root (preserving current world transform, same `scene.attach()` pattern as
// game/src/scene/wheels.ts's detachWheelVisuals()) and from then on drives it directly from the panel
// BODY's own transform every fixed step, via a fixed local offset -- see PRECOMPUTED OFFSET below.
//
// PRECOMPUTED OFFSET (root-cause fix): the body-local offset (position + rotation) between a panel
// NODE's own pivot and its physics BODY's origin/rest-rotation is a CONSTANT, fully determined by
// car-map.ts data -- it never changes at runtime. Earlier this offset was CAPTURED empirically, live,
// at the exact instant reparentPanelVisual() first ran (i.e. the first 'panelLoosened'/'panelBroken'
// event), by reading the mesh's current THREE.Object3D.matrixWorld and comparing it to the panel
// body's just-read physics transform. That is fragile: main.ts's/diag-main.ts's fixed-step order calls
// stepDamageSystem() (which synchronously fires this capture) BEFORE updating car.root's rendered
// transform for the CURRENT step -- so at capture time car.root (and therefore the mesh's matrixWorld)
// still reflects the PREVIOUS step's chassis pose, while the panel body's transform passed in is
// already the fresh, current-step one. During a calm moment the two are nearly identical (sub-frame
// chassis motion), so the captured offset was still accurate to a fraction of a degree -- but during a
// single violent high-speed-impact step (chassis rotating tens of degrees in one step), that one-frame
// mismatch corrupted the ENTIRE forever-after offset, reproducing the original "hood 3m below its
// body" symptom for whichever panel happened to break/loosen on exactly such a step (measured: 87-90deg
// residual error surviving a 90 km/h crash, even after panels.ts's rotation fix, until this change).
//
// Computing the offset analytically instead -- at createPanelVisuals() time, called once right after
// the GLB loads and BEFORE any physics step, when car.root is still at its pristine identity transform
// (buildScene.ts's doc comment) -- removes the staleness dependency entirely:
//   - ROTATION offset is always IDENTITY: panels.ts's createPanels() spawns/welds every panel body at
//     exactly chassisRotation * node.worldQuat, and (while attached) the mesh's own world rotation
//     under car.root is ALSO always chassisRotation * node.worldQuat (car.root's rotation IS the
//     chassis rotation, every frame, by construction) -- so their ratio is identity at every instant,
//     not just at whatever instant happened to be sampled.
//   - POSITION offset is a genuine non-zero constant (a panel body's origin is its measured bbox
//     centroid -- car-map.ts's centerMm -- which does NOT generally coincide with the GLB node's own
//     authored pivot), but it's derivable from car-map.ts data alone, with no live scene-graph read
//     required at all except the one safe, guaranteed-non-stale read right after load.

import * as THREE from 'three';
import { PANEL_KEYS, PANEL_NODE_NAMES, type PanelKey } from '../damage/panels';
import { CAR_MAP, type Vec3Mm } from '../assets/car-map';
import { CHASSIS_ORIGIN_HEIGHT_M } from '../vehicle/tuning';
import { InterpolatedTransform } from '../core/loop';

/** Same mm->local-meters conversion as panels.ts's (private) mmToLocalCenter() -- kept as an
 * independent copy (that module's own doc comment explains why: avoiding an import cycle elsewhere in
 * this same file group is the established convention here, even though there's no actual cycle risk
 * for THIS particular pair of modules). */
function mmToLocalCenter(centerMm: Vec3Mm): THREE.Vector3 {
	return new THREE.Vector3(centerMm[0] / 1000, centerMm[1] / 1000 - CHASSIS_ORIGIN_HEIGHT_M, centerMm[2] / 1000);
}

export interface PanelVisual {
	readonly key: PanelKey;
	readonly object: THREE.Object3D;
	readonly transform: InterpolatedTransform;
	reparented: boolean;
	/** Fixed body-local offset (position + rotation), precomputed analytically at creation time (see
	 * this module's doc comment) -- meaningful (and used) regardless of `reparented`'s value once a
	 * panel is loosened/broken, since it never changes. */
	readonly offsetPos: THREE.Vector3;
	readonly offsetQuat: THREE.Quaternion;
	/** This panel node's ORIGINAL local position/rotation under carRoot, captured once at creation
	 * time (before any reparenting) -- used by repairPanelVisual() to put it back exactly where it
	 * started for the "R = full car repair" reset (main.ts). */
	readonly originalLocalPos: THREE.Vector3;
	readonly originalLocalQuat: THREE.Quaternion;
}

const scratchWorldPos = new THREE.Vector3();
const scratchWorldQuat = new THREE.Quaternion();
const scratchWorldScale = new THREE.Vector3();

/** Finds each panel's own node (by car-map.ts name) under `carRoot` and precomputes its fixed
 * body-local offset (see this module's doc comment). Call once at scene build time, BEFORE any panel
 * has loosened/broken AND before any physics step (carRoot must still be at its pristine identity
 * transform -- true right after loadCar(), per buildScene.ts's doc comment). */
export function createPanelVisuals(carRoot: THREE.Object3D): Record<PanelKey, PanelVisual> {
	const result = {} as Record<PanelKey, PanelVisual>;
	carRoot.updateWorldMatrix(true, false);
	for (const key of PANEL_KEYS) {
		const nodeName = PANEL_NODE_NAMES[key];
		const object = carRoot.getObjectByName(nodeName);
		if (!object) {
			console.warn(`[panelVisuals] expected panel node "${nodeName}" not found in loaded car scene`);
			continue;
		}
		const node = CAR_MAP.panels[nodeName];
		object.updateWorldMatrix(true, false);
		object.matrixWorld.decompose(scratchWorldPos, scratchWorldQuat, scratchWorldScale);

		// Rotation offset: always identity (see doc comment) -- no computation needed.
		const offsetQuat = new THREE.Quaternion();

		// Position offset: chassis-local mesh pivot minus the panel body's own chassis-local origin
		// (car-map.ts's centerMm), un-rotated into the body's own local frame via inverse(nodeWorldQuat)
		// (mirrors panels.ts's createPanels()/carDeformables.ts's chassis-local <-> panel-body-local
		// conversion -- see those modules' doc comments for the same rotation-remap derivation).
		const nodeWorldQuat = new THREE.Quaternion(node.worldQuat[0], node.worldQuat[1], node.worldQuat[2], node.worldQuat[3]);
		const invNodeWorldQuat = nodeWorldQuat.clone().invert();
		const localCenter = mmToLocalCenter(node.centerMm);
		const chassisLocalMeshPos = scratchWorldPos.clone();
		chassisLocalMeshPos.y -= CHASSIS_ORIGIN_HEIGHT_M;
		const offsetPos = chassisLocalMeshPos.sub(localCenter).applyQuaternion(invNodeWorldQuat);

		result[key] = {
			key,
			object,
			transform: new InterpolatedTransform(),
			reparented: false,
			offsetPos,
			offsetQuat,
			originalLocalPos: object.position.clone(),
			originalLocalQuat: object.quaternion.clone(),
		};
	}
	return result;
}

/** Loud but non-fatal: a LARGE disagreement between the precomputed offset and the live-captured pose
 * at the exact reparent instant would mean car-map.ts's data and the loaded scene have drifted apart
 * (e.g. a stale car-map.ts after a GLB update) -- surfaced once per panel so a real regression doesn't
 * silently reproduce the original ~90deg/~3m stale-offset bug this module's doc comment describes.
 * Deliberately generous (NOT a tight sub-degree check): the live capture this compares against is
 * exactly the fragile, one-physics-step-stale read this module's fix replaces (see doc comment above)
 * -- during a genuinely violent single-step impact (chassis rotating several degrees in one fixed
 * step) that live read can legitimately disagree with the correct precomputed offset by a few degrees/
 * tens of centimeters even with NO bug at all (measured up to ~4deg/~0.3m during a 90 km/h test crash).
 * Thresholds sit well above that legitimate noise floor but well below the original bug's signature
 * (~90deg/~3m), so this only fires on an actual car-map/GLB mismatch, not routine hard-crash physics. */
const SANITY_ANGLE_DEG = 20;
const SANITY_POS_M = 0.6;

/** Reparents one panel's visual to `scene` (preserving its current world transform) -- the panel's
 * driving offset was already fixed at createPanelVisuals() time, so this now ONLY performs the
 * scene-graph move. `panelBodyPos`/`panelBodyQuat` (the panel body's current physics transform) are
 * kept as call-site-compatible parameters and used purely as a sanity check against the precomputed
 * offset (see SANITY_ANGLE_DEG/SANITY_POS_M doc comment) -- not to (re)derive it. Call once, the first
 * time a panel's damage state leaves 'attached' (loosened or broken -- see main.ts's event
 * subscription). */
export function reparentPanelVisual(visual: PanelVisual, scene: THREE.Scene, panelBodyPos: THREE.Vector3, panelBodyQuat: THREE.Quaternion): void {
	if (visual.reparented) return;
	visual.object.updateWorldMatrix(true, false);
	visual.object.matrixWorld.decompose(scratchWorldPos, scratchWorldQuat, scratchWorldScale);

	const expectedWorldPos = panelBodyPos.clone().add(visual.offsetPos.clone().applyQuaternion(panelBodyQuat));
	const expectedWorldQuat = panelBodyQuat.clone().multiply(visual.offsetQuat);
	const posErr = scratchWorldPos.distanceTo(expectedWorldPos);
	const angleErr = (2 * Math.acos(Math.min(1, Math.abs(scratchWorldQuat.dot(expectedWorldQuat)))) * 180) / Math.PI;
	if (posErr > SANITY_POS_M || angleErr > SANITY_ANGLE_DEG) {
		console.warn(
			`[panelVisuals] "${visual.key}" precomputed offset disagrees with the live capture at reparent time ` +
				`(posErr=${posErr.toFixed(3)}m, angleErr=${angleErr.toFixed(2)}deg) -- car-map.ts may be stale for this GLB.`,
		);
	}

	scene.attach(visual.object); // re-parents while preserving world transform
	visual.object.position.copy(scratchWorldPos);
	visual.object.quaternion.copy(scratchWorldQuat);
	visual.object.scale.copy(scratchWorldScale);
	visual.reparented = true;
}

/** Undoes reparentPanelVisual(): puts a loosened/broken panel's node back under `carRoot` at its
 * original (pre-damage) local transform, for the "R = full car repair" reset (main.ts). No-op if the
 * panel was never reparented in the first place (still attached, nothing to repair). */
export function repairPanelVisual(visual: PanelVisual, carRoot: THREE.Object3D): void {
	if (!visual.reparented) return;
	carRoot.add(visual.object); // plain re-parent (does NOT preserve world transform, unlike .attach())
	visual.object.position.copy(visual.originalLocalPos);
	visual.object.quaternion.copy(visual.originalLocalQuat);
	visual.reparented = false;
}

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

/** Applies one reparented panel's interpolated body transform for the current render frame (no-op if
 * still attached -- car.root's own transform already carries it). */
export function applyPanelVisual(visual: PanelVisual, alpha: number): void {
	if (!visual.reparented) return;
	visual.transform.lerpPosition(scratchPos, alpha);
	visual.transform.lerpQuaternion(scratchQuat, alpha);
	visual.object.quaternion.copy(scratchQuat).multiply(visual.offsetQuat);
	scratchPos.add(visual.offsetPos.clone().applyQuaternion(scratchQuat));
	visual.object.position.copy(scratchPos);
}
