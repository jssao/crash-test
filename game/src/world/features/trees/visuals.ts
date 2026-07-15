// SPDX-License-Identifier: MIT
//
// Three.js visuals for the 'trees' world feature. Each tree is a real optimized GLB model (Tree Pack
// 01, decimated + textured, see assets-src/CREDITS.md's tree entry) placed at — and driven by — its
// physics trunk body, exactly the same renderer-free-physics <-> THREE bridge the rest of the game
// uses (one InterpolatedTransform per tree, sampled after each fixed step, lerped each render frame).
//
// REPLACES the earlier fully-procedural trunk-cylinder + foliage-card build. What changed is ONLY how
// a tree's MESH is produced (a cloned GLB instead of built geometry) — NOT which body drives which
// mesh, nor the public API (buildTreesVisuals / sampleTreesVisuals / applyTreesVisuals /
// resnapTreesVisuals / disposeTreesVisuals, and the `.group` / `.saplings|.mids|.larges` bundle
// shape), so ./index.ts and its feature-contract wiring are untouched. The tree PHYSICS
// (./bodies.ts, ./tuning.ts) is likewise untouched — this file only reads dims/seeds from ./tuning.ts.
//
// GLB PRELOAD: the ~6 tree GLBs are loaded ONCE at module load via a top-level await, then CLONED per
// instance (clone shares geometry + material, so 158 forest trees cost 6 geometry uploads, not 158).
// Keeping the load at module scope lets buildTreesVisuals() stay synchronous — the feature factory in
// ./index.ts calls it synchronously and needs no `await`. The load is browser-only (the headless sim
// tests import ./bodies.ts directly, never this file), and is fully guarded: any model that fails to
// fetch/parse falls back to a simple procedural tree so the feature can never fail to build.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { InterpolatedTransform } from '../../../core/loop';
import type { TreesWorld } from './bodies';
import {
	LARGE_TRUNK_HEIGHT_M,
	MID_TRUNK_HEIGHT_M,
	mulberry32,
	SAPLING_TRUNK_HEIGHT_M,
	TREES_RNG_SEED,
} from './tuning';

// ---------------------------------------------------------------------------------------------
// Model catalog: which GLBs serve which size class (several per class → forest variety), plus the
// canopy-factor that turns a class's physics TRUNK height into the whole tree's visual height (the
// canopy sits above the trunk, so the visual tree is taller than the collision capsule — the standard
// "visual approximates, does not exactly match, the collision shape" convention).
// ---------------------------------------------------------------------------------------------

const MODELS_BASE = 'assets/trees/models';

const CLASS_MODELS = {
	sapling: ['tree_005', 'tree_004'],
	mid: ['tree_022', 'tree_014'],
	large: ['tree_013', 'tree_012'],
} as const;

const SAPLING_VISUAL_HEIGHT_M = SAPLING_TRUNK_HEIGHT_M * 1.55;
const MID_VISUAL_HEIGHT_M = MID_TRUNK_HEIGHT_M * 1.28;
const LARGE_VISUAL_HEIGHT_M = LARGE_TRUNK_HEIGHT_M * 1.35;

// DISTANCE LOD (perf): the forest is ~158 trees (98 saplings / 38 mids / 22 larges), each a real GLB.
// three.js already frustum-culls off-screen trees; this additionally hides trees beyond ~105 m from
// the focus point (the car) — the far ON-screen forest that would otherwise pay full vertex+fill cost
// every frame. Squared distances (no sqrt); a small show/hide hysteresis band kills boundary flicker.
// applyTreesVisuals() does the per-frame cull; buildInstance() seeds the SAME cull from spawn so the
// very first render (incl. the boot quality benchmark) doesn't pay for the whole forest either.
const TREE_LOD_SHOW_M2 = 105 * 105;
const TREE_LOD_HIDE_M2 = 114 * 114;

interface TreeTemplate {
	/** Recentered (base at y=0, centred in x/z) template scene, ready to clone. */
	readonly scene: THREE.Object3D;
	/** Native (pre-scale) height in metres, for the scale-to-class-height factor. */
	readonly nativeHeight: number;
}

