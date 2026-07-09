// SPDX-License-Identifier: MIT
//
// Three.js visuals for the 'trees' world feature: one trunk+canopy group per sapling/mid tree
// (follows its own body's InterpolatedTransform, same pattern as world/visuals.ts's per-body
// meshes), a static trunk+canopy mesh per large tree (never moves -- added directly, no per-frame
// transform, matching world/visuals.ts's static-ramp treatment), and one small mesh per large-tree
// branch (its own InterpolatedTransform).
//
// VISUAL TECHNIQUE (2026-07-09 tree-visuals pass -- replaces the earlier cone-canopy/procedural-
// canvas-bark placeholder, see assets-src/CREDITS.md's "Tree canopy visuals pass" entry):
//   - Trunks/branches: real Poly Haven CC0 `bark_brown_01` PBR set (diff+normal+roughness, staged
//     since the original acquisition pass but never wired in) wraps a CylinderGeometry approximating
//     the physics capsule (same "visual approximates, does not exactly match, the collision shape"
//     convention as world/visuals.ts's barrel mesh). UV tiling is baked into each trunk's OWN uv
//     attribute (scaleTrunkUVs()) rather than Texture.repeat, since one shared bark material spans
//     sapling/mid/large/branch classes with very different radii/heights. A small seeded radial
//     jitter (jitterTrunkSilhouette()) adds a root-flare read + bark-ridge silhouette wobble --
//     purely cosmetic, the capsule underneath is untouched.
//   - Canopies: alpha-cutout foliage CARDS (the standard game-vegetation technique), not solid
//     cones -- clusters of 3 quads crossed 60 degrees apart (cheap fake-billboard volume from any
//     viewing angle without per-frame billboarding, which is render-loop territory, not this file's)
//     scattered through an oblate-spheroid canopy volume, biased toward the outer shell so the
//     canopy doesn't read hollow. All cards for one tree merge into ONE geometry (mergeGeometries,
//     same one-draw-call-per-canopy discipline the old cone code established) sampling a real photo
//     leaf-cutout atlas (Poly Haven `tree_small_02`'s `leaves_*` maps -- see CREDITS.md) at two fixed
//     UV sub-rects: a detailed alpha-cut leaf-cluster region (outer/silhouette cards) and a solid
//     opaque leaf-mass region (inner/fill cards, cheaper, hidden by the outer shell). Per-cluster
//     vertex-color tint (seeded) adds brightness variance plus a small deterministic chance of an
//     autumn tint, tying the canopy palette to the forest floor's fallen-leaf litter texture.
//   - Both materials are alpha-tested/opaque (never `transparent:true`) so a single merged multi-card
//     mesh never needs per-triangle sort -- the standard cutout-foliage choice.
//   - Broken/felled states are untouched: visuals still ride the existing bodies' transforms exactly
//     as before (see bodies.ts) -- only how each body's mesh is BUILT changed, not which body drives
//     which mesh.

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
// Shared textures/materials (built once, reused by every tree of every class -- no per-instance
// textures). Real CC0 Poly Haven photo assets, not procedural -- see assets-src/CREDITS.md.
// ---------------------------------------------------------------------------------------------

const BARK_TEX_BASE = 'assets/trees/bark_brown_01';
const LEAF_TEX_BASE = 'assets/trees/tree_small_02_leaves';

/** Meters of trunk surface (both around the circumference AND up the height) per bark-texture
 * repeat -- baked into each trunk's own UV attribute by scaleTrunkUVs() rather than relying on
 * Texture.repeat, since ONE shared bark material spans sapling/mid/large/branch classes whose
 * radii/heights differ by an order of magnitude. */
const BARK_TILE_M = 1.3;

