// SPDX-License-Identifier: MIT
//
// CRASH-TEST-DUMMY visual reskin helpers for occupant ragdolls (visuals.ts). Two things live here:
//   1. The Hybrid-III-style tan/amber body palette, with a subtle deterministic per-seat tint on the
//      torso only (so the 4 seats stay distinguishable in telemetry screenshots without the old bright
//      blue/red/green/amber shirts).
//   2. A shared, procedurally-generated calibration-disk texture (the signature 4-quadrant black/yellow
//      instrumentation marking real Hybrid-III dummies wear on the head/chest/knees) plus small disk
//      meshes attached as CHILDREN of a part's mesh, in that part's own local frame, so they ride the
//      ragdoll's capsule through every joint/tumble/ejection exactly like the part mesh itself.
//
// No external image assets (texture is a THREE.CanvasTexture drawn with Canvas2D arcs). No
// Math.random()/Date.now() anywhere -- the per-seat tint is derived from a tiny FNV-1a + xorshift-style
// hash, the same pattern game/src/damage/crumple.ts's hash32/stringSeed use (duplicated locally, in
// miniature, rather than imported, so this feature doesn't reach into the damage module for it).
//
// VISUALS ONLY: nothing here touches physics, joints, seat anchors, masses, or the FSM.

import * as THREE from 'three';
import type { PartBase, SeatKey } from './tuning';

// ---------------------------------------------------------------------------------------------
// Deterministic hash (see damage/crumple.ts's hash32/stringSeed for the identical pattern).
// ---------------------------------------------------------------------------------------------

function hash32(n: number): number {
	let x = n | 0;
	x = (x ^ 61) ^ (x >>> 16);
	x = (x + (x << 3)) | 0;
	x = x ^ (x >>> 4);
	x = Math.imul(x, 0x27d4eb2d);
	x = x ^ (x >>> 15);
	return x >>> 0;
}

