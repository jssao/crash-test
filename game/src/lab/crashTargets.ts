// SPDX-License-Identifier: MIT
//
// Crash Lab "crash target" system: spawn ONE game model a set distance ahead of the car (in place of
// the standard barrier wall) so you can drive/launch into it individually and troubleshoot its crash
// physics. Self-contained (own file) — wired into ./main.ts with a handful of additive hooks, and it
// injects its OWN small DOM picker so it never touches ./hud.ts.
//
// The game's feature builders spawn whole fixed sets, so:
//   - Destructibles (crate/walls/pole/barrel/ramp): the single-body recipe is REPLICATED here from the
//     exported world/tuning.ts constants (the private single-body builders aren't exported). Plain
//     bodies need no per-step driver — the car's own shapes carry enableHitEvents, so the central
//     damage drain (damage/system.ts) crumples the car on contact automatically.
//   - Buildings + trees: added in a later pass (buildings via the exported single-structure builders +
//     a rigid offset; trees via the exported per-tree builders + stepTreesWorld).
//
// Each target is positioned relative to the vehicle's spawn pose. The lab always launches the car along
// world +Z (barriers.ts), so a target sits at (spawnX, y, spawnZ + distanceAhead).

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { Body, BodyType, type World } from '../../../src/ts/index.js';
import { InterpolatedTransform } from '../core/loop';
import type { Vehicle } from '../vehicle/vehicle';
import { buildDestructibleMaterials, disposeDestructibleMaterials, type DestructibleMaterialSets } from '../world/materials';
import { wedgeHullPoints } from '../world/bodies';
import {
	BARREL_FRICTION,
	BARREL_HEIGHT_M,
	BARREL_MASS_KG,
	BARREL_RADIUS_M,
	BARREL_SIDES,
	CRATE_FRICTION,
	CRATE_HALF_EXTENT_M,
	CRATE_MASS_KG,
	POLE_FRICTION,
	POLE_MASS_KG,
	POLE_SHAFT_HALF_EXTENTS_M,
	WALL_BLOCK_FRICTION,
	WALL_BLOCK_HALF_EXTENTS_M,
} from '../world/tuning';

/** A crash-lab entity id base outside every reserved range (car 1–21, occupants 1000–1399, feature
 * bases 45–47M). Each target body gets a unique id here, tagged via setUserData + registered in the
 * damage system's foreignMasses so a car hit against it is MASS-ATTENUATED exactly like the game (a
 * 15 kg crate barely dents the car; only the immovable barrier deals full wall-strength damage). */
const CRASH_TARGET_ENTITY_ID_BASE = 48_000_000;

export interface CrashTargetSpec {
	readonly id: string;
	readonly label: string;
	readonly category: string;
}

/** Catalog shown in the picker. Grows as each tier lands (destructibles now; buildings + trees next). */
export const CRASH_TARGETS: readonly CrashTargetSpec[] = [
	{ id: 'crate', label: 'Wooden crate', category: 'Props' },
	{ id: 'wall-concrete', label: 'Concrete wall block', category: 'Props' },
	{ id: 'wall-brick', label: 'Brick wall block', category: 'Props' },
	{ id: 'pole', label: 'Utility pole', category: 'Props' },
	{ id: 'barrel-blue', label: 'Blue barrel', category: 'Props' },
	{ id: 'barrel-rust', label: 'Rust barrel', category: 'Props' },
	{ id: 'ramp', label: 'Ramp', category: 'Props' },
];

export interface SpawnCtx {
	world: World;
	scene: THREE.Scene;
	vehicle: Vehicle;
	distanceAhead: number;
	/** Damage system's foreign-mass map — target masses register here for realistic (mass-attenuated)
	 * car damage. Null falls back to wall-strength. */
	foreignMasses: Map<number, number> | null;
}

export interface CrashTargetHandle {
	/** Sample dynamic-body transforms once per fixed step (after world.step()). */
	afterFixedStep(dt: number): void;
	/** Interpolate visuals once per render frame. */
	applyVisuals(alpha: number): void;
	/** Destroy every body + dispose every visual/material this target owns. */
	teardown(): void;
}

// ------------------------------------------------------------------------------------------------
// Shared body/visual plumbing
// ------------------------------------------------------------------------------------------------

interface Piece {
	readonly body: Body;
	readonly mesh: THREE.Mesh;
	readonly transform: InterpolatedTransform;
	readonly dynamic: boolean;
	/** Registered foreign-mass entity id, cleared from the map on teardown (null = not registered). */
	readonly entityId: number | null;
}

function placePiece(body: Body, mesh: THREE.Mesh, dynamic: boolean, entityId: number | null = null): Piece {
	const t = body.getTransform();
	mesh.position.set(t.position.x, t.position.y, t.position.z);
	mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	const transform = new InterpolatedTransform();
	transform.sample(t.position, t.rotation);
	transform.sample(t.position, t.rotation);
	return { body, mesh, transform, dynamic, entityId };
}

