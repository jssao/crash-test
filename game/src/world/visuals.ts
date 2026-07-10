// SPDX-License-Identifier: MIT
//
// Three.js visuals for the destructible world (G4 spec): one mesh per dynamic body (wallBlock/crate/
// pole = box, barrel = 12-gon cylinder) plus the 2 static ramp meshes, all using the procedural PBR
// materials from ./materials.ts. Bridges the renderer-free physics bodies (./bodies.ts) to THREE the
// same way game/src/scene/carDeformables.ts / panelVisuals.ts bridge the car's own bodies.

import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { InterpolatedTransform } from '../core/loop';
import type { DestructibleBody, DestructibleWorld, ExplosionEvent, RampBody } from './bodies';
import { wedgeHullPoints } from './bodies';
import {
	buildDestructibleMaterials,
	buildFireballTexture,
	buildSmokeTexture,
	disposeDestructibleMaterials,
	type DestructibleMaterialSets,
} from './materials';
import {
	FIREBALL_CORE_LIFETIME_S,
	FIREBALL_CORE_MAX_SCALE_M,
	FIREBALL_SPRITES_PER_BURST,
	SMOKE_LIFETIME_S,
	SMOKE_MAX_SCALE_M,
	SMOKE_SPRITES_PER_BURST,
} from './tuning';

export interface DestructibleVisual {
	readonly mesh: THREE.Mesh;
	readonly transform: InterpolatedTransform;
}

export interface DestructibleVisualBundle {
	/** Aligned 1:1 with DestructibleWorld.bodies. */
	readonly visuals: DestructibleVisual[];
	readonly materials: DestructibleMaterialSets;
	readonly group: THREE.Group;
	/** Exploding-barrels fireball/smoke burst state -- see spawnExplosionEffects()/
	 * stepExplosionEffects() below. Its own sprite group is already a child of `group` (added once, in
	 * buildDestructibleVisuals()), so nothing extra needs to be added to the scene. */
	readonly explosionEffects: ExplosionEffectsState;
}

function materialFor(materials: DestructibleMaterialSets, kind: DestructibleBody['material']): THREE.MeshStandardMaterial {
	switch (kind) {
		case 'concrete':
			return materials.concrete.material;
		case 'brick':
			return materials.brick.material;
		case 'wood':
			return materials.wood.material;
		case 'barrelBlue':
			return materials.barrelBlue.material;
		case 'barrelRust':
			return materials.barrelRust.material;
	}
}

function geometryFor(body: DestructibleBody): THREE.BufferGeometry {
	if (body.kind === 'barrel') {
		const r = body.radius!;
		const h = body.height!;
		const sides = body.sides!;
		const geo = new THREE.CylinderGeometry(r, r, h, sides);
		return geo;
	}
	const half = body.halfExtents!;
	return new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2, 1, body.kind === 'wallBlock' ? 1 : 1, 1);
}

/** Builds one mesh + InterpolatedTransform per dynamic destructible body, and the 2 static ramp
 * meshes (added directly to `group`, no per-frame transform needed since ramps never move). Adds
 * everything to a fresh THREE.Group (returned) that the caller adds to the scene once. */
export function buildDestructibleVisuals(world: DestructibleWorld): DestructibleVisualBundle {
	const materials = buildDestructibleMaterials();
	const group = new THREE.Group();
	group.name = 'DestructibleWorld';

	const visuals: DestructibleVisual[] = [];
	for (const body of world.bodies) {
		const geometry = geometryFor(body);
		const mesh = new THREE.Mesh(geometry, materialFor(materials, body.material));
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		const t = body.body.getTransform();
		mesh.position.set(t.position.x, t.position.y, t.position.z);
		mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
		group.add(mesh);
		const transform = new InterpolatedTransform();
		transform.sample(t.position, t.rotation);
		transform.sample(t.position, t.rotation);
		visuals.push({ mesh, transform });
	}

	for (const ramp of world.ramps) {
		group.add(buildRampMesh(ramp, materials));
	}

	const explosionEffects = createExplosionEffectsState();
	group.add(explosionEffects.group);

	return { visuals, materials, group, explosionEffects };
}

function buildRampMesh(ramp: RampBody, materials: DestructibleMaterialSets): THREE.Mesh {
	const flat = wedgeHullPoints(ramp.width, ramp.length, ramp.height);
	const points: THREE.Vector3[] = [];
	for (let i = 0; i < flat.length; i += 3) points.push(new THREE.Vector3(flat[i], flat[i + 1], flat[i + 2]));
	const geometry = new ConvexGeometry(points);
	geometry.computeVertexNormals();
	const mesh = new THREE.Mesh(geometry, materials.concrete.material);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	const t = ramp.body.getTransform();
	mesh.position.set(t.position.x, t.position.y, t.position.z);
	mesh.quaternion.set(t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w);
	return mesh;
}