function loadBarkTextures(): { diff: THREE.Texture; nor: THREE.Texture; rough: THREE.Texture } {
	const loader = new THREE.TextureLoader();
	const diff = loader.load(`${BARK_TEX_BASE}/bark_brown_01_diff_2k.jpg`);
	const nor = loader.load(`${BARK_TEX_BASE}/bark_brown_01_nor_gl_2k.jpg`);
	const rough = loader.load(`${BARK_TEX_BASE}/bark_brown_01_rough_2k.jpg`);
	diff.colorSpace = THREE.SRGBColorSpace;
	nor.colorSpace = THREE.NoColorSpace;
	rough.colorSpace = THREE.NoColorSpace;
	for (const t of [diff, nor, rough]) {
		t.wrapS = t.wrapT = THREE.RepeatWrapping;
		t.anisotropy = 4;
	}
	return { diff, nor, rough };
}

function loadLeafTextures(): { diff: THREE.Texture; alpha: THREE.Texture; nor: THREE.Texture } {
	const loader = new THREE.TextureLoader();
	const diff = loader.load(`${LEAF_TEX_BASE}/tree_small_02_leaves_diff_1k.jpg`);
	const alpha = loader.load(`${LEAF_TEX_BASE}/tree_small_02_leaves_alpha_1k.png`);
	const nor = loader.load(`${LEAF_TEX_BASE}/tree_small_02_leaves_nor_gl_1k.jpg`);
	diff.colorSpace = THREE.SRGBColorSpace;
	alpha.colorSpace = THREE.NoColorSpace;
	nor.colorSpace = THREE.NoColorSpace;
	for (const t of [diff, alpha, nor]) {
		// Sampled at fixed atlas sub-rects only (see DETAIL/FILL rects below) -- never tiled.
		t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
		t.anisotropy = 4;
	}
	return { diff, alpha, nor };
}

export interface TreesMaterialSet {
	bark: THREE.MeshStandardMaterial;
	foliage: THREE.MeshStandardMaterial;
}

export function buildTreesMaterials(): TreesMaterialSet {
	const barkTex = loadBarkTextures();
	const leafTex = loadLeafTextures();
	const bark = new THREE.MeshStandardMaterial({
		map: barkTex.diff,
		normalMap: barkTex.nor,
		roughnessMap: barkTex.rough,
		roughness: 1,
		metalness: 0,
	});
	const foliage = new THREE.MeshStandardMaterial({
		map: leafTex.diff,
		alphaMap: leafTex.alpha,
		normalMap: leafTex.nor,
		vertexColors: true,
		roughness: 0.92,
		metalness: 0,
		// Cutout, not blend -- a merged multi-card mesh has no reliable per-triangle sort order, so
		// alpha BLEND would produce visible ordering artifacts between overlapping cards. alphaTest
		// (hard cutoff, depth-written like any opaque surface) is the standard vegetation-card choice.
		alphaTest: 0.5,
		side: THREE.DoubleSide,
	});
	return { bark, foliage };
}

export function disposeTreesMaterials(materials: TreesMaterialSet): void {
	materials.bark.map?.dispose();
	materials.bark.normalMap?.dispose();
	materials.bark.roughnessMap?.dispose();
	materials.bark.dispose();
	materials.foliage.map?.dispose();
	materials.foliage.alphaMap?.dispose();
	materials.foliage.normalMap?.dispose();
	materials.foliage.dispose();
}

// ---------------------------------------------------------------------------------------------
// Foliage atlas layout (tree_small_02_leaves_*): two hand-verified safe regions (checked by eye
// against the downloaded 1024x1024 images -- the two regions are separated by a soft, diagonally-
// wavy cutout boundary that sweeps roughly from u~0.83 at the top to u~0.47 at the bottom, so both
// rects below are kept well clear of it on every edge).
// ---------------------------------------------------------------------------------------------

interface AtlasRect {
	readonly u0: number;
	readonly v0: number;
	readonly u1: number;
	readonly v1: number;
}

// Dense field of individually alpha-cut leaf-on-twig clusters (left ~40% of the atlas) -- diced into
// a small grid purely so different cards can sample a different sub-crop (cheap per-card variety,
// no extra texture memory). Used for outer/silhouette-facing cards.
const DETAIL_U0 = 0.02;
const DETAIL_U1 = 0.4;
const DETAIL_V0 = 0.03;
const DETAIL_V1 = 0.97;
const DETAIL_COLS = 2;
const DETAIL_ROWS = 4;

