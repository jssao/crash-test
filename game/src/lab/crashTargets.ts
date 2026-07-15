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
import { Body, BodyType, forgetHandle, type World } from '../../../src/ts/index.js';
import { InterpolatedTransform } from '../core/loop';
import type { Vehicle } from '../vehicle/vehicle';
import { buildDestructibleMaterials, disposeDestructibleMaterials, type DestructibleMaterialSets } from '../world/materials';
import {
	wedgeHullPoints,
	buildPole,
	pollPoleBreak,
	destroyPole,
	buildCrateProp,
	stepCrateFractures,
	destroyCrateProp,
	type CrateProp,
	type PropFractureContext,
} from '../world/bodies';
import { poleShaftGeometry, addPoleDressing, disposeMeshTree, createBarrelDeformable, applyBarrelDentAtWorldPoint } from '../world/visuals';
import type { DeformableMeshHandle } from '../damage/crumple';
// Feature-backed targets (trees + buildings) — reuse the game's REAL physics + visuals so the fracture
// behaviour you're troubleshooting is exactly the game's.
import {
	spawnSingleTree,
	destroySingleTree,
	stepTreesWorld,
	TREES_MEMBER_ENTITY_ID_BASE,
	type TreesWorld,
	type TreesFractureContext,
	type SaplingTree,
	type MidTree,
	type LargeTree,
} from '../world/features/trees/bodies';
import { buildTreesVisuals, sampleTreesVisuals, applyTreesVisuals, disposeTreesVisuals } from '../world/features/trees/visuals';
import type { TreeSiteXZ } from '../world/features/trees/tuning';
import { buildShed, buildHouseCorner, buildBrickWallLab, buildFenceLine, pollStructureBreaks, type Structure, type StructureFractureContext } from '../world/features/buildings/structures';
import { buildSupportGraph, pollStructureCollapse } from '../world/features/buildings/support';
import { buildBuildingsVisuals, sampleBuildingsVisuals, applyBuildingsVisuals, disposeBuildingsVisuals, spawnFragmentVisuals } from '../world/features/buildings/visuals';
import { createFractureBudget, createFractureIdAllocator, resetFractureBudget, FRACTURE_FRAGMENT_ENTITY_ID_BASE } from '../world/features/fracture';
import {
	BARREL_DENT_MASS_FACTOR_EMPTY,
	BARREL_DENT_MASS_FACTOR_FULL,
	BARREL_DENT_TRIGGER_SPEED_MS,
	BARREL_FRICTION,
	BARREL_HEIGHT_M,
	BARREL_MASS_KG_BY_MATERIAL,
	BARREL_RADIUS_M,
	BARREL_SIDES,
	type BarrelMaterial,
	CRATE_HALF_EXTENT_M,
	CRATE_MASS_KG,
	POLE_CROSSARM_HEIGHT_FRACTION,
	POLE_HEIGHT_M,
	POLE_MASS_KG,
	POLE_SHAFT_RADIUS_M,
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

/** Catalog shown in the picker. Props = replicated single bodies; Trees + Buildings = the game's real
 * fracture physics. */
export const CRASH_TARGETS: readonly CrashTargetSpec[] = [
	{ id: 'crate', label: 'Wooden crate', category: 'Props' },
	{ id: 'wall-concrete', label: 'Concrete wall block', category: 'Props' },
	{ id: 'wall-brick', label: 'Brick wall block', category: 'Props' },
	{ id: 'pole', label: 'Utility pole', category: 'Props' },
	{ id: 'barrel-blue', label: 'Blue barrel', category: 'Props' },
	{ id: 'barrel-rust', label: 'Rust barrel', category: 'Props' },
	{ id: 'ramp', label: 'Ramp', category: 'Props' },
	{ id: 'tree-sapling', label: 'Sapling (bends/snaps)', category: 'Trees' },
	{ id: 'tree-mid', label: 'Mid tree (fells/fractures)', category: 'Trees' },
	{ id: 'tree-large', label: 'Large tree (branches snap)', category: 'Trees' },
	{ id: 'building-shed', label: 'Shed', category: 'Buildings' },
	{ id: 'building-house', label: 'House corner', category: 'Buildings' },
	{ id: 'building-brick', label: 'Brick wall', category: 'Buildings' },
	{ id: 'building-fence', label: 'Fence line', category: 'Buildings' },
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

/** Destroys a body, swallowing the binding's catchable "Body already destroyed" guard (a JS check,
 * not a wasm trap) — a fractured structure has pieces the fracture pipeline already freed. */
function safeDestroy(body: Body): void {
	try {
		body.destroy();
	} catch {
		/* already freed by fracture — expected during teardown of a fractured target */
	}
}

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
				safeDestroy(p.body);
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

/** P010 fix: full (blue, ~200kg) vs empty (rust, ~20kg) mass variant + a dentable mesh (extra height
 * segments so a radial dent actually has mid-barrel vertices to displace -- the original geometry had
 * only top/bottom rings). Returns the deformable handle alongside the Piece so the dispatcher's
 * extraStep can apply a dent on a qualifying hit (see world/visuals.ts's applyBarrelDentAtWorldPoint). */
interface BarrelSpawn {
	readonly piece: Piece;
	readonly deformable: DeformableMeshHandle;
	readonly isFull: boolean;
}

function spawnBarrel(world: World, pos: { x: number; y: number; z: number }, variant: BarrelMaterial, material: THREE.Material, entityId: number, foreignMasses: Map<number, number> | null): BarrelSpawn {
	const massKg = BARREL_MASS_KG_BY_MATERIAL[variant];
	const body = world.createBody({ type: BodyType.Dynamic, position: pos, angularDamping: 0.7, linearDamping: 0.08 });
	const density = massKg / (ngonArea(BARREL_SIDES, BARREL_RADIUS_M) * BARREL_HEIGHT_M);
	body.createHullShape(ngonPrismPoints(BARREL_SIDES, BARREL_RADIUS_M, BARREL_HEIGHT_M), { density, friction: BARREL_FRICTION });
	body.applyMassFromShapes();
	body.setUserData(entityId);
	foreignMasses?.set(entityId, massKg);
	const geometry = new THREE.CylinderGeometry(BARREL_RADIUS_M, BARREL_RADIUS_M, BARREL_HEIGHT_M, BARREL_SIDES, 8);
	const mesh = new THREE.Mesh(geometry, material);
	const deformable = createBarrelDeformable(`crash-lab-barrel-${entityId}`, geometry);
	const piece = placePiece(body, mesh, true, entityId);
	return { piece, deformable, isFull: variant === 'barrelBlue' };
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
// Utility pole (P009 fix): real anchor+weld+fracture physics (world/bodies.ts's buildPole()/
// pollPoleBreak()/resetPole()/destroyPole() -- the SAME functions createDestructibleWorld() uses for
// the game's own pole row), with its own dedicated visual (capsule shaft + cross-arm/insulator
// dressing, world/visuals.ts's poleShaftGeometry()/addPoleDressing()) rather than the generic
// makeTarget()+spawnBox() single-static-mesh recipe every other Props entry still uses.
// ------------------------------------------------------------------------------------------------

/** Splintered-wood cap color for a snapped pole's broken face -- same tone as trees/visuals.ts's
 * STUMP_SPLINTER_COLOR (a pale exposed-wood contrast against the dark creosote shaft). */
const POLE_SPLINTER_COLOR = 0xc9b287;

/** Cylinder stand-in for a capsule fracture fragment (flat break face, unlike the physics capsule's
 * rounded caps) -- same simplification trees/visuals.ts's stumpVisualFor() uses: a flat-capped cylinder
 * reads as "a snapped cross-section of wood" better than a rounded capsule end would, and lets one cap
 * be tinted as the splintered face. `splinterAtTop`/`splinterAtBottom` pick which cap (CylinderGeometry
 * group order: side=0, top=1, bottom=2) gets the pale splinter material; the body's own origin sits at
 * the fragment's BASE (fracture.ts's capsule-fragment convention), so the geometry is translated up by
 * half its height to match. */
function buildPoleFragmentMesh(material: THREE.MeshStandardMaterial, radius: number, capLen: number, splinterAtTop: boolean): THREE.Mesh {
	const height = capLen + radius;
	const geo = new THREE.CylinderGeometry(radius, radius * 1.08, height, 10, 1);
	geo.translate(0, height / 2, 0);
	const splinterMat = new THREE.MeshStandardMaterial({ color: POLE_SPLINTER_COLOR, roughness: 0.9 });
	const mesh = new THREE.Mesh(geo, splinterAtTop ? [material, splinterMat, material] : [material, material, splinterMat]);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	return mesh;
}

function spawnPoleTarget(ctx: SpawnCtx): CrashTargetHandle {
	const base = ctx.vehicle.spawnPosition;
	const groundPos = { x: base.x, y: 0, z: base.z + ctx.distanceAhead };
	const mats = buildDestructibleMaterials();
	const pole = buildPole(ctx.world, groundPos, CRASH_TARGET_ENTITY_ID_BASE);
	ctx.foreignMasses?.set(pole.entityId, POLE_MASS_KG);

	const group = new THREE.Group();
	group.name = 'crash-target-pole';
	ctx.scene.add(group);

	// VERIFY-ONLY debug hook -- see the barrel/crate cases' identical comment.
	(window as unknown as { __crashTargetDebug?: unknown }).__crashTargetDebug = {
		poleFractured: () => pole.fractured,
		poleFlyerPosition: () => pole.flyerFrag?.body.getPosition() ?? null,
	};

	const shaftMesh = new THREE.Mesh(poleShaftGeometry(POLE_SHAFT_RADIUS_M, POLE_HEIGHT_M), mats.poleWood.material);
	shaftMesh.castShadow = true;
	shaftMesh.receiveShadow = true;
	addPoleDressing(shaftMesh, mats.poleWood.material, POLE_HEIGHT_M * POLE_CROSSARM_HEIGHT_FRACTION);
	group.add(shaftMesh);
	const shaftTransform = new InterpolatedTransform();
	{
		const t = pole.shaft.getTransform();
		shaftTransform.sample(t.position, t.rotation);
		shaftTransform.sample(t.position, t.rotation);
	}

	const fracture: PropFractureContext = {
		world: ctx.world,
		budget: createFractureBudget(1),
		idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE + 900_000),
	};

	let stumpMesh: THREE.Mesh | null = null;
	let stumpTransform: InterpolatedTransform | null = null;
	let flyerMesh: THREE.Mesh | null = null;
	let flyerTransform: InterpolatedTransform | null = null;

	function syncFractureVisuals(): void {
		if (!pole.fractured) return;
		if (pole.stump && !stumpMesh) {
			shaftMesh.visible = false;
			const frag = pole.stump.frag;
			stumpMesh = buildPoleFragmentMesh(mats.poleWood.material, frag.capsuleRadius ?? POLE_SHAFT_RADIUS_M, frag.capsuleCapLen ?? 1, true);
			group.add(stumpMesh);
			stumpTransform = new InterpolatedTransform();
			const t = frag.body.getTransform();
			stumpTransform.sample(t.position, t.rotation);
			stumpTransform.sample(t.position, t.rotation);
		}
		if (pole.flyerFrag && !flyerMesh) {
			const frag = pole.flyerFrag;
			const radius = frag.capsuleRadius ?? POLE_SHAFT_RADIUS_M;
			const capLen = frag.capsuleCapLen ?? 1;
			flyerMesh = buildPoleFragmentMesh(mats.poleWood.material, radius, capLen, false);
			// The flyer carries the pole's original TOP, so it keeps the cross-arm -- placed near ITS own
			// top (capLen + radius above its own base-origin), not the original full-pole-relative height.
			addPoleDressing(flyerMesh, mats.poleWood.material, capLen + radius - Math.min(0.3, capLen * 0.3));
			group.add(flyerMesh);
			flyerTransform = new InterpolatedTransform();
			const t = frag.body.getTransform();
			flyerTransform.sample(t.position, t.rotation);
			flyerTransform.sample(t.position, t.rotation);
		}
	}

	return {
		afterFixedStep() {
			resetFractureBudget(fracture.budget);
			pollPoleBreak(pole, fracture, ctx.foreignMasses);
			syncFractureVisuals();
			if (!pole.fractured) {
				const t = pole.shaft.getTransform();
				shaftTransform.sample(t.position, t.rotation);
			}
			if (pole.stump && stumpTransform) {
				const t = pole.stump.frag.body.getTransform();
				stumpTransform.sample(t.position, t.rotation);
			}
			if (pole.flyerFrag && flyerTransform) {
				const t = pole.flyerFrag.body.getTransform();
				flyerTransform.sample(t.position, t.rotation);
			}
		},
		applyVisuals(alpha) {
			if (!pole.fractured) shaftTransform.applyTo(shaftMesh, alpha);
			if (stumpMesh && stumpTransform) stumpTransform.applyTo(stumpMesh, alpha);
			if (flyerMesh && flyerTransform) flyerTransform.applyTo(flyerMesh, alpha);
		},
		teardown() {
			ctx.scene.remove(group);
			disposeMeshTree(shaftMesh);
			if (stumpMesh) disposeMeshTree(stumpMesh);
			if (flyerMesh) disposeMeshTree(flyerMesh);
			disposeDestructibleMaterials(mats);
			destroyPole(pole, ctx.foreignMasses);
		},
	};
}

// ------------------------------------------------------------------------------------------------
// Wooden crate (P011 fix): real hitEvents-triggered fracture physics (world/bodies.ts's
// buildCrateProp()/stepCrateFractures()/resetCrateProp()/destroyCrateProp() -- the SAME functions
// createDestructibleWorld() uses for the game's own crate tower), splitting into 2 splinter fragments
// on a hard hit instead of staying one monolithic box.
// ------------------------------------------------------------------------------------------------

function spawnCrateTarget(ctx: SpawnCtx): CrashTargetHandle {
	const base = ctx.vehicle.spawnPosition;
	const pos = { x: base.x, y: CRATE_HALF_EXTENT_M, z: base.z + ctx.distanceAhead };
	const mats = buildDestructibleMaterials();
	const crate = buildCrateProp(ctx.world, pos, CRASH_TARGET_ENTITY_ID_BASE);
	ctx.foreignMasses?.set(crate.entityId, CRATE_MASS_KG);

	const group = new THREE.Group();
	group.name = 'crash-target-crate';
	ctx.scene.add(group);

	// VERIFY-ONLY debug hook -- see the barrel case's identical comment above.
	(window as unknown as { __crashTargetDebug?: unknown }).__crashTargetDebug = {
		crateFractured: () => crate.fractured,
		crateFragmentCount: () => crate.fragments.length,
		crateFragmentPositions: () => crate.fragments.map((f) => f.body.getPosition()),
	};

	const half = CRATE_HALF_EXTENT_M;
	const intactMesh = new THREE.Mesh(new THREE.BoxGeometry(half * 2, half * 2, half * 2), mats.wood.material);
	intactMesh.castShadow = true;
	intactMesh.receiveShadow = true;
	group.add(intactMesh);
	const intactTransform = new InterpolatedTransform();
	{
		const t = crate.body.getTransform();
		intactTransform.sample(t.position, t.rotation);
		intactTransform.sample(t.position, t.rotation);
	}

	const crateByEntityId = new Map<number, CrateProp>([[crate.entityId, crate]]);
	const fracture: PropFractureContext = {
		world: ctx.world,
		budget: createFractureBudget(1),
		idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE + 950_000),
	};

	const fragMeshes: { mesh: THREE.Mesh; transform: InterpolatedTransform }[] = [];

	function syncFractureVisuals(): void {
		if (!crate.fractured || fragMeshes.length > 0) return;
		intactMesh.visible = false;
		for (const frag of crate.fragments) {
			if (frag.kind !== 'box' || !frag.halfExtents) continue;
			const geo = new THREE.BoxGeometry(frag.halfExtents.x * 2, frag.halfExtents.y * 2, frag.halfExtents.z * 2);
			const mesh = new THREE.Mesh(geo, mats.wood.material);
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			group.add(mesh);
			const transform = new InterpolatedTransform();
			const t = frag.body.getTransform();
			transform.sample(t.position, t.rotation);
			transform.sample(t.position, t.rotation);
			fragMeshes.push({ mesh, transform });
		}
	}

	return {
		afterFixedStep() {
			resetFractureBudget(fracture.budget);
			stepCrateFractures(ctx.world, crateByEntityId, fracture, ctx.foreignMasses);
			syncFractureVisuals();
			if (!crate.fractured) {
				const t = crate.body.getTransform();
				intactTransform.sample(t.position, t.rotation);
			} else {
				for (let i = 0; i < crate.fragments.length; i++) {
					const t = crate.fragments[i].body.getTransform();
					fragMeshes[i]?.transform.sample(t.position, t.rotation);
				}
			}
		},
		applyVisuals(alpha) {
			if (!crate.fractured) intactTransform.applyTo(intactMesh, alpha);
			for (const f of fragMeshes) f.transform.applyTo(f.mesh, alpha);
		},
		teardown() {
			ctx.scene.remove(group);
			disposeMeshTree(intactMesh);
			for (const f of fragMeshes) disposeMeshTree(f.mesh);
			disposeDestructibleMaterials(mats);
			destroyCrateProp(crate, ctx.foreignMasses);
		},
	};
}

// ------------------------------------------------------------------------------------------------
// Trees (real fracture physics via a one-tree TreesWorld + stepTreesWorld)
// ------------------------------------------------------------------------------------------------

/** Distinct from the forest's own member ids (base+0..~2000); the lab has no forest, but this keeps
 * the crash-target tree cleanly separated in the trees id range (46,900,000 < buildings' 47M). */
const CRASH_TREE_ENTITY_ID_BASE = TREES_MEMBER_ENTITY_ID_BASE + 900_000;

function spawnTreeTarget(kind: 'sapling' | 'mid' | 'large', ctx: SpawnCtx, site: TreeSiteXZ): CrashTargetHandle {
	const tree = spawnSingleTree(ctx.world, kind, site, CRASH_TREE_ENTITY_ID_BASE, ctx.foreignMasses);
	const treesWorld: TreesWorld = {
		saplings: kind === 'sapling' ? [tree as SaplingTree] : [],
		mids: kind === 'mid' ? [tree as MidTree] : [],
		larges: kind === 'large' ? [tree as LargeTree] : [],
		massRegistry: ctx.foreignMasses,
	};
	const bundle = buildTreesVisuals(treesWorld);
	ctx.scene.add(bundle.group);
	const fracture: TreesFractureContext = {
		world: ctx.world,
		budget: createFractureBudget(1),
		idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE),
	};
	return {
		afterFixedStep() {
			resetFractureBudget(fracture.budget);
			stepTreesWorld(treesWorld, fracture);
			sampleTreesVisuals(treesWorld, bundle);
		},
		applyVisuals(alpha) {
			applyTreesVisuals(bundle, alpha);
		},
		teardown() {
			ctx.scene.remove(bundle.group);
			disposeTreesVisuals(bundle);
			destroySingleTree(tree, ctx.foreignMasses);
		},
	};
}