// ---------------------------------------------------------------------------------------------
// Preload (top-level await, browser-only) — load every distinct GLB once, guarded per-model.
// ---------------------------------------------------------------------------------------------

function prepareTemplate(scene: THREE.Object3D): TreeTemplate {
	scene.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(scene);
	const size = new THREE.Vector3();
	const center = new THREE.Vector3();
	box.getSize(size);
	box.getCenter(center);
	// Recenter: base on the ground (min.y -> 0), centred in x/z. The offset lives in the template
	// root's own position (native units); an instance's scale-wrapper scales it along with the
	// geometry, so the base stays pinned at the wrapper origin at any class scale.
	scene.position.set(-center.x, -box.min.y, -center.z);
	scene.traverse((o) => {
		const mesh = o as THREE.Mesh;
		if (mesh.isMesh) {
			mesh.castShadow = true;
			mesh.receiveShadow = true;
		}
	});
	return { scene, nativeHeight: Math.max(size.y, 0.01) };
}

/** Dead-simple procedural stand-in (brown trunk + green blob) used only if a GLB fails to load, so
 * the feature never fails to build. Native height ~4 m, recentered like a real template. */
function fallbackTemplate(): TreeTemplate {
	const group = new THREE.Group();
	const trunk = new THREE.Mesh(
		new THREE.CylinderGeometry(0.16, 0.22, 3, 6),
		new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 }),
	);
	trunk.position.y = 1.5;
	const canopy = new THREE.Mesh(
		// Smooth (not faceted) so a last-resort fallback doesn't read as an obvious low-poly blob.
		new THREE.IcosahedronGeometry(1.6, 3),
		new THREE.MeshStandardMaterial({ color: 0x3f6b30, roughness: 0.95 }),
	);
	canopy.position.y = 3.4;
	group.add(trunk, canopy);
	return prepareTemplate(group);
}

/** Loads one tree GLB with a few RETRIES before giving up. A busy dev server / transient fetch hiccup
 * (e.g. the server stalling under a concurrent load) was intermittently failing whole variants, which
 * left every instance of that variant as the ugly procedural fallback (a faceted blob). Retrying with
 * a short backoff makes the fallback a genuine last resort rather than a flaky-network artifact. */
async function loadOneTemplate(loader: GLTFLoader, name: string, attempts = 3): Promise<TreeTemplate> {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const gltf = await loader.loadAsync(`${MODELS_BASE}/${name}.glb`);
			return prepareTemplate(gltf.scene);
		} catch (err) {
			if (attempt === attempts) {
				console.warn(`[trees] ${name}.glb failed after ${attempts} attempts — using fallback:`, err);
				return fallbackTemplate();
			}
			await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
		}
	}
	return fallbackTemplate();
}

async function loadTemplates(): Promise<Map<string, TreeTemplate>> {
	const loader = new GLTFLoader();
	const names = [...new Set(Object.values(CLASS_MODELS).flat())];
	const out = new Map<string, TreeTemplate>();
	await Promise.all(names.map(async (name) => out.set(name, await loadOneTemplate(loader, name))));
	return out;
}

// Loaded once, at module evaluation. See the file header for why top-level await is safe here.
const TEMPLATES: Map<string, TreeTemplate> = await loadTemplates();

// ---------------------------------------------------------------------------------------------
// Instance construction
// ---------------------------------------------------------------------------------------------

export interface TreeInstanceVisual {
	readonly group: THREE.Group;
	readonly transform: InterpolatedTransform;
	/** Which TEMPLATES key this instance cloned (P015 GLB-stump fix) -- so if this tree later
	 * FRACTURES, the stump can be built from the SAME bark/trunk geometry the standing tree used,
	 * rather than a mismatched random pick. */
	readonly templateName: string;
}