function stringSeed(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Dummy color palette -- uniform tan/amber Hybrid-III body, dark shoes/boots at the shins. Replaces
// the old SKIN_COLOR (head-only tan) / SHIRT_COLOR_SEED (bright per-seat shirts) / PANTS_COLOR split.
// ---------------------------------------------------------------------------------------------

const DUMMY_HEAD_COLOR = 0xc8a050; // tan/amber head (also stands in for hands, since there's no
// separate hand part -- forearm's endpoint reads as the wrist/hand region already).
const DUMMY_LIMB_COLOR = 0xb8894c; // slightly darker tan -- pelvis/arms/thighs
const DUMMY_TORSO_BASE = 0xc9803c; // orange-tan torso base, tinted per seat below
const DUMMY_SHOE_COLOR = 0x2a2a30; // dark shoes/boots -- shins only (feet/shoes "can go dark" per spec)

/** Subtle deterministic +-~5% per-channel tint of the torso base color, keyed by seat. Kept small
 * enough that all 4 seats still read as the same uniform dummy tan, but distinct enough to tell seats
 * apart in a telemetry screenshot (this is the ONLY per-seat visual variation left; every other part
 * is identical across seats). */
export function torsoColorFor(seatKey: SeatKey): number {
	const seed = stringSeed(seatKey);
	const r = (DUMMY_TORSO_BASE >> 16) & 0xff;
	const g = (DUMMY_TORSO_BASE >> 8) & 0xff;
	const b = DUMMY_TORSO_BASE & 0xff;
	const clamp = (v: number) => Math.max(0, Math.min(255, v));
	// 3 independent hashed deltas in [-14, +14] (~5% of 255), one per channel, each re-hashed off a
	// different odd multiplier so the 3 channels don't move in lockstep.
	const delta = (channel: number) => (hash32(seed ^ Math.imul(channel + 1, 0x1000193)) % 29) - 14;
	return (clamp(r + delta(0)) << 16) | (clamp(g + delta(1)) << 8) | clamp(b + delta(2));
}

/** Color for a given base part + seat, per the dummy palette above. */
export function colorForBase(base: PartBase, seatKey: SeatKey): number {
	if (base === 'head') return DUMMY_HEAD_COLOR;
	if (base === 'torso') return torsoColorFor(seatKey);
	if (base === 'shin') return DUMMY_SHOE_COLOR;
	return DUMMY_LIMB_COLOR; // pelvis, upperArm, forearm, thigh
}

// ---------------------------------------------------------------------------------------------
// Calibration disk: ONE shared procedural texture + material + per-radius geometry cache, reused by
// every disk on every occupant (built once, lazily, on first use).
// ---------------------------------------------------------------------------------------------

let sharedDiskTexture: THREE.CanvasTexture | null = null;

/** Draws the 4-quadrant alternating black/yellow calibration-disk texture once on a 128px canvas
 * (crisp, procedural, no external image asset) and caches it. */
export function getCalibrationDiskTexture(): THREE.CanvasTexture {
	if (sharedDiskTexture) return sharedDiskTexture;
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	const cx = size / 2;
	const cy = size / 2;
	const r = size / 2 - 2; // tiny margin so the circle's own edge stays inside the canvas bounds
	const QUADRANT_COLORS = ['#000000', '#f2c200', '#000000', '#f2c200'];
	for (let i = 0; i < 4; i++) {
		ctx.beginPath();
		ctx.moveTo(cx, cy);
		ctx.arc(cx, cy, r, (i * Math.PI) / 2, ((i + 1) * Math.PI) / 2);
		ctx.closePath();
		ctx.fillStyle = QUADRANT_COLORS[i];
		ctx.fill();
	}
	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.generateMipmaps = false;
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	sharedDiskTexture = texture;
	return texture;
}

let sharedDiskMaterial: THREE.MeshStandardMaterial | null = null;

function getCalibrationDiskMaterial(): THREE.MeshStandardMaterial {
	if (!sharedDiskMaterial) {
		sharedDiskMaterial = new THREE.MeshStandardMaterial({
			map: getCalibrationDiskTexture(),
			roughness: 0.4,
			metalness: 0.1,
			alphaTest: 0.5, // crisp cutout of the drawn circle out of the texture's square, no blend-sort cost
			side: THREE.DoubleSide,
		});
	}
	return sharedDiskMaterial;
}

const sharedDiskGeometryCache = new Map<number, THREE.CircleGeometry>();

function getDiskGeometry(radius: number): THREE.CircleGeometry {
	let geo = sharedDiskGeometryCache.get(radius);
	if (!geo) {
		geo = new THREE.CircleGeometry(radius, 20);
		sharedDiskGeometryCache.set(radius, geo);
	}
	return geo;
}

function makeDisk(radius: number): THREE.Mesh {
	const mesh = new THREE.Mesh(getDiskGeometry(radius), getCalibrationDiskMaterial());
	mesh.castShadow = false;
	mesh.receiveShadow = false;
	return mesh;
}

/**
 * Attaches this part's calibration disk(s) (if any) as children of `mesh`, positioned in the part's
 * own LOCAL frame -- as children of the part mesh, they inherit its transform every frame for free
 * (visuals.ts's applyOccupantVisual only ever touches the parent part mesh), so they ride the capsule
 * correctly through seated jostle, tumbling, and ejection with no extra per-frame work.
 *
 * Placement reasoning (all three targeted parts -- head/torso/shin -- have REST_OFFSET === IDENTITY
 * per tuning.ts, so each one's own local frame already lines up with the chassis frame at rest: local
 * X = chassis-lateral, local Z = chassis-forward (+Z). A CircleGeometry's default face normal is
 * local +Z, i.e. already "forward" with zero extra rotation for the torso/shin disks):
 *   - head: two disks, one per side, at local +-X (mirrors real Hybrid-III temple sensors); each
 *     needs a +-90deg yaw so its normal (default +Z) points outward along +-X instead.
 *   - torso: one disk, chest-height (a bit above center, below the neck attach), facing local +Z
 *     (forward) -- no extra rotation.
 *   - shin: one disk per shin (so both knees get one), at the shin's TOP end (shinKnee ATTACH point,
 *     tuning.ts) since the shin (not the thigh) keeps an unrotated local frame -- forward is already
 *     local +Z here too. (The thigh's REST_OFFSET bakes a 90deg seated hip bend into ITS local frame,
 *     which would need a compensating rotation; mounting on the shin's knee-end avoids that entirely
 *     and lands in the same physical spot.)
 */
export function attachCalibrationDisks(mesh: THREE.Mesh, base: PartBase, dims: { radius: number; halfLen: number }): void {
	// Headless/renderer-free sim tests (sim/*.test.mjs) build real occupant visuals (buildOccupantVisual
	// is called unconditionally by index.ts's seatAll()) in plain Node, with no DOM -- the calibration
	// disk texture needs `document.createElement('canvas')`, so skip the (purely cosmetic) disks there
	// rather than throwing. The capsule/sphere part meshes above this call don't need a DOM at all
	// (THREE geometry/material construction is DOM-free), so only this decal step needs the guard.
	if (typeof document === 'undefined') return;
	if (base === 'head') {
		const r = dims.radius * 0.42;
		const eps = dims.radius * 0.06;
		for (const sign of [1, -1] as const) {
			const disk = makeDisk(r);
			disk.position.set(sign * (dims.radius + eps), 0, 0);
			disk.rotation.y = sign * (Math.PI / 2);
			mesh.add(disk);
		}
		return;
	}
	if (base === 'torso') {
		const r = dims.radius * 0.36;
		const eps = dims.radius * 0.06;
		const disk = makeDisk(r);
		disk.position.set(0, dims.halfLen * 0.35, dims.radius + eps);
		mesh.add(disk);
		return;
	}
	if (base === 'shin') {
		const r = dims.radius * 0.55;
		const eps = dims.radius * 0.08;
		const disk = makeDisk(r);
		disk.position.set(0, dims.halfLen - r * 0.6, dims.radius + eps);
		mesh.add(disk);
		return;
	}
}