// ------------------------------------------------------------------------------------------------
// Buildings (real fracture + support-collapse via the exported single-structure builders)
// ------------------------------------------------------------------------------------------------

/** Rigidly shifts a whole structure so its XZ centroid sits at (cx, cz) ahead of the car — a uniform
 * offset preserves every internal weld (frames are body-local), so the structure stays intact. Used
 * for shed/house/brick, whose builders hardcode their own centre; the fence builder takes a centre. */
function translateStructure(structure: Structure, cx: number, cz: number): void {
	let sx = 0;
	let sz = 0;
	for (const p of structure.pieces) {
		const pos = p.body.getPosition();
		sx += pos.x;
		sz += pos.z;
	}
	const n = structure.pieces.length || 1;
	const ox = cx - sx / n;
	const oz = cz - sz / n;
	for (const p of structure.pieces) {
		const pos = p.body.getPosition();
		p.body.setTransform({ x: pos.x + ox, y: pos.y, z: pos.z + oz }, p.body.getRotation());
		if (!p.isStatic) p.body.setAwake(false);
	}
}

function spawnBuildingTarget(kind: 'shed' | 'house' | 'brick' | 'fence', ctx: SpawnCtx): CrashTargetHandle {
	const base = ctx.vehicle.spawnPosition;
	const cx = base.x;
	const cz = base.z + ctx.distanceAhead;

	let structure: Structure;
	if (kind === 'fence') {
		structure = buildFenceLine(ctx.world, { id: 'crash-fence', center: { x: cx, y: 0, z: cz } });
	} else if (kind === 'brick') {
		// P005 gate fix: the crash-lab brick wall is the WIDE segmented property wall (buildBrickWallLab),
		// built centred on the target point directly (no translateStructure) so a centre hit knocks out
		// the struck panel while the flanking panels -- on their own footings, isolated by expansion
		// joints -- stay standing, matching the reference photos. See tuning.ts's BRICK_WALL_LAB_* doc.
		structure = buildBrickWallLab(ctx.world, { x: cx, y: 0, z: cz });
	} else {
		structure = kind === 'house' ? buildHouseCorner(ctx.world) : buildShed(ctx.world);
		translateStructure(structure, cx, cz);
	}

	const registeredIds: number[] = [];
	for (const p of structure.pieces) {
		if (!p.isStatic) {
			ctx.foreignMasses?.set(p.entityId, p.massKg);
			registeredIds.push(p.entityId);
		}
	}

	const graph = buildSupportGraph(structure);
	const bundle = buildBuildingsVisuals([structure]);
	ctx.scene.add(bundle.group);

	const fracture: StructureFractureContext = {
		world: ctx.world,
		budget: createFractureBudget(1),
		idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE + 500_000),
		timeSec: 0,
		fragments: [],
		events: [],
		liveFragmentCap: 40,
		massRegistry: ctx.foreignMasses ?? undefined,
	};

	return {
		afterFixedStep(dt) {
			fracture.timeSec += dt;
			fracture.events.length = 0;
			const broke = pollStructureBreaks(structure, fracture);
			if (broke > 0) pollStructureCollapse(structure, graph);
			spawnFragmentVisuals(bundle, fracture.events);
			sampleBuildingsVisuals(bundle);
		},
		applyVisuals(alpha) {
			applyBuildingsVisuals(bundle, alpha);
		},
		teardown() {
			ctx.scene.remove(bundle.group);
			disposeBuildingsVisuals(bundle);
			for (const id of registeredIds) ctx.foreignMasses?.delete(id);
			// box3d's Body.destroy() frees the body's NATIVE shapes + joints but only unregisters the
			// body's own JS handle — so we forget the shape/joint JS handles too, else liveHandleCount
			// climbs on every crash. forgetHandle is JS-only (no native op), so it can't double-free;
			// destroying the body then frees the native shape/joint. Fractured pieces (and despawned
			// fragments) were already destroyed + unregistered by the fracture pipeline — skip them.
			for (const r of structure.joints) if (r.joint) forgetHandle(r.joint.handle, 'joint');
			for (const p of structure.pieces) {
				if (p.fractured) continue;
				forgetHandle(p.shape.handle, 'shape');
				safeDestroy(p.body);
			}
			for (const f of fracture.fragments) {
				if (f.despawned) continue;
				forgetHandle(f.shape.handle, 'shape');
				safeDestroy(f.body);
			}
		},
	};
}