export interface TreesVisualBundle {
	readonly saplings: TreeInstanceVisual[];
	readonly mids: TreeInstanceVisual[];
	readonly larges: TreeInstanceVisual[];
	readonly group: THREE.Group;
	/** Distinct templates in use — disposed once at teardown (clones share these resources). */
	readonly templates: TreeTemplate[];
	/** FRACTURE stump visuals, keyed by MidTree/SaplingTree id — created lazily the step a trunk SNAPS
	 * (sampleTreesVisuals derives them straight from trees.mids[i].stump / trees.saplings[i].stump; no
	 * event plumbing), removed on reset. P015: built from the SAME GLB template's own trunk geometry
	 * (extractTrunkGeometrySource/clipTrunkGeometryBelowY below), not a primitive cylinder. */
	readonly stumps: Map<string, StumpVisual>;
	/** Shared pale "exposed wood" splinter-cap material (lazily created once, disposed at teardown). */
	stumpMaterial: THREE.MeshStandardMaterial | null;
}

/** The one thing this file needs off a tree body: its live transform. SaplingTree/MidTree/LargeTree
 * all expose it via `.trunk` (a box3d Body), which structurally satisfies this. */
interface HasTransform {
	getTransform(): { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } };
}

function trunkBodies(trees: TreesWorld): { saplings: HasTransform[]; mids: HasTransform[]; larges: HasTransform[] } {
	return {
		saplings: trees.saplings.map((s) => s.trunk),
		mids: trees.mids.map((m) => m.trunk),
		larges: trees.larges.map((l) => l.trunk),
	};
}

/** Builds one tree instance: a body-driven group holding a scaled, yaw-jittered clone of a class
 * template. `rand` (seeded) picks the variant + a random yaw so cloned trees don't all face the same
 * way. */
function buildInstance(trunk: HasTransform, templateNames: readonly string[], targetHeight: number, rand: () => number): TreeInstanceVisual {
	const name = templateNames[Math.floor(rand() * templateNames.length)] ?? templateNames[0];
	const template = TEMPLATES.get(name) ?? fallbackTemplate();

	const group = new THREE.Group();
	group.name = 'tree';
	const wrapper = new THREE.Group();
	wrapper.scale.setScalar(targetHeight / template.nativeHeight);
	wrapper.rotation.y = rand() * Math.PI * 2;
	wrapper.add(template.scene.clone(true));
	group.add(wrapper);

	const t = trunk.getTransform();
	group.position.set(t.position.x, t.position.y, t.position.z);
	group.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	// Seed the distance-cull from spawn (car spawns near the origin), so the first frame / boot
	// benchmark doesn't render the whole forest before applyTreesVisuals() takes over.
	group.visible = t.position.x * t.position.x + t.position.z * t.position.z < TREE_LOD_HIDE_M2;
	const transform = new InterpolatedTransform();
	transform.sample(t.position, t.rotation);
	transform.sample(t.position, t.rotation);
	return { group, transform, templateName: name };
}

/** Builds every tree's visuals into one fresh THREE.Group (returned); caller adds it to the scene
 * once — same convention as world/visuals.ts's buildDestructibleVisuals(). Synchronous: the GLB
 * templates were already loaded at module scope (see file header). */
export function buildTreesVisuals(trees: TreesWorld): TreesVisualBundle {
	const group = new THREE.Group();
	group.name = 'TreesFeature';
	const bodies = trunkBodies(trees);

	const build = (trunks: readonly HasTransform[], names: readonly string[], height: number, seedBase: number): TreeInstanceVisual[] =>
		trunks.map((trunk, i) => {
			const rand = mulberry32((TREES_RNG_SEED + seedBase + i * 2654435761) >>> 0);
			const v = buildInstance(trunk, names, height, rand);
			group.add(v.group);
			return v;
		});

	const saplings = build(bodies.saplings, CLASS_MODELS.sapling, SAPLING_VISUAL_HEIGHT_M, 0x1111);
	const mids = build(bodies.mids, CLASS_MODELS.mid, MID_VISUAL_HEIGHT_M, 0x2222);
	const larges = build(bodies.larges, CLASS_MODELS.large, LARGE_VISUAL_HEIGHT_M, 0x3333);

	const templates = [...new Set(TEMPLATES.values())];
	return { saplings, mids, larges, group, templates, stumps: new Map(), stumpMaterial: null };
}