/** n-gon prism point cloud (convex hull of a 12-gon barrel), matching world/bodies.ts's private
 * ngonPrismPoints() — hull is computed from the cloud so exact vertex order is irrelevant. */
function ngonPrismPoints(sides: number, radius: number, height: number): Float32Array {
	const pts = new Float32Array(sides * 2 * 3);
	const hy = height / 2;
	for (let i = 0; i < sides; i++) {
		const a = (i / sides) * Math.PI * 2;
		const x = Math.cos(a) * radius;
		const z = Math.sin(a) * radius;
		pts[i * 6 + 0] = x;
		pts[i * 6 + 1] = -hy;
		pts[i * 6 + 2] = z;
		pts[i * 6 + 3] = x;
		pts[i * 6 + 4] = hy;
		pts[i * 6 + 5] = z;
	}
	return pts;
}

const boxVolume = (hx: number, hy: number, hz: number): number => 8 * hx * hy * hz;
const ngonArea = (sides: number, radius: number): number => (sides / 2) * radius * radius * Math.sin((2 * Math.PI) / sides);

/** Bundles a set of pieces into a CrashTargetHandle. `extraStep`/`extraTeardown` let feature-backed
 * targets (buildings/trees, later) run their own per-step break logic + custom teardown. */
function makeTarget(
	scene: THREE.Scene,
	pieces: Piece[],
	materials: DestructibleMaterialSets | null,
	foreignMasses: Map<number, number> | null,
	extraStep?: (dt: number) => void,
	extraTeardown?: () => void,
): CrashTargetHandle {
	for (const p of pieces) scene.add(p.mesh);
	return {
		afterFixedStep(dt) {
			extraStep?.(dt);
			for (const p of pieces) {
				if (!p.dynamic) continue;
				const t = p.body.getTransform();
				p.transform.sample(t.position, t.rotation);
			}
		},
		applyVisuals(alpha) {
			for (const p of pieces) if (p.dynamic) p.transform.applyTo(p.mesh, alpha);
		},
		teardown() {
			extraTeardown?.();
			for (const p of pieces) {
				if (p.entityId !== null) foreignMasses?.delete(p.entityId);
				scene.remove(p.mesh);
				p.mesh.geometry.dispose();
				p.body.destroy();
			}
			if (materials) disposeDestructibleMaterials(materials);
		},
	};
}

// ------------------------------------------------------------------------------------------------
// Destructible single-body targets
// ------------------------------------------------------------------------------------------------

function spawnBox(
	world: World,
	pos: { x: number; y: number; z: number },
	half: { x: number; y: number; z: number },
	massKg: number,
	friction: number,
	material: THREE.Material,
	angularDamping: number,
	linearDamping: number,
	entityId: number,
	foreignMasses: Map<number, number> | null,
): Piece {
	const body = world.createBody({ type: BodyType.Dynamic, position: pos, angularDamping, linearDamping });
	const density = massKg / boxVolume(half.x, half.y, half.z);
	body.createBoxShape({ halfExtents: half, density, friction });
	body.applyMassFromShapes();
	body.setUserData(entityId);
	foreignMasses?.set(entityId, massKg);
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2), material);
	return placePiece(body, mesh, true, entityId);
}

function spawnBarrel(world: World, pos: { x: number; y: number; z: number }, material: THREE.Material, entityId: number, foreignMasses: Map<number, number> | null): Piece {
	const body = world.createBody({ type: BodyType.Dynamic, position: pos, angularDamping: 0.7, linearDamping: 0.08 });
	const density = BARREL_MASS_KG / (ngonArea(BARREL_SIDES, BARREL_RADIUS_M) * BARREL_HEIGHT_M);
	body.createHullShape(ngonPrismPoints(BARREL_SIDES, BARREL_RADIUS_M, BARREL_HEIGHT_M), { density, friction: BARREL_FRICTION });
	body.applyMassFromShapes();
	body.setUserData(entityId);
	foreignMasses?.set(entityId, BARREL_MASS_KG);
	const mesh = new THREE.Mesh(new THREE.CylinderGeometry(BARREL_RADIUS_M, BARREL_RADIUS_M, BARREL_HEIGHT_M, BARREL_SIDES), material);
	return placePiece(body, mesh, true, entityId);
}

function spawnRamp(world: World, pos: { x: number; y: number; z: number }, material: THREE.Material): Piece {
	const width = 4;
	const upLength = 2.6;
	const height = 0.85;
	const back = 0.7;
	const flat = wedgeHullPoints(width, upLength, height, back);
	const body = world.createBody({ type: BodyType.Static, position: pos });
	body.createHullShape(flat, { density: 1, friction: 0.8 });
	const points: THREE.Vector3[] = [];
	for (let i = 0; i < flat.length; i += 3) points.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
	const geo = new ConvexGeometry(points);
	geo.computeVertexNormals();
	return placePiece(body, new THREE.Mesh(geo, material), false);
}

// ------------------------------------------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------------------------------------------

