// SPDX-License-Identifier: MIT
//
// Panel-mesh reparenting (G3 spec, INTEGRATION section): "while attached, panel meshes stay parented
// under the car group but must follow their OWN body transforms once loosened/broken". While a panel
// is attached, its mesh is just an ordinary descendant of car.root and needs no special per-frame
// handling (car.root's own transform, driven by the chassis, carries it along -- same as every other
// non-detachable body panel). The moment a panel loosens or breaks, this module reparents its node(s)
// to the scene root (preserving current world transform, same `scene.attach()` pattern as
// game/src/scene/wheels.ts's detachWheelVisuals()) and from then on drives it directly from the panel
// BODY's own transform every fixed step, via a fixed local offset captured at the exact reparent
// instant (mirrors wheels.ts's applyWheelVisual() "authored-orientation delta" trick, generalized to
// also carry a position offset -- a panel body's origin is its measured bbox centroid, which does NOT
// generally coincide with the GLB node's own authored pivot, unlike a wheel hub).

import * as THREE from 'three';
import { PANEL_KEYS, PANEL_NODE_NAMES, type PanelKey } from '../damage/panels';
import { InterpolatedTransform } from '../core/loop';

export interface PanelVisual {
	readonly key: PanelKey;
	readonly object: THREE.Object3D;
	readonly transform: InterpolatedTransform;
	reparented: boolean;
	/** Fixed body-local offset (position + rotation) captured at the exact reparent instant -- see
	 * this module's doc comment. Only meaningful once `reparented` is true. */
	offsetPos: THREE.Vector3;
	offsetQuat: THREE.Quaternion;
	/** This panel node's ORIGINAL local position/rotation under carRoot, captured once at creation
	 * time (before any reparenting) -- used by repairPanelVisual() to put it back exactly where it
	 * started for the "R = full car repair" reset (main.ts). */
	readonly originalLocalPos: THREE.Vector3;
	readonly originalLocalQuat: THREE.Quaternion;
}

/** Finds each panel's own node (by car-map.ts name) under `carRoot`. Call once at scene build time,
 * BEFORE any panel has loosened/broken (nodes are still parented under carRoot at this point). */
export function createPanelVisuals(carRoot: THREE.Object3D): Record<PanelKey, PanelVisual> {
	const result = {} as Record<PanelKey, PanelVisual>;
	for (const key of PANEL_KEYS) {
		const nodeName = PANEL_NODE_NAMES[key];
		const object = carRoot.getObjectByName(nodeName);
		if (!object) {
			console.warn(`[panelVisuals] expected panel node "${nodeName}" not found in loaded car scene`);
			continue;
		}
		result[key] = {
			key,
			object,
			transform: new InterpolatedTransform(),
			reparented: false,
			offsetPos: new THREE.Vector3(),
			offsetQuat: new THREE.Quaternion(),
			originalLocalPos: object.position.clone(),
			originalLocalQuat: object.quaternion.clone(),
		};
	}
	return result;
}

const scratchWorldPos = new THREE.Vector3();
const scratchWorldQuat = new THREE.Quaternion();
const scratchWorldScale = new THREE.Vector3();
const scratchInvQuat = new THREE.Quaternion();

/** Reparents one panel's visual to `scene` (preserving its current world transform) and captures the
 * fixed body-local offset from `panelBody`'s CURRENT transform. Call once, the first time a panel's
 * damage state leaves 'attached' (loosened or broken -- see main.ts's event subscription). */
export function reparentPanelVisual(visual: PanelVisual, scene: THREE.Scene, panelBodyPos: THREE.Vector3, panelBodyQuat: THREE.Quaternion): void {
	if (visual.reparented) return;
	visual.object.updateWorldMatrix(true, false);
	visual.object.matrixWorld.decompose(scratchWorldPos, scratchWorldQuat, scratchWorldScale);

	scene.attach(visual.object); // re-parents while preserving world transform
	visual.object.position.copy(scratchWorldPos);
	visual.object.quaternion.copy(scratchWorldQuat);
	visual.object.scale.copy(scratchWorldScale);

	scratchInvQuat.copy(panelBodyQuat).invert();
	visual.offsetQuat.copy(scratchInvQuat).multiply(scratchWorldQuat);
	visual.offsetPos.copy(scratchWorldPos).sub(panelBodyPos).applyQuaternion(scratchInvQuat);
	visual.reparented = true;
}

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

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