// ---------------------------------------------------------------------------------------------
// FRACTURE stump visuals (docs/loom/d1-fracture-material-spec.md; P015 GLB-stump fix): when a mid OR
// sapling trunk SNAPS (bodies.ts's fractureMid/fractureSapling), the tree's own GLB visual keeps
// following `.trunk` — which now aliases the FLYING top piece — so the falling half animates for free;
// the anchored base STUMP fragment gets a stump built from the SAME GLB template's own trunk geometry
// (found by material name, "trunk-only" triangles extracted, then clipped at the break height) plus a
// small flat "splintered" pale disc at the cut, instead of a primitive cylinder — P015: "the stump must
// visually match the standing tree's bark/trunk". Pure geometry data manipulation (no renderer/
// clipping-plane changes — that setup lives in scene files owned elsewhere, see this task's brief).
//
// DISPOSAL SAFETY: every geometry a stump owns is a fully independent, freshly-copied buffer (position/
// normal/uv/index all rebuilt from scratch, never literal references into a template's or another
// stump's own attribute arrays). This matters because THREE.BufferGeometry.dispose() frees ITS
// attributes unconditionally, with no reference count — sharing an attribute *object* across two
// geometries and disposing one would silently corrupt the other (in this codebase's case, that would
// mean a broken sapling's stump disposal blanking out every OTHER still-standing tree cloned from the
// same template, since clones share geometry — see this file's header doc). Fully independent copies
// side-step that hazard entirely, at a one-time, per-fracture-event cost (capped at 1 fracture/step)
// of copying a few thousand vertices — trivial next to a GLB load.
// ---------------------------------------------------------------------------------------------

const STUMP_BARK_COLOR = 0x5a4632; // matches fallbackTemplate()'s trunk brown (fallback-template stumps only)
const STUMP_SPLINTER_COLOR = 0xc9b287; // pale exposed-wood tone for the broken top face

interface StumpVisual {
	readonly root: THREE.Object3D;
	readonly transform: InterpolatedTransform;
	/** Geometries THIS stump instance allocated (always fresh/independent — see section doc comment
	 * above) — disposed with it. Never includes a template's own shared trunk geometry/material, nor
	 * the bundle's shared splinter-cap material (bundle.stumpMaterial, disposed once at bundle
	 * teardown instead). */
	readonly ownGeometries: THREE.BufferGeometry[];
	readonly ownMaterials: THREE.Material[];
}

interface TrunkGeometrySource {
	/** Independent copy (own position/normal/uv/index arrays) of just the "trunk" material-group's
	 * triangles from a template — never assigned to any rendered mesh directly, only ever read from
	 * (clipTrunkGeometryBelowY copies out of it again per stump instance). Native (pre-scale) units. */
	readonly geometry: THREE.BufferGeometry;
	/** The template's OWN shared trunk material (Tree Pack 01: "Trunk_XXX") — reused, NEVER disposed by
	 * a stump (still owned/used by every standing instance of this template). */
	readonly material: THREE.Material;
}

/** Cached once per template (module-scope, like TEMPLATES itself — see this file's header doc for why
 * a top-level cache is the established convention here). `null` means "no trunk-named material found
 * on this template" (e.g. fallbackTemplate()'s unnamed materials) — callers fall back to a primitive
 * stump so the feature can never fail to build one. */
const TRUNK_GEOMETRY_CACHE = new Map<TreeTemplate, TrunkGeometrySource | null>();

/** Copies just the vertices `srcIndices` (a flat triangle-list) actually reference out of `pos`/`nrm`/
 * `uv` into brand-new, compacted, fully-independent arrays + a remapped index — the one building block
 * both extractTrunkGeometrySource() (group -> standalone geometry) and clipTrunkGeometryBelowY()
 * (standalone geometry -> height-clipped subset) need. */