export function spawnCrashTarget(id: string, ctx: SpawnCtx): CrashTargetHandle | null {
	const base = ctx.vehicle.spawnPosition;
	const cx = base.x;
	const cz = base.z + ctx.distanceAhead;
	const eid = CRASH_TARGET_ENTITY_ID_BASE;
	const fm = ctx.foreignMasses;
	const mats = buildDestructibleMaterials();

	switch (id) {
		case 'crate': {
			const h = { x: CRATE_HALF_EXTENT_M, y: CRATE_HALF_EXTENT_M, z: CRATE_HALF_EXTENT_M };
			return makeTarget(ctx.scene, [spawnBox(ctx.world, { x: cx, y: h.y, z: cz }, h, CRATE_MASS_KG, CRATE_FRICTION, mats.wood.material, 1.3, 0.08, eid, fm)], mats, fm);
		}
		case 'wall-concrete':
		case 'wall-brick': {
			const h = WALL_BLOCK_HALF_EXTENTS_M;
			const material = id === 'wall-brick' ? mats.brick.material : mats.concrete.material;
			return makeTarget(ctx.scene, [spawnBox(ctx.world, { x: cx, y: h.y, z: cz }, h, 20, WALL_BLOCK_FRICTION, material, 1.6, 0.15, eid, fm)], mats, fm);
		}
		case 'pole': {
			const h = POLE_SHAFT_HALF_EXTENTS_M;
			return makeTarget(ctx.scene, [spawnBox(ctx.world, { x: cx, y: h.y, z: cz }, h, POLE_MASS_KG, POLE_FRICTION, mats.wood.material, 1.2, 0.08, eid, fm)], mats, fm);
		}
		case 'barrel-blue':
			return makeTarget(ctx.scene, [spawnBarrel(ctx.world, { x: cx, y: BARREL_HEIGHT_M / 2, z: cz }, mats.barrelBlue.material, eid, fm)], mats, fm);
		case 'barrel-rust':
			return makeTarget(ctx.scene, [spawnBarrel(ctx.world, { x: cx, y: BARREL_HEIGHT_M / 2, z: cz }, mats.barrelRust.material, eid, fm)], mats, fm);
		case 'ramp':
			// Static wedge — immovable, so no foreign mass (reads wall-like, which is correct for a ramp).
			return makeTarget(ctx.scene, [spawnRamp(ctx.world, { x: cx, y: 0, z: cz }, mats.concrete.material)], mats, fm);
		default:
			disposeDestructibleMaterials(mats);
			return null;
	}
}

// ------------------------------------------------------------------------------------------------
// DOM picker (injected — keeps ./hud.ts untouched)
// ------------------------------------------------------------------------------------------------

export interface PickerCallbacks {
	onTarget(id: string | null): void;
	onDistance(m: number): void;
}

const PICKER_STYLE = `
.mvct { position: absolute; left: 16px; bottom: 16px; z-index: 8; pointer-events: auto;
  background: rgba(12,15,19,0.86); border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
  padding: 10px 12px; color: #dfe8f0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
.mvct-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em; color: #6f8398; font-weight: 600; margin-bottom: 7px; }
.mvct-row { display: flex; align-items: center; gap: 8px; }
.mvct select, .mvct input { background: rgba(255,255,255,0.06); color: #eaf4ff; border: 1px solid rgba(255,255,255,0.12);
  border-radius: 6px; padding: 5px 8px; font-size: 12px; font-family: inherit; outline: none; }
.mvct select:focus, .mvct input:focus { border-color: #4fa8ff; }
.mvct label { font-size: 11px; color: #9fb2c6; }
.mvct input { width: 52px; }
`;

export function installCrashTargetPicker(root: HTMLElement, cb: PickerCallbacks): void {
	const style = document.createElement('style');
	style.textContent = PICKER_STYLE;
	document.head.appendChild(style);

	const panel = document.createElement('div');
	panel.className = 'mvct';
	panel.innerHTML = `<div class="mvct-h">Crash target</div>`;
	const row = document.createElement('div');
	row.className = 'mvct-row';

	const select = document.createElement('select');
	const none = document.createElement('option');
	none.value = '';
	none.textContent = 'Barrier (default)';
	select.appendChild(none);
	let lastCat = '';
	let group: HTMLOptGroupElement | null = null;
	for (const t of CRASH_TARGETS) {
		if (t.category !== lastCat) {
			group = document.createElement('optgroup');
			group.label = t.category;
			select.appendChild(group);
			lastCat = t.category;
		}
		const opt = document.createElement('option');
		opt.value = t.id;
		opt.textContent = t.label;
		(group ?? select).appendChild(opt);
	}
	select.addEventListener('change', () => cb.onTarget(select.value || null));

	const distLabel = document.createElement('label');
	distLabel.textContent = 'dist';
	const dist = document.createElement('input');
	dist.type = 'number';
	dist.min = '4';
	dist.max = '60';
	dist.step = '1';
	dist.value = '14';
	dist.addEventListener('change', () => cb.onDistance(Math.max(4, Math.min(60, Number(dist.value) || 14))));

	row.appendChild(select);
	row.appendChild(distLabel);
	row.appendChild(dist);
	panel.appendChild(row);
	root.appendChild(panel);
}