// Solid, fully-opaque leaf-mass fill (right ~10% of the atlas, safely past the cutout boundary at
// every row). Used for cheap interior/hidden canopy bulk where per-leaf detail would be wasted
// overdraw.
const FILL_RECT: AtlasRect = { u0: 0.9, v0: 0.05, u1: 0.995, v1: 0.95 };

function detailRect(col: number, row: number): AtlasRect {
	const w = (DETAIL_U1 - DETAIL_U0) / DETAIL_COLS;
	const h = (DETAIL_V1 - DETAIL_V0) / DETAIL_ROWS;
	const u0 = DETAIL_U0 + col * w;
	const v0 = DETAIL_V0 + row * h;
	return { u0, v0, u1: u0 + w, v1: v0 + h };
}

// ---------------------------------------------------------------------------------------------
// Canopy: foliage CARDS (alpha-cutout quads), not solid cones. Several small "clusters" (each a
// 60-degree tri-cross of 3 quads, so the cluster reads from any viewing angle without per-frame
// billboarding) are scattered through an oblate-spheroid volume and merged into ONE geometry per
// tree (feature contract warning #3: deterministic seeded RNG, no bare Math.random).
// ---------------------------------------------------------------------------------------------

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

/** Near-white multiply tint with mild per-cluster variance (the REAL leaf photo supplies most of
 * the color -- this only nudges brightness/greenness so identical atlas crops don't repeat
 * identically across a canopy), a seeded chance of an autumn amber/orange tint (ties the canopy
 * palette to the forest floor's fallen-leaf-litter ground texture), and a flat darkening for
 * inner/fill clusters (reads as canopy self-shadowing/occlusion without an actual light pass). */
function clusterTint(rand: () => number, autumn: boolean, isOuter: boolean): THREE.Color {
	const shade = isOuter ? 1.0 : 0.72;
	if (autumn) {
		const h = 0.05 + rand() * 0.07;
		const s = 0.55 + rand() * 0.25;
		const l = (0.4 + rand() * 0.16) * shade;
		return new THREE.Color().setHSL(h, s, l);
	}
	const g = (0.82 + rand() * 0.32) * shade;
	return new THREE.Color(g * 0.94, g * 1.03, g * 0.86);
}

function buildLeafCardGeometry(width: number, height: number, rect: AtlasRect): THREE.BufferGeometry {
	const geo = new THREE.PlaneGeometry(width, height);
	const uv = geo.attributes.uv as THREE.BufferAttribute;
	for (let i = 0; i < uv.count; i++) {
		const u = uv.getX(i);
		const v = uv.getY(i);
		uv.setXY(i, rect.u0 + u * (rect.u1 - rect.u0), rect.v0 + v * (rect.v1 - rect.v0));
	}
	uv.needsUpdate = true;
	return geo;
}

/** One foliage "cluster": 3 quads crossed 60 degrees apart around a shared (random) yaw, all
 * sampling the SAME atlas crop + tint, positioned at `offset` (tree-local space). Rotation is baked
 * into the geometry (BufferGeometry.rotateX/Y apply their matrix to the normal attribute too, so
 * lighting stays correct without needing an explicit tangent attribute for the normal map -- three's
 * screen-space-derivative TBN fallback handles that). */
function buildFoliageCluster(rand: () => number, offset: THREE.Vector3, size: number, useDetail: boolean, autumn: boolean): THREE.BufferGeometry {
	const w = size * (0.85 + rand() * 0.3);
	const h = size * (1.05 + rand() * 0.35);
	const rect = useDetail ? detailRect(Math.floor(rand() * DETAIL_COLS), Math.floor(rand() * DETAIL_ROWS)) : FILL_RECT;
	const baseYaw = rand() * Math.PI * 2;
	const tilt = (rand() - 0.5) * 0.4;
	const tint = clusterTint(rand, autumn, useDetail);
	const pieces: THREE.BufferGeometry[] = [];
	for (let k = 0; k < 3; k++) {
		const geo = buildLeafCardGeometry(w, h, rect);
		geo.rotateX(tilt);
		geo.rotateY(baseYaw + (k * Math.PI) / 3);
		geo.translate(offset.x, offset.y, offset.z);
		paintVertexColors(geo, tint);
		pieces.push(geo);
	}
	const merged = mergeGeometries(pieces, false) ?? new THREE.BufferGeometry();
	for (const p of pieces) p.dispose();
	return merged;
}