function compactTriangles(
	srcIndices: ArrayLike<number>,
	pos: THREE.BufferAttribute,
	nrm: THREE.BufferAttribute | undefined,
	uv: THREE.BufferAttribute | undefined,
): THREE.BufferGeometry {
	const remap = new Map<number, number>();
	const newPos: number[] = [];
	const newNrm: number[] = [];
	const newUv: number[] = [];
	const newIndex: number[] = [];
	const addVertex = (i: number): number => {
		let ni = remap.get(i);
		if (ni === undefined) {
			ni = newPos.length / 3;
			remap.set(i, ni);
			newPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
			if (nrm) newNrm.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
			if (uv) newUv.push(uv.getX(i), uv.getY(i));
		}
		return ni;
	};
	for (let i = 0; i < srcIndices.length; i++) newIndex.push(addVertex(srcIndices[i]));

	const geo = new THREE.BufferGeometry();
	geo.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
	if (newNrm.length > 0) geo.setAttribute('normal', new THREE.Float32BufferAttribute(newNrm, 3));
	if (newUv.length > 0) geo.setAttribute('uv', new THREE.Float32BufferAttribute(newUv, 2));
	geo.setIndex(newIndex);
	if (newNrm.length === 0) geo.computeVertexNormals();
	geo.computeBoundingBox();
	geo.computeBoundingSphere();
	return geo;
}

/** Locates the first mesh (and which material-array index on it) whose material name contains "trunk"
 * -- pulled out into its OWN function (rather than a `let` mutated inside the traverse closure read
 * afterward) purely to keep TypeScript's control-flow narrowing simple at the one call site below. */
function findTrunkMeshAndMaterialIndex(scene: THREE.Object3D): { mesh: THREE.Mesh; matIndex: number } | null {
	let result: { mesh: THREE.Mesh; matIndex: number } | null = null;
	scene.traverse((o) => {
		if (result) return;
		const mesh = o as THREE.Mesh;
		if (!mesh.isMesh) return;
		const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
		const idx = mats.findIndex((m) => /trunk/i.test((m as THREE.Material).name ?? ''));
		if (idx >= 0) result = { mesh, matIndex: idx };
	});
	return result;
}

/** Finds the sub-mesh/material-group within a loaded GLB template whose material name contains "trunk"
 * (Tree Pack 01's convention — Trunk_XXX/Leaf_XXX/Bud_XXX, verified against every model this feature
 * uses) and extracts JUST that group's triangles (dropping foliage/bud) into a standalone, independent
 * geometry — the "geometry masking" approach. */
function extractTrunkGeometrySource(template: TreeTemplate): TrunkGeometrySource | null {
	const cached = TRUNK_GEOMETRY_CACHE.get(template);
	if (cached !== undefined) return cached;

	const found = findTrunkMeshAndMaterialIndex(template.scene);
	if (!found) {
		TRUNK_GEOMETRY_CACHE.set(template, null);
		return null;
	}

	const { mesh, matIndex } = found;
	const geo = mesh.geometry;
	const pos = geo.attributes.position as THREE.BufferAttribute;
	const nrm = geo.attributes.normal as THREE.BufferAttribute | undefined;
	const uv = geo.attributes.uv as THREE.BufferAttribute | undefined;
	const srcIndex = geo.index;
	const totalTriIndices = srcIndex ? srcIndex.count : pos.count;
	const groups = geo.groups.length > 0 ? geo.groups : [{ start: 0, count: totalTriIndices, materialIndex: 0 }];
	const group = groups.find((g) => g.materialIndex === matIndex) ?? groups[0];

	const srcIndices: number[] = [];
	for (let i = group.start; i < group.start + group.count; i++) srcIndices.push(srcIndex ? srcIndex.getX(i) : i);
	const outGeo = compactTriangles(srcIndices, pos, nrm, uv);

	const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
	const result: TrunkGeometrySource = { geometry: outGeo, material: mats[matIndex] as THREE.Material };
	TRUNK_GEOMETRY_CACHE.set(template, result);
	return result;
}

