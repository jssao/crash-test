// SPDX-License-Identifier: MIT
//
// Three.js visuals for the 'trees' world feature: one trunk+canopy group per sapling/mid tree
// (follows its own body's InterpolatedTransform, same pattern as world/visuals.ts's per-body
// meshes), a static trunk+canopy mesh per large tree (never moves -- added directly, no per-frame
// transform, matching world/visuals.ts's static-ramp treatment), and one small mesh per large-tree
// branch (its own InterpolatedTransform). Canopies are cones/icosahedra merged into ONE geometry per
// tree with per-vertex color jitter (seeded, deterministic -- feature contract warning #3), so a
// whole canopy costs one draw call regardless of how many "leaf clumps" it's built from.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { InterpolatedTransform } from '../../../core/loop';
import type { LargeTree, MidTree, SaplingTree, TreesWorld } from './bodies';
import {
	LARGE_BRANCH_LAYOUT,
	LARGE_BRANCH_LENGTH_M,
	LARGE_BRANCH_RADIUS_M,
	LARGE_TRUNK_HEIGHT_M,
	LARGE_TRUNK_RADIUS_M,
	MID_TRUNK_HEIGHT_M,
	MID_TRUNK_RADIUS_M,
	mulberry32,
	SAPLING_TRUNK_HEIGHT_M,
	SAPLING_TRUNK_RADIUS_M,
	TREES_RNG_SEED,
} from './tuning';

// ---------------------------------------------------------------------------------------------
// Shared materials (built once, reused by every tree of every class -- no per-instance textures).
// ---------------------------------------------------------------------------------------------

function buildBarkCanvasTexture(): THREE.CanvasTexture {
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#4a3626';
	ctx.fillRect(0, 0, size, size);
	const rand = mulberry32(TREES_RNG_SEED ^ 0x1);
	for (let i = 0; i < 400; i++) {
		const x = rand() * size;
		const h = 4 + rand() * 14;
		const y = rand() * size;
		const dark = rand() > 0.5;
		ctx.fillStyle = dark ? 'rgba(30,20,14,0.5)' : 'rgba(90,70,50,0.4)';
		ctx.fillRect(x, y, 1.5, h);
	}
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = THREE.RepeatWrapping;
	tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(2, 4);
	return tex;
}

export interface TreesMaterialSet {
	bark: THREE.MeshStandardMaterial;
	foliage: THREE.MeshStandardMaterial;
}

export function buildTreesMaterials(): TreesMaterialSet {
	const barkMap = buildBarkCanvasTexture();
	const bark = new THREE.MeshStandardMaterial({ map: barkMap, roughness: 0.95, metalness: 0 });
	const foliage = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
	return { bark, foliage };
}

export function disposeTreesMaterials(materials: TreesMaterialSet): void {
	materials.bark.map?.dispose();
	materials.bark.dispose();
	materials.foliage.dispose();
}

// ---------------------------------------------------------------------------------------------
// Canopy: several cones/icosahedra clustered around a center point, merged into one geometry with
// deterministic seeded per-vertex color jitter (green hue/lightness variation).
// ---------------------------------------------------------------------------------------------

function jitterGreen(rand: () => number): THREE.Color {
	const h = 0.28 + (rand() - 0.5) * 0.06; // around a forest green hue
	const s = 0.45 + rand() * 0.2;
	const l = 0.28 + rand() * 0.16;
	return new THREE.Color().setHSL(h, s, l);
}