/** Call once per fixed physics step (samples every dynamic body's CURRENT transform into its
 * InterpolatedTransform for render-time blending -- same pattern as main.ts's per-wheel/per-panel
 * sampling in doFixedStep()). */
export function sampleDestructibleVisuals(world: DestructibleWorld, bundle: DestructibleVisualBundle): void {
	for (let i = 0; i < world.bodies.length; i++) {
		const t = world.bodies[i].body.getTransform();
		bundle.visuals[i].transform.sample(t.position, t.rotation);
	}
}

/** Call once per render frame with the accumulator's interpolation alpha. */
export function applyDestructibleVisuals(bundle: DestructibleVisualBundle, alpha: number): void {
	for (const v of bundle.visuals) v.transform.applyTo(v.mesh, alpha);
}

/** After a teleport-reset (Shift+R, see world/bodies.ts's resetDestructibleWorld()), double-sample
 * every transform from the NEW pose so the render-time lerp doesn't visibly interpolate from the old
 * position to the new one across a single frame (same trick as main.ts's doReset()). */
export function resnapDestructibleVisuals(world: DestructibleWorld, bundle: DestructibleVisualBundle): void {
	for (let i = 0; i < world.bodies.length; i++) {
		const t = world.bodies[i].body.getTransform();
		bundle.visuals[i].transform.sample(t.position, t.rotation);
		bundle.visuals[i].transform.sample(t.position, t.rotation);
	}
}

export function disposeDestructibleVisuals(bundle: DestructibleVisualBundle): void {
	for (const v of bundle.visuals) v.mesh.geometry.dispose();
	for (const child of bundle.group.children) {
		const mesh = child as THREE.Mesh;
		if (mesh.isMesh) mesh.geometry.dispose();
	}
	disposeDestructibleMaterials(bundle.materials);
	disposeExplosionEffects(bundle.explosionEffects);
}

// -------------------------------------------------------------------------------------------------
// Exploding-barrels fireball/smoke burst (world/bodies.ts's stepExplodingBarrels() produces the
// ExplosionEvent[] this module renders). Cheap procedural sprite burst, no asset downloads -- same
// constraint/technique as materials.ts's CanvasTexture PBR maps, just non-tiling single blobs
// (materials.ts's buildFireballTexture()/buildSmokeTexture()).
//
// WIRING (renderer-free-from-main.ts note, mirrors bodies.ts's stepExplodingBarrels() doc comment):
// call spawnExplosionEffects(bundle, events) once per fixed step with stepExplodingBarrels()'s return
// value, and stepExplosionEffects(bundle, dt) once per fixed step (any order relative to the above) to
// age/animate/retire the bursts. Both only ever touch bundle.explosionEffects.group, already parented
// under bundle.group (added to the scene once, in buildDestructibleVisuals()) -- no extra scene.add.
// -------------------------------------------------------------------------------------------------

interface ActiveExplosionEffect {
	ageS: number;
	readonly fireSprites: THREE.Sprite[];
	readonly fireBaseScale: number[];
	readonly smokeSprites: THREE.Sprite[];
	readonly smokeBaseScale: number[];
	readonly smokeRiseSpeed: number[];
}

export interface ExplosionEffectsState {
	readonly group: THREE.Group;
	readonly fireMaterial: THREE.SpriteMaterial;
	readonly smokeMaterial: THREE.SpriteMaterial;
	readonly fireTexture: THREE.CanvasTexture;
	readonly smokeTexture: THREE.CanvasTexture;
	active: ActiveExplosionEffect[];
}

function createExplosionEffectsState(): ExplosionEffectsState {
	const group = new THREE.Group();
	group.name = 'ExplosionEffects';
	const fireTexture = buildFireballTexture();
	const smokeTexture = buildSmokeTexture();
	// Template materials -- every spawned sprite clones one of these (own `opacity`/`color` so bursts
	// can fade independently), never mutates the template itself.
	const fireMaterial = new THREE.SpriteMaterial({ map: fireTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true });
	const smokeMaterial = new THREE.SpriteMaterial({ map: smokeTexture, depthWrite: false, transparent: true });
	return { group, fireMaterial, smokeMaterial, fireTexture, smokeTexture, active: [] };
}

/** Spawns one fireball+smoke burst per ExplosionEvent (usually 0-1 per call; more during a fast chain
 * reaction). Call once per fixed step with stepExplodingBarrels()'s return value. */