/** Squashes a trunk-only source geometry's ENTIRE vertical extent down to `nativeTargetHeight` (native/
 * local units — the template's own pre-scale space), preserving every vertex's relative height fraction
 * (and therefore the trunk's natural taper silhouette), just compressed. Always returns a fresh,
 * independent geometry (see section doc comment on disposal safety).
 *
 * CHOSEN OVER an absolute-height CLIP (keep only triangles below the cut) after finding, empirically
 * (eyes-on screenshot review), that this Tree Pack's trunk mesh has only a few sparse vertex "rings"
 * along its height (a low-poly optimization -- verified directly against tree_022.glb's own accessor
 * data: zero vertices between y=0.3 and y=3.5 of an 8m-tall trunk), not a dense continuous surface. A
 * height clip on that topology either kept almost nothing (cut below the first ring) or kept a long,
 * thin sliver up to the NEXT ring far above the cut (cut between rings) -- it read as a spindly antenna,
 * not a stump. Squashing the WHOLE trunk-only group sidesteps the sparse-ring gap entirely: every
 * vertex the mesh actually has (including its normal base girth) contributes to the result. */
function squashTrunkGeometryToHeight(source: TrunkGeometrySource, nativeTargetHeight: number): THREE.BufferGeometry {
	const geo = source.geometry.clone(); // BufferGeometry.clone() deep-copies every attribute -- fully independent
	const pos = geo.attributes.position as THREE.BufferAttribute;
	const bb = source.geometry.boundingBox!;
	const nativeSourceHeight = Math.max(0.01, bb.max.y - bb.min.y);
	const squash = nativeTargetHeight / nativeSourceHeight;
	for (let i = 0; i < pos.count; i++) pos.setY(i, (pos.getY(i) - bb.min.y) * squash + bb.min.y);
	pos.needsUpdate = true;
	geo.computeVertexNormals(); // squashing distorts the original normals; a fresh compute keeps shading sane
	geo.computeBoundingBox();
	geo.computeBoundingSphere();
	return geo;
}

/** Builds one stump's visual: the real bark/trunk geometry (squashed to the break height, see
 * squashTrunkGeometryToHeight's doc comment for why squash-not-clip) plus a small flat pale
 * "splintered wood" disc at the cut — or, if this template has no identifiable trunk material
 * (last-resort fallbackTemplate()), the old primitive two-material cylinder so the feature can never
 * fail to build a stump. `targetHeightM` is the STANDING tree's own class visual height (so the stump
 * uses the exact same native->world scale factor the intact tree does); `worldStumpHeightM`/
 * `worldStumpRadiusM` are the physics stump fragment's real dimensions (capLen+radius / radius). */
function stumpVisualFor(bundle: TreesVisualBundle, templateName: string, targetHeightM: number, worldStumpHeightM: number, worldStumpRadiusM: number): StumpVisual {
	if (!bundle.stumpMaterial) {
		bundle.stumpMaterial = new THREE.MeshStandardMaterial({ color: STUMP_SPLINTER_COLOR, roughness: 0.9 });
	}
	const template = TEMPLATES.get(templateName) ?? fallbackTemplate();
	const source = extractTrunkGeometrySource(template);
	const scale = targetHeightM / template.nativeHeight;
	const root = new THREE.Group();
	root.name = 'tree-stump';
	const ownGeometries: THREE.BufferGeometry[] = [];
	const ownMaterials: THREE.Material[] = [];

	if (source) {
		const nativeTargetHeight = worldStumpHeightM / scale;
		const squashed = squashTrunkGeometryToHeight(source, nativeTargetHeight);
		ownGeometries.push(squashed);
		const wrapper = new THREE.Group();
		wrapper.scale.setScalar(scale);
		const trunkMesh = new THREE.Mesh(squashed, source.material); // shared template material -- not ours to dispose
		trunkMesh.castShadow = true;
		trunkMesh.receiveShadow = true;
		wrapper.add(trunkMesh);
		root.add(wrapper);

		// Cap radius: the physics capsule's OWN real radius (not inferred from the sparse mesh) -- always
		// well-defined and physically exact (it's the true cross-section the trunk was cut at).
		const capRadius = Math.max(0.03, worldStumpRadiusM);
		const capGeo = new THREE.CircleGeometry(capRadius, 10);
		ownGeometries.push(capGeo);
		const cap = new THREE.Mesh(capGeo, bundle.stumpMaterial); // shared splinter material -- not ours to dispose
		cap.rotation.x = -Math.PI / 2;
		cap.position.y = worldStumpHeightM;
		cap.receiveShadow = true;
		root.add(cap);
	} else {
		const radius = 0.15 * scale;
		const height = Math.max(0.05, worldStumpHeightM);
		const geo = new THREE.CylinderGeometry(radius, radius * 1.12, height, 10, 1);
		geo.translate(0, height / 2, 0); // body origin sits at the stump BASE; cylinder origin is its center
		ownGeometries.push(geo);
		const barkMat = new THREE.MeshStandardMaterial({ color: STUMP_BARK_COLOR, roughness: 1 });
		ownMaterials.push(barkMat);
		// CylinderGeometry group order: side=0, top cap=1, bottom cap=2 -- light the TOP as splintered wood.
		const mesh = new THREE.Mesh(geo, [barkMat, bundle.stumpMaterial, barkMat]);
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		root.add(mesh);
	}

	return { root, transform: new InterpolatedTransform(), ownGeometries, ownMaterials };
}