/** Builds one merged canopy geometry (tree-local space, y=0 at the cluster's own anchor point,
 * spanning roughly y in [0, baseHeight]) from `clusterCount` foliage clusters distributed through an
 * oblate-spheroid volume (radius baseRadius, height baseHeight), biased toward the outer shell so
 * the canopy doesn't read hollow in the middle while still keeping some cheaper interior "fill"
 * depth for parallax when driving past. Deterministic for a given `seed` (feature contract warning
 * #3 -- no bare Math.random). */
function buildCanopyGeometry(seed: number, baseRadius: number, baseHeight: number, clusterCount: number): THREE.BufferGeometry {
	const rand = mulberry32(seed);
	const pieces: THREE.BufferGeometry[] = [];
	for (let i = 0; i < clusterCount; i++) {
		const theta = rand() * Math.PI * 2;
		const phiCos = 1 - 2 * rand();
		const sinPhi = Math.sqrt(Math.max(0, 1 - phiCos * phiCos));
		const radial = Math.cbrt(0.3 + rand() * 0.7); // biased toward the outer shell
		const sx = sinPhi * Math.cos(theta) * radial;
		const sz = sinPhi * Math.sin(theta) * radial;
		const sy = phiCos * radial;
		const offset = new THREE.Vector3(sx * baseRadius, baseHeight * 0.5 + sy * baseHeight * 0.42, sz * baseRadius);
		const isOuter = radial > 0.6;
		const size = baseRadius * (isOuter ? 0.5 + rand() * 0.34 : 0.55 + rand() * 0.36);
		const autumn = rand() < 0.14;
		pieces.push(buildFoliageCluster(rand, offset, size, isOuter, autumn));
	}
	const merged = mergeGeometries(pieces, false) ?? new THREE.BufferGeometry();
	for (const p of pieces) p.dispose();
	merged.computeBoundingSphere();
	return merged;
}

// ---------------------------------------------------------------------------------------------
// Trunk/branch geometry (CylinderGeometry approximating the physics capsule -- same convention as
// world/visuals.ts's barrel mesh approximating its hull shape). Real bark texture, UV-tiled per
// class + a subtle seeded silhouette jitter (root flare + bark-ridge wobble).
// ---------------------------------------------------------------------------------------------

function scaleTrunkUVs(geo: THREE.BufferGeometry, radius: number, height: number): void {
	const circumference = 2 * Math.PI * radius;
	const tilesU = Math.max(1, Math.round(circumference / BARK_TILE_M));
	const tilesV = Math.max(0.5, height / BARK_TILE_M);
	const uv = geo.attributes.uv as THREE.BufferAttribute;
	for (let i = 0; i < uv.count; i++) {
		uv.setXY(i, uv.getX(i) * tilesU, uv.getY(i) * tilesV);
	}
	uv.needsUpdate = true;
}

/** Subtle seeded radial perturbation of the trunk silhouette (bark-ridge wobble along the whole
 * trunk, plus extra flare near the base for a root-buttress read) so it doesn't look lathe-turned.
 * Purely cosmetic -- the physics capsule underneath (bodies.ts) is an untouched perfect cylinder+
 * caps; geometry here is in PRE-TRANSLATE local space (y in [-height/2, height/2], matching
 * CylinderGeometry's own convention before buildTrunkGeometry's final translate). */