function paintVertexColors(geometry: THREE.BufferGeometry, color: THREE.Color): void {
	const count = geometry.attributes.position.count;
	const colors = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		colors[i * 3] = color.r;
		colors[i * 3 + 1] = color.g;
		colors[i * 3 + 2] = color.b;
	}
	geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Builds one merged canopy geometry (tree-local space, y=0 at the cluster's own anchor point) from
 * `lobes` cone pieces (radial segment count jittered 5-8 for silhouette variety -- deliberately ONE
 * geometry TYPE only: mixing ConeGeometry with IcosahedronGeometry here once produced a
 * `mergeGeometries()` "incompatible attributes" console error at runtime -- their default attribute
 * sets/index presence don't line up -- caught via game/verify/feature-trees.mjs, not by tsc/vitest)
 * jittered around a center, colored via a seeded RNG. Deterministic for a given `seed` (feature
 * contract warning #3 -- no bare Math.random). */
function buildCanopyGeometry(seed: number, baseRadius: number, baseHeight: number, lobes: number): THREE.BufferGeometry {
	const rand = mulberry32(seed);
	const pieces: THREE.BufferGeometry[] = [];
	for (let i = 0; i < lobes; i++) {
		const scale = 0.7 + rand() * 0.5;
		const r = baseRadius * scale;
		const h = baseHeight * (0.8 + rand() * 0.4);
		const ox = (rand() - 0.5) * baseRadius * 0.9;
		const oz = (rand() - 0.5) * baseRadius * 0.9;
		const oy = rand() * baseHeight * 0.35;
		const radialSegments = 5 + Math.floor(rand() * 4);
		const geo: THREE.BufferGeometry = new THREE.ConeGeometry(r, h, radialSegments);
		geo.translate(ox, oy + h * 0.4, oz);
		paintVertexColors(geo, jitterGreen(rand));
		pieces.push(geo);
	}
	const merged = mergeGeometries(pieces, false) ?? new THREE.BufferGeometry();
	for (const p of pieces) p.dispose();
	merged.computeVertexNormals();
	return merged;
}

// ---------------------------------------------------------------------------------------------
// Sapling / mid trunk geometry (CylinderGeometry approximating the physics capsule -- same
// convention as world/visuals.ts's barrel mesh approximating its hull shape).
// ---------------------------------------------------------------------------------------------

function buildTrunkGeometry(radius: number, height: number, radialSegments: number): THREE.BufferGeometry {
	const geo = new THREE.CylinderGeometry(radius, radius * 1.25, height, radialSegments);
	geo.translate(0, height / 2, 0);
	return geo;
}

export interface SaplingVisual {
	readonly group: THREE.Group;
	readonly transform: InterpolatedTransform;
}

export interface MidVisual {
	readonly group: THREE.Group;
	readonly transform: InterpolatedTransform;
}

export interface BranchVisual {
	readonly mesh: THREE.Mesh;
	readonly transform: InterpolatedTransform;
}

export interface LargeVisual {
	readonly trunkMesh: THREE.Mesh;
	readonly canopyMesh: THREE.Mesh;
	readonly branches: BranchVisual[];
}

export interface TreesVisualBundle {
	readonly materials: TreesMaterialSet;
	readonly saplings: SaplingVisual[];
	readonly mids: MidVisual[];
	readonly larges: LargeVisual[];
	readonly group: THREE.Group;
}

function buildSaplingVisual(sapling: SaplingTree, materials: TreesMaterialSet, seed: number): SaplingVisual {
	const group = new THREE.Group();
	group.name = `tree-${sapling.id}`;
	const trunkGeo = buildTrunkGeometry(SAPLING_TRUNK_RADIUS_M, SAPLING_TRUNK_HEIGHT_M, 6);
	const trunk = new THREE.Mesh(trunkGeo, materials.bark);
	trunk.castShadow = true;
	trunk.receiveShadow = true;
	group.add(trunk);

	const canopyGeo = buildCanopyGeometry(seed, 0.55, 0.9, 3);
	const canopy = new THREE.Mesh(canopyGeo, materials.foliage);
	canopy.position.y = SAPLING_TRUNK_HEIGHT_M * 0.75;
	canopy.castShadow = true;
	group.add(canopy);

	const t = sapling.trunk.getTransform();
	group.position.set(t.position.x, t.position.y, t.position.z);
	group.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	const transform = new InterpolatedTransform();
	transform.sample(t.position, t.rotation);
	transform.sample(t.position, t.rotation);
	return { group, transform };
}

function buildMidVisual(mid: MidTree, materials: TreesMaterialSet, seed: number): MidVisual {
	const group = new THREE.Group();
	group.name = `tree-${mid.id}`;
	const trunkGeo = buildTrunkGeometry(MID_TRUNK_RADIUS_M, MID_TRUNK_HEIGHT_M, 8);
	const trunk = new THREE.Mesh(trunkGeo, materials.bark);
	trunk.castShadow = true;
	trunk.receiveShadow = true;
	group.add(trunk);

	const canopyGeo = buildCanopyGeometry(seed, 1.6, 2.4, 5);
	const canopy = new THREE.Mesh(canopyGeo, materials.foliage);
	canopy.position.y = MID_TRUNK_HEIGHT_M * 0.72;
	canopy.castShadow = true;
	group.add(canopy);

	const t = mid.trunk.getTransform();
	group.position.set(t.position.x, t.position.y, t.position.z);
	group.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	const transform = new InterpolatedTransform();
	transform.sample(t.position, t.rotation);
	transform.sample(t.position, t.rotation);
	return { group, transform };
}

function buildBranchGeometry(): THREE.BufferGeometry {
	const geo = new THREE.CylinderGeometry(LARGE_BRANCH_RADIUS_M, LARGE_BRANCH_RADIUS_M * 1.3, LARGE_BRANCH_LENGTH_M, 6);
	geo.rotateZ(Math.PI / 2); // cylinder's own axis is Y; branch capsule axis is local X
	geo.translate(LARGE_BRANCH_LENGTH_M / 2, 0, 0);
	return geo;
}

function buildLargeVisual(large: LargeTree, materials: TreesMaterialSet, seed: number): LargeVisual {
	const trunkGeo = buildTrunkGeometry(LARGE_TRUNK_RADIUS_M, LARGE_TRUNK_HEIGHT_M, 10);
	const trunkMesh = new THREE.Mesh(trunkGeo, materials.bark);
	trunkMesh.castShadow = true;
	trunkMesh.receiveShadow = true;
	const tt = large.trunk.getTransform();
	trunkMesh.position.set(tt.position.x, tt.position.y, tt.position.z);
	trunkMesh.quaternion.set(tt.rotation.x, tt.rotation.y, tt.rotation.z, tt.rotation.w);
	trunkMesh.name = `tree-${large.id}-trunk`;

	const canopyGeo = buildCanopyGeometry(seed, 2.6, 3.6, 7);
	const canopyMesh = new THREE.Mesh(canopyGeo, materials.foliage);
	canopyMesh.position.set(tt.position.x, tt.position.y + LARGE_TRUNK_HEIGHT_M * 0.68, tt.position.z);
	canopyMesh.castShadow = true;
	canopyMesh.name = `tree-${large.id}-canopy`;

	const branches: BranchVisual[] = [];
	for (let i = 0; i < large.branches.length; i++) {
		const b = large.branches[i];
		void LARGE_BRANCH_LAYOUT[i]; // layout consumed by bodies.ts; kept here only for doc symmetry
		const mesh = new THREE.Mesh(buildBranchGeometry(), materials.bark);
		mesh.castShadow = true;
		const bt = b.body.getTransform();
		mesh.position.set(bt.position.x, bt.position.y, bt.position.z);
		mesh.quaternion.set(bt.rotation.x, bt.rotation.y, bt.rotation.z, bt.rotation.w);
		const transform = new InterpolatedTransform();
		transform.sample(bt.position, bt.rotation);
		transform.sample(bt.position, bt.rotation);
		branches.push({ mesh, transform });
	}

	return { trunkMesh, canopyMesh, branches };
}

/** Builds every tree's visuals and adds them all to a single fresh THREE.Group (returned) --
 * caller adds it to the scene once, same convention as world/visuals.ts's buildDestructibleVisuals(). */
export function buildTreesVisuals(trees: TreesWorld): TreesVisualBundle {
	const materials = buildTreesMaterials();
	const group = new THREE.Group();
	group.name = 'TreesFeature';

	const saplings = trees.saplings.map((s, i) => {
		const v = buildSaplingVisual(s, materials, TREES_RNG_SEED + i * 17 + 1);
		group.add(v.group);
		return v;
	});
	const mids = trees.mids.map((m, i) => {
		const v = buildMidVisual(m, materials, TREES_RNG_SEED + i * 31 + 101);
		group.add(v.group);
		return v;
	});
	const larges = trees.larges.map((l, i) => {
		const v = buildLargeVisual(l, materials, TREES_RNG_SEED + i * 53 + 201);
		group.add(v.trunkMesh);
		group.add(v.canopyMesh);
		for (const b of v.branches) group.add(b.mesh);
		return v;
	});

	return { materials, saplings, mids, larges, group };
}

/** Call once per fixed physics step (after stepTreesWorld()) -- samples every dynamic tree body's
 * CURRENT transform for render-time interpolation, same pattern as world/visuals.ts's
 * sampleDestructibleVisuals(). Static large-tree trunks/canopies are skipped (never move). */
export function sampleTreesVisuals(trees: TreesWorld, bundle: TreesVisualBundle): void {
	for (let i = 0; i < trees.saplings.length; i++) {
		const t = trees.saplings[i].trunk.getTransform();
		bundle.saplings[i].transform.sample(t.position, t.rotation);
	}
	for (let i = 0; i < trees.mids.length; i++) {
		const t = trees.mids[i].trunk.getTransform();
		bundle.mids[i].transform.sample(t.position, t.rotation);
	}
	for (let i = 0; i < trees.larges.length; i++) {
		const large = trees.larges[i];
		const visual = bundle.larges[i];
		for (let b = 0; b < large.branches.length; b++) {
			const t = large.branches[b].body.getTransform();
			visual.branches[b].transform.sample(t.position, t.rotation);
		}
	}
}

/** Call once per render frame with the accumulator's interpolation alpha. */
export function applyTreesVisuals(bundle: TreesVisualBundle, alpha: number): void {
	for (const s of bundle.saplings) s.transform.applyTo(s.group, alpha);
	for (const m of bundle.mids) m.transform.applyTo(m.group, alpha);
	for (const l of bundle.larges) for (const b of l.branches) b.transform.applyTo(b.mesh, alpha);
}

/** After a full reset, double-sample every transform from the NEW pose so render-time lerp doesn't
 * visibly interpolate from the old (possibly broken/flung) pose across a single frame -- same trick
 * as world/visuals.ts's resnapDestructibleVisuals(). Rebuilds a sapling/mid/branch's GEOMETRY too if
 * its body was recreated (broken -> reset), since the old Mesh's geometry belonged to a destroyed
 * body's now-stale visual identity would otherwise still render fine (geometry is body-independent)
 * -- so no geometry rebuild is actually needed, only the transform resnap below.
 */
export function resnapTreesVisuals(trees: TreesWorld, bundle: TreesVisualBundle): void {
	for (let i = 0; i < trees.saplings.length; i++) {
		const t = trees.saplings[i].trunk.getTransform();
		bundle.saplings[i].transform.sample(t.position, t.rotation);
		bundle.saplings[i].transform.sample(t.position, t.rotation);
		bundle.saplings[i].group.position.set(t.position.x, t.position.y, t.position.z);
		bundle.saplings[i].group.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	}
	for (let i = 0; i < trees.mids.length; i++) {
		const t = trees.mids[i].trunk.getTransform();
		bundle.mids[i].transform.sample(t.position, t.rotation);
		bundle.mids[i].transform.sample(t.position, t.rotation);
		bundle.mids[i].group.position.set(t.position.x, t.position.y, t.position.z);
		bundle.mids[i].group.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	}
	for (let i = 0; i < trees.larges.length; i++) {
		const large = trees.larges[i];
		const visual = bundle.larges[i];
		for (let b = 0; b < large.branches.length; b++) {
			const t = large.branches[b].body.getTransform();
			visual.branches[b].transform.sample(t.position, t.rotation);
			visual.branches[b].transform.sample(t.position, t.rotation);
			visual.branches[b].mesh.position.set(t.position.x, t.position.y, t.position.z);
			visual.branches[b].mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
		}
	}
}

export function disposeTreesVisuals(bundle: TreesVisualBundle): void {
	for (const s of bundle.saplings) {
		for (const child of s.group.children) if (child instanceof THREE.Mesh) child.geometry.dispose();
	}
	for (const m of bundle.mids) {
		for (const child of m.group.children) if (child instanceof THREE.Mesh) child.geometry.dispose();
	}
	for (const l of bundle.larges) {
		l.trunkMesh.geometry.dispose();
		l.canopyMesh.geometry.dispose();
		for (const b of l.branches) b.mesh.geometry.dispose();
	}
	disposeTreesMaterials(bundle.materials);
}
