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
	/** This panel node's ORIGINAL local position/rotation under its ORIGINAL PARENT (originalParent
	 * below -- NOT carRoot directly), captured once at creation time (before any reparenting) -- used
	 * by repairPanelVisual() to put it back exactly where it started for the "R = full car repair"
	 * reset (main.ts). */
	readonly originalLocalPos: THREE.Vector3;
	readonly originalLocalQuat: THREE.Quaternion;
	/** The panel node's ORIGINAL parent in the loaded GLB scene graph, captured once at creation time.
	 * Panel nodes are NOT direct children of carRoot -- every panel lives under an intermediate GLB
	 * group node ('BodyUnderside' for hood/doorL/doorR/roof, 'BodyRearPanelsColor1' for hatch) that
	 * carries a baked ~-90deg-about-X rotation (car-map.ts's PanelNode.worldQuat doc comment). The
	 * originalLocal{Pos,Quat} above are expressed relative to THIS parent, so repairPanelVisual() must
	 * re-attach to it (not to carRoot) or those local values land in the wrong frame -- rendering the
	 * repaired panel ~90deg mis-posed even though every physics hook reports it pristine/attached (the
	 * "wrecked hood/doors on a freshly-reset car" blocker: reset-integrity.mjs). */
	readonly originalParent: THREE.Object3D;
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

		// STALENESS CHECK (car-map vs loaded GLB): done HERE, at pristine identity transform, where the
		// live scene-graph read is guaranteed frame-fresh -- NOT at reparent time (the old check there
		// compared against the mesh's last-RENDERED world pose, which under scripted stepN() batches
		// (verify/soak scripts run many fixed steps between renders) is arbitrarily stale, producing
		// spurious posErr warnings that scale with distance driven since the last render).
		const recordedQuat = new THREE.Quaternion(node.worldQuat[0], node.worldQuat[1], node.worldQuat[2], node.worldQuat[3]);
		const staleAngleDeg = (2 * Math.acos(Math.min(1, Math.abs(scratchWorldQuat.dot(recordedQuat)))) * 180) / Math.PI;
		if (staleAngleDeg > 5) {
			console.warn(
				`[panelVisuals] "${nodeName}" loaded-GLB world rotation disagrees with car-map.ts by ${staleAngleDeg.toFixed(2)}deg -- car-map.ts is stale for this GLB (regenerate via scripts/analyze-car.mjs).`,
			);
		}

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
			// Captured BEFORE any reparenting (loadCar() just ran, nothing has loosened yet) -- this is
			// the panel node's authored GLB parent (an intermediate rotated group, NOT carRoot). The GLB
			// hierarchy above the panels is never rebuilt on reset (only the physics vehicle is), so this
			// reference stays valid for the lifetime of the scene. Falls back to carRoot only in the
			// (never-observed) degenerate case of a panel node authored directly at the scene root.
			originalParent: object.parent ?? carRoot,
		};
	}
	return result;
}

/** Reparents one panel's visual to `scene` and places it directly at its body-derived pose (the
 * precomputed offset applied to the panel body's CURRENT physics transform). The mesh's own rendered
 * world pose is deliberately NOT used: under scripted stepN() batches (verify/soak scripts run many
 * fixed steps between renders) the rendered pose is arbitrarily stale -- capturing it here produced
 * both a spurious "stale car-map" warning (posErr scaling with distance driven since the last render)
 * and a one-frame teleport-through-stale-pose flicker. The car-map-vs-GLB staleness check this
 * replaces lives in createPanelVisuals() now, where the scene-graph read is guaranteed fresh. Call
 * once, the first time a panel's damage state leaves 'attached' (loosened or broken -- see main.ts's
 * event subscription). */
export function reparentPanelVisual(visual: PanelVisual, scene: THREE.Scene, panelBodyPos: THREE.Vector3, panelBodyQuat: THREE.Quaternion): void {
	if (visual.reparented) return;
	scene.attach(visual.object); // re-parents (preserves world transform; overwritten just below)
	visual.object.position.copy(panelBodyPos).add(visual.offsetPos.clone().applyQuaternion(panelBodyQuat));
	visual.object.quaternion.copy(panelBodyQuat).multiply(visual.offsetQuat);
	visual.reparented = true;
}

/** Undoes reparentPanelVisual(): puts a loosened/broken panel's node back under its ORIGINAL GLB
 * parent (visual.originalParent -- NOT carRoot; see that field's doc comment) at its original
 * (pre-damage) local transform, for the "R = full car repair" reset (main.ts). Re-attaching to the
 * original parent is required because originalLocal{Pos,Quat} are expressed in THAT parent's frame,
 * which is rotated ~90deg relative to carRoot -- restoring them under carRoot mis-poses the panel by
 * exactly that rotation (the "wrecked hood/doors on a freshly-reset car" blocker). No-op if the panel
 * was never reparented in the first place (still attached, nothing to repair). */
export function repairPanelVisual(visual: PanelVisual, _carRootUnused?: THREE.Object3D): void {
	// `_carRootUnused` is retained ONLY so the existing two-arg call sites (main.ts + the verify/diag
	// harness) still type-check unchanged: re-parenting now targets visual.originalParent, so carRoot
	// is no longer needed or read here.
	if (!visual.reparented) return;
	visual.originalParent.add(visual.object); // plain re-parent (does NOT preserve world transform, unlike .attach())
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