// ------------------------------------------------------------------------------------------------
// Dispatcher
// ------------------------------------------------------------------------------------------------

export function spawnCrashTarget(id: string, ctx: SpawnCtx): CrashTargetHandle | null {
	const base = ctx.vehicle.spawnPosition;
	const cx = base.x;
	const cz = base.z + ctx.distanceAhead;

	// Feature-backed targets first (own physics + visuals — no destructible material set needed).
	switch (id) {
		case 'tree-sapling':
			return spawnTreeTarget('sapling', ctx, { x: cx, z: cz });
		case 'tree-mid':
			return spawnTreeTarget('mid', ctx, { x: cx, z: cz });
		case 'tree-large':
			return spawnTreeTarget('large', ctx, { x: cx, z: cz });
		case 'building-shed':
			return spawnBuildingTarget('shed', ctx);
		case 'building-house':
			return spawnBuildingTarget('house', ctx);
		case 'building-brick':
			return spawnBuildingTarget('brick', ctx);
		case 'building-fence':
			return spawnBuildingTarget('fence', ctx);
		// P009/P011 fixes: pole (rooted anchor + weld + base-third snap) and crate (splinter-on-hard-hit)
		// now need their own fracture-aware physics/visuals, own dedicated spawn functions below (same
		// "own physics + visuals" shape as the tree/building cases above), rather than the generic
		// makeTarget()+spawnBox() single-static-mesh recipe every other Props entry still uses.
		case 'pole':
			return spawnPoleTarget(ctx);
		case 'crate':
			return spawnCrateTarget(ctx);
	}

	const eid = CRASH_TARGET_ENTITY_ID_BASE;
	const fm = ctx.foreignMasses;
	const mats = buildDestructibleMaterials();

	switch (id) {
		case 'wall-concrete':
		case 'wall-brick': {
			const h = WALL_BLOCK_HALF_EXTENTS_M;
			const material = id === 'wall-brick' ? mats.brick.material : mats.concrete.material;
			return makeTarget(ctx.scene, [spawnBox(ctx.world, { x: cx, y: h.y, z: cz }, h, 20, WALL_BLOCK_FRICTION, material, 1.6, 0.15, eid, fm)], mats, fm);
		}
		case 'barrel-blue':
		case 'barrel-rust': {
			// P010 fix: full-vs-empty mass variant + a hitEvents-driven visual dent (world/visuals.ts's
			// createBarrelDeformable/applyBarrelDentAtWorldPoint, reusing damage/crumple.ts's shared
			// plastic-crumple math) -- physics hull is unchanged (still the plain 12-gon prism).
			const variant: BarrelMaterial = id === 'barrel-blue' ? 'barrelBlue' : 'barrelRust';
			const material = variant === 'barrelBlue' ? mats.barrelBlue.material : mats.barrelRust.material;
			const spawn = spawnBarrel(ctx.world, { x: cx, y: BARREL_HEIGHT_M / 2, z: cz }, variant, material, eid, fm);
			const massFactor = spawn.isFull ? BARREL_DENT_MASS_FACTOR_FULL : BARREL_DENT_MASS_FACTOR_EMPTY;
			const extraStep = (): void => {
				const hits = ctx.world.hitEvents();
				for (let i = 0; i < hits.count; i++) {
					const ev = hits.at(i);
					if (ev.userDataA !== eid && ev.userDataB !== eid) continue;
					if (ev.approachSpeed < BARREL_DENT_TRIGGER_SPEED_MS) continue;
					applyBarrelDentAtWorldPoint(spawn.piece.mesh, spawn.deformable, ev.point, ev.normal, ev.approachSpeed, massFactor);
				}
			};
			// VERIFY-ONLY debug hook (mirrors __LAB__'s own dumpDeformables/deformableSyncCheck diagnostic
			// pattern, hud.ts's doc comment) -- exposes the barrel's own dent state for a CDP verify script
			// to confirm the P010 dent mechanism fired numerically, not just by eye. Not part of the
			// official window.__LAB__ surface (lab/main.ts is out of this run's file ownership).
			(window as unknown as { __crashTargetDebug?: unknown }).__crashTargetDebug = {
				barrelDentedVertexCount: () => spawn.deformable.dentedCount,
				barrelIsFull: () => spawn.isFull,
				barrelPosition: () => spawn.piece.body.getPosition(),
				barrelMaxDentDepthM: () => {
					const off = spawn.deformable.offsets;
					let maxMag = 0;
					for (let i = 0; i < spawn.deformable.vertexCount; i++) {
						const mag = Math.hypot(off[i * 3], off[i * 3 + 1], off[i * 3 + 2]);
						if (mag > maxMag) maxMag = mag;
					}
					return maxMag;
				},
			};
			return makeTarget(ctx.scene, [spawn.piece], mats, fm, extraStep);
		}
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