function jitterTrunkSilhouette(geo: THREE.BufferGeometry, height: number, seed: number): void {
	const rand = mulberry32(seed);
	const pos = geo.attributes.position as THREE.BufferAttribute;
	for (let i = 0; i < pos.count; i++) {
		const x = pos.getX(i);
		const y = pos.getY(i);
		const z = pos.getZ(i);
		const r = Math.hypot(x, z);
		if (r < 1e-5) continue; // cap-center vertices -- nothing to perturb radially
		const heightFrac = (y + height / 2) / height;
		const rootFlare = Math.max(0, 1 - heightFrac / 0.3) * 0.16;
		const ridge = (rand() - 0.5) * 0.07;
		const scale = 1 + rootFlare + ridge;
		pos.setX(i, x * scale);
		pos.setZ(i, z * scale);
	}
	pos.needsUpdate = true;
	geo.computeVertexNormals();
	geo.computeBoundingSphere();
}

function buildTrunkGeometry(radius: number, height: number, radialSegments: number, seed: number): THREE.BufferGeometry {
	const radiusBottom = radius * 1.28;
	const geo = new THREE.CylinderGeometry(radius, radiusBottom, height, radialSegments, 3);
	scaleTrunkUVs(geo, (radius + radiusBottom) / 2, height);
	jitterTrunkSilhouette(geo, height, seed);
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
	const trunkGeo = buildTrunkGeometry(SAPLING_TRUNK_RADIUS_M, SAPLING_TRUNK_HEIGHT_M, 6, seed ^ 0xbeef);
	const trunk = new THREE.Mesh(trunkGeo, materials.bark);
	trunk.castShadow = true;
	trunk.receiveShadow = true;
	group.add(trunk);

	const canopyGeo = buildCanopyGeometry(seed, 0.75, 1.05, 18);
	const canopy = new THREE.Mesh(canopyGeo, materials.foliage);
	// Anchor lower than the canopy's own visual midpoint would suggest -- generous overlap with the
	// trunk top so sparse-sampled low clusters (see buildCanopyGeometry's outer-shell bias) never
	// leave a visible bare-trunk gap between the foliage and the trunk (caught via
	// verify/trees-visual.mjs's forest-interior screenshot).
	canopy.position.y = SAPLING_TRUNK_HEIGHT_M * 0.62;
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
	const trunkGeo = buildTrunkGeometry(MID_TRUNK_RADIUS_M, MID_TRUNK_HEIGHT_M, 10, seed ^ 0xbeef);
	const trunk = new THREE.Mesh(trunkGeo, materials.bark);
	trunk.castShadow = true;
	trunk.receiveShadow = true;
	group.add(trunk);

	const canopyGeo = buildCanopyGeometry(seed, 1.9, 2.7, 34);
	const canopy = new THREE.Mesh(canopyGeo, materials.foliage);
	canopy.position.y = MID_TRUNK_HEIGHT_M * 0.6;
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
	scaleTrunkUVs(geo, LARGE_BRANCH_RADIUS_M * 1.15, LARGE_BRANCH_LENGTH_M);
	geo.rotateZ(Math.PI / 2); // cylinder's own axis is Y; branch capsule axis is local X
	geo.translate(LARGE_BRANCH_LENGTH_M / 2, 0, 0);
	return geo;
}

function buildLargeVisual(large: LargeTree, materials: TreesMaterialSet, seed: number): LargeVisual {
	const trunkGeo = buildTrunkGeometry(LARGE_TRUNK_RADIUS_M, LARGE_TRUNK_HEIGHT_M, 12, seed ^ 0xbeef);
	const trunkMesh = new THREE.Mesh(trunkGeo, materials.bark);
	trunkMesh.castShadow = true;
	trunkMesh.receiveShadow = true;
	const tt = large.trunk.getTransform();
	trunkMesh.position.set(tt.position.x, tt.position.y, tt.position.z);
	trunkMesh.quaternion.set(tt.rotation.x, tt.rotation.y, tt.rotation.z, tt.rotation.w);
	trunkMesh.name = `tree-${large.id}-trunk`;

	const canopyGeo = buildCanopyGeometry(seed, 2.7, 3.8, 48);
	const canopyMesh = new THREE.Mesh(canopyGeo, materials.foliage);
	canopyMesh.position.set(tt.position.x, tt.position.y + LARGE_TRUNK_HEIGHT_M * 0.58, tt.position.z);
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