/** Ensures a stump visual exists (creating it lazily the first step a trunk's `stump` fragment shows
 * up) and keeps its transform sampled every step thereafter — shared by both the mid and sapling
 * fracture paths below (same shape, different source arrays). */
function ensureStumpVisual(
	bundle: TreesVisualBundle,
	id: string,
	templateName: string,
	targetHeightM: number,
	stumpBody: HasTransform,
	capsuleRadius: number | undefined,
	capsuleCapLen: number | undefined,
): void {
	const worldStumpRadiusM = capsuleRadius ?? 0.1;
	const worldStumpHeightM = (capsuleCapLen ?? 1) + worldStumpRadiusM;
	let v = bundle.stumps.get(id);
	if (!v) {
		v = stumpVisualFor(bundle, templateName, targetHeightM, worldStumpHeightM, worldStumpRadiusM);
		const t = stumpBody.getTransform();
		v.root.position.set(t.position.x, t.position.y, t.position.z);
		v.root.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
		v.transform.sample(t.position, t.rotation);
		v.transform.sample(t.position, t.rotation);
		bundle.group.add(v.root);
		bundle.stumps.set(id, v);
	} else {
		const t = stumpBody.getTransform();
		v.transform.sample(t.position, t.rotation);
	}
}

function syncStumpVisuals(trees: TreesWorld, bundle: TreesVisualBundle): void {
	for (let i = 0; i < trees.mids.length; i++) {
		const m = trees.mids[i];
		if (!m.fractured || !m.stump) continue;
		const visual = bundle.mids[i];
		ensureStumpVisual(bundle, m.id, visual.templateName, MID_VISUAL_HEIGHT_M, m.stump.frag.body, m.stump.frag.capsuleRadius, m.stump.frag.capsuleCapLen);
	}
	for (let i = 0; i < trees.saplings.length; i++) {
		const s = trees.saplings[i];
		if (!s.fractured || !s.stump) continue;
		const visual = bundle.saplings[i];
		ensureStumpVisual(bundle, s.id, visual.templateName, SAPLING_VISUAL_HEIGHT_M, s.stump.frag.body, s.stump.frag.capsuleRadius, s.stump.frag.capsuleCapLen);
	}
}

function disposeStumpVisual(bundle: TreesVisualBundle, id: string): void {
	const v = bundle.stumps.get(id);
	if (!v) return;
	bundle.group.remove(v.root);
	for (const geo of v.ownGeometries) geo.dispose();
	for (const mat of v.ownMaterials) mat.dispose();
	bundle.stumps.delete(id);
}

// ---------------------------------------------------------------------------------------------
// Per-step sampling / per-frame apply / reset resnap — every tree (sapling, mid AND large) now
// simply follows its own trunk body, so a bent sapling, a leaning mid and a felled large tree all
// animate uniformly. (The old split — static large trunk + separately-animated branch meshes — is
// gone: the GLB carries its own branches, and the breakable branch BODIES still exist for physics/
// collision, they just no longer drive a separate visual.)
// ---------------------------------------------------------------------------------------------

