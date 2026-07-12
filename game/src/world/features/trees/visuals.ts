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
}

export interface TreesVisualBundle {
	readonly saplings: TreeInstanceVisual[];
	readonly mids: TreeInstanceVisual[];
	readonly larges: TreeInstanceVisual[];
	readonly group: THREE.Group;
	/** Distinct templates in use — disposed once at teardown (clones share these resources). */
	readonly templates: TreeTemplate[];
	/** FRACTURE stump visuals, keyed by MidTree id — created lazily the step a mid trunk SNAPS
	 * (sampleTreesVisuals derives them straight from trees.mids[i].stump; no event plumbing), removed
	 * on reset. One shared material/geometry-per-stump, disposed with the visual. */
	readonly stumps: Map<string, { mesh: THREE.Mesh; transform: InterpolatedTransform }>;
	/** Shared bark material for stump meshes (lazily created once, disposed at teardown). */
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
	return { group, transform };
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
// FRACTURE stump visuals (docs/loom/d1-fracture-material-spec.md): when a mid trunk SNAPS
// (bodies.ts's fractureMid), the tree's own GLB visual keeps following m.trunk — which now aliases
// the FLYING top piece — so the falling tree animates for free; the anchored base STUMP fragment
// gets a simple bark-brown cylinder with a lighter "splintered" top cap (cheap two-material
// cylinder — deterministic, no CanvasTexture, no DOM dependency beyond three itself, which this
// browser-only module already imports).
// ---------------------------------------------------------------------------------------------

const STUMP_BARK_COLOR = 0x5a4632; // matches fallbackTemplate()'s trunk brown
const STUMP_SPLINTER_COLOR = 0xc9b287; // pale exposed-wood tone for the broken top face

function stumpVisualFor(bundle: TreesVisualBundle, radius: number, capLen: number): { mesh: THREE.Mesh; transform: InterpolatedTransform } {
	if (!bundle.stumpMaterial) {
		bundle.stumpMaterial = new THREE.MeshStandardMaterial({ color: STUMP_BARK_COLOR, roughness: 1 });
	}
	const splinterMat = new THREE.MeshStandardMaterial({ color: STUMP_SPLINTER_COLOR, roughness: 0.9 });
	const height = capLen + radius; // physics capsule spans y in [0, capLen + 2r]; cylinder approximates it
	const geo = new THREE.CylinderGeometry(radius, radius * 1.12, height, 10, 1);
	// CylinderGeometry group order: side=0, top cap=1, bottom cap=2 — light the TOP as splintered wood.
	const mesh = new THREE.Mesh(geo, [bundle.stumpMaterial, splinterMat, bundle.stumpMaterial]);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	// Body origin sits at the stump BASE (trees/bodies convention); cylinder origin is its center.
	geo.translate(0, height / 2, 0);
	return { mesh, transform: new InterpolatedTransform() };
}

function syncStumpVisuals(trees: TreesWorld, bundle: TreesVisualBundle): void {
	for (const m of trees.mids) {
		if (!m.fractured || !m.stump) continue;
		let v = bundle.stumps.get(m.id);
		if (!v) {
			const frag = m.stump.frag;
			v = stumpVisualFor(bundle, frag.capsuleRadius ?? 0.3, frag.capsuleCapLen ?? 1);
			const t = m.stump.frag.body.getTransform();
			v.mesh.position.set(t.position.x, t.position.y, t.position.z);
			v.mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
			v.transform.sample(t.position, t.rotation);
			v.transform.sample(t.position, t.rotation);
			bundle.group.add(v.mesh);
			bundle.stumps.set(m.id, v);
		} else {
			const t = m.stump.frag.body.getTransform();
			v.transform.sample(t.position, t.rotation);
		}
	}
}

function disposeStumpVisual(bundle: TreesVisualBundle, id: string): void {
	const v = bundle.stumps.get(id);
	if (!v) return;
	bundle.group.remove(v.mesh);
	v.mesh.geometry.dispose();
	const mats = Array.isArray(v.mesh.material) ? v.mesh.material : [v.mesh.material];
	for (const mat of mats) if (mat !== bundle.stumpMaterial) (mat as THREE.Material).dispose();
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
	for (const v of bundle.stumps.values()) v.transform.applyTo(v.mesh, alpha);
}

/** After a full reset, double-sample every transform from the NEW pose + snap the group, so the
 * render-time lerp doesn't visibly interpolate from an old (possibly felled) pose across one frame —
 * same trick as world/visuals.ts's resnapDestructibleVisuals(). Fracture stump visuals are removed
 * outright (reset rebuilt every fractured mid pristine, so no mid has a stump fragment anymore). */
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