export function spawnExplosionEffects(bundle: DestructibleVisualBundle, events: readonly ExplosionEvent[]): void {
	if (events.length === 0) return;
	const state = bundle.explosionEffects;
	for (const event of events) {
		const sizeRatio = event.radius / 6; // 6m is tuning.ts's BARREL_EXPLOSION_RADIUS_M default
		const fireSprites: THREE.Sprite[] = [];
		const fireBaseScale: number[] = [];
		for (let i = 0; i < FIREBALL_SPRITES_PER_BURST; i++) {
			const sprite = new THREE.Sprite(state.fireMaterial.clone());
			const jitterR = Math.random() * event.radius * 0.35;
			const jitterAngle = Math.random() * Math.PI * 2;
			sprite.position.set(
				event.position.x + Math.cos(jitterAngle) * jitterR,
				event.position.y + Math.random() * 1.2,
				event.position.z + Math.sin(jitterAngle) * jitterR,
			);
			const baseScale = FIREBALL_CORE_MAX_SCALE_M * sizeRatio * (0.7 + Math.random() * 0.6);
			sprite.scale.setScalar(0.01);
			state.group.add(sprite);
			fireSprites.push(sprite);
			fireBaseScale.push(baseScale);
		}
		const smokeSprites: THREE.Sprite[] = [];
		const smokeBaseScale: number[] = [];
		const smokeRiseSpeed: number[] = [];
		for (let i = 0; i < SMOKE_SPRITES_PER_BURST; i++) {
			const sprite = new THREE.Sprite(state.smokeMaterial.clone());
			const jitterR = Math.random() * event.radius * 0.5;
			const jitterAngle = Math.random() * Math.PI * 2;
			sprite.position.set(
				event.position.x + Math.cos(jitterAngle) * jitterR,
				event.position.y + Math.random() * 0.8,
				event.position.z + Math.sin(jitterAngle) * jitterR,
			);
			const baseScale = SMOKE_MAX_SCALE_M * sizeRatio * (0.6 + Math.random() * 0.7);
			sprite.scale.setScalar(0.01);
			state.group.add(sprite);
			smokeSprites.push(sprite);
			smokeBaseScale.push(baseScale);
			smokeRiseSpeed.push(1.2 + Math.random() * 1.2);
		}
		state.active.push({ ageS: 0, fireSprites, fireBaseScale, smokeSprites, smokeBaseScale, smokeRiseSpeed });
	}
}

/** Attack-then-decay envelope in [0,1]: rises to 1 over the first `attack` fraction of the effect's
 * lifetime, then falls back to 0 -- shared shape for both the fireball core and the smoke puff (their
 * different `attack`/lifetime constants give the fire its instant flash-then-gone read and the smoke
 * its slower balloon-then-drift-away read). */
function attackDecayEnvelope(tFraction: number, attack: number): number {
	if (tFraction <= 0) return 0;
	if (tFraction >= 1) return 0;
	return tFraction < attack ? tFraction / attack : 1 - (tFraction - attack) / (1 - attack);
}

/** Advances every active burst by `dt`, animating scale/opacity/(for smoke) rise, and retires bursts
 * past their lifetime (disposing their cloned per-sprite materials -- the shared map/texture is NOT
 * disposed here, only by disposeExplosionEffects() at full teardown). Call once per fixed step. */
export function stepExplosionEffects(bundle: DestructibleVisualBundle, dt: number): void {
	const state = bundle.explosionEffects;
	if (state.active.length === 0) return;
	const stillActive: ActiveExplosionEffect[] = [];
	for (const effect of state.active) {
		effect.ageS += dt;
		const fireT = effect.ageS / FIREBALL_CORE_LIFETIME_S;
		const smokeT = effect.ageS / SMOKE_LIFETIME_S;
		const fireEnvelope = attackDecayEnvelope(fireT, 0.2);
		const smokeEnvelope = attackDecayEnvelope(smokeT, 0.25);

		for (let i = 0; i < effect.fireSprites.length; i++) {
			const sprite = effect.fireSprites[i];
			sprite.scale.setScalar(Math.max(0.01, effect.fireBaseScale[i] * fireEnvelope));
			(sprite.material as THREE.SpriteMaterial).opacity = fireEnvelope;
		}
		for (let i = 0; i < effect.smokeSprites.length; i++) {
			const sprite = effect.smokeSprites[i];
			sprite.position.y += effect.smokeRiseSpeed[i] * dt;
			sprite.scale.setScalar(Math.max(0.01, effect.smokeBaseScale[i] * smokeEnvelope));
			(sprite.material as THREE.SpriteMaterial).opacity = smokeEnvelope * 0.5;
		}

		if (fireT >= 1 && smokeT >= 1) {
			for (const sprite of effect.fireSprites) {
				state.group.remove(sprite);
				(sprite.material as THREE.SpriteMaterial).dispose();
			}
			for (const sprite of effect.smokeSprites) {
				state.group.remove(sprite);
				(sprite.material as THREE.SpriteMaterial).dispose();
			}
		} else {
			stillActive.push(effect);
		}
	}
	state.active = stillActive;
}

function disposeExplosionEffects(state: ExplosionEffectsState): void {
	for (const effect of state.active) {
		for (const sprite of [...effect.fireSprites, ...effect.smokeSprites]) {
			state.group.remove(sprite);
			(sprite.material as THREE.SpriteMaterial).dispose();
		}
	}
	state.active = [];
	state.fireMaterial.dispose();
	state.smokeMaterial.dispose();
	state.fireTexture.dispose();
	state.smokeTexture.dispose();
}