function eachTrunk(trees: TreesWorld, bundle: TreesVisualBundle, fn: (trunk: HasTransform, visual: TreeInstanceVisual) => void): void {
	const b = trunkBodies(trees);
	for (let i = 0; i < b.saplings.length; i++) fn(b.saplings[i], bundle.saplings[i]);
	for (let i = 0; i < b.mids.length; i++) fn(b.mids[i], bundle.mids[i]);
	for (let i = 0; i < b.larges.length; i++) fn(b.larges[i], bundle.larges[i]);
}

/** Call once per fixed physics step (after stepTreesWorld()). Also derives fracture stump visuals
 * straight from the physics state (a mid with a live stump fragment gets a cylinder mesh, created
 * the first step it exists). */
export function sampleTreesVisuals(trees: TreesWorld, bundle: TreesVisualBundle): void {
	eachTrunk(trees, bundle, (trunk, visual) => {
		const t = trunk.getTransform();
		visual.transform.sample(t.position, t.rotation);
	});
	syncStumpVisuals(trees, bundle);
}

/** Call once per render frame with the accumulator's interpolation alpha. `focus` (the car position)
 * enables the distance LOD — trees far from it are hidden (and skip their per-frame matrix update).
 * Omit `focus` to keep every tree visible (e.g. the model viewer, which never crops the forest). */
export function applyTreesVisuals(bundle: TreesVisualBundle, alpha: number, focus?: { x: number; z: number }): void {
	const applyOne = (v: TreeInstanceVisual): void => {
		if (focus) {
			const dx = v.group.position.x - focus.x;
			const dz = v.group.position.z - focus.z;
			const d2 = dx * dx + dz * dz;
			if (d2 > TREE_LOD_HIDE_M2) {
				v.group.visible = false;
				return; // hidden + skip the matrix update
			}
			if (d2 < TREE_LOD_SHOW_M2) v.group.visible = true;
			else if (!v.group.visible) return; // hysteresis band, still hidden: leave it
		}
		v.transform.applyTo(v.group, alpha);
	};
	for (const v of bundle.saplings) applyOne(v);
	for (const v of bundle.mids) applyOne(v);
	for (const v of bundle.larges) applyOne(v);
	// Stumps are transient + spawn where the car just crashed (never far) — always applied.
	for (const v of bundle.stumps.values()) v.transform.applyTo(v.root, alpha);
}

/** After a full reset, double-sample every transform from the NEW pose + snap the group, so the
 * render-time lerp doesn't visibly interpolate from an old (possibly felled) pose across one frame —
 * same trick as world/visuals.ts's resnapDestructibleVisuals(). Fracture stump visuals (mid AND
 * sapling) are removed outright (reset rebuilds every fractured tree pristine, so nothing has a stump
 * fragment anymore). */
export function resnapTreesVisuals(trees: TreesWorld, bundle: TreesVisualBundle): void {
	eachTrunk(trees, bundle, (trunk, visual) => {
		const t = trunk.getTransform();
		visual.transform.sample(t.position, t.rotation);
		visual.transform.sample(t.position, t.rotation);
		visual.group.position.set(t.position.x, t.position.y, t.position.z);
		visual.group.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	});
	for (const id of [...bundle.stumps.keys()]) disposeStumpVisual(bundle, id);
}

export function disposeTreesVisuals(bundle: TreesVisualBundle): void {
	for (const id of [...bundle.stumps.keys()]) disposeStumpVisual(bundle, id);
	bundle.stumpMaterial?.dispose();
	// Only the templates own geometry/materials/textures; instance clones share them, so dispose the
	// templates ONCE (disposing a clone would break its siblings).
	for (const template of bundle.templates) {
		template.scene.traverse((o) => {
			const mesh = o as THREE.Mesh;
			if (!mesh.isMesh) return;
			mesh.geometry?.dispose();
			const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
			for (const mat of mats) {
				const std = mat as THREE.MeshStandardMaterial;
				std?.map?.dispose();
				std?.normalMap?.dispose();
				std?.dispose?.();
			}
		});
	}
}
