// SPDX-License-Identifier: MIT
//
// Procedural materials for the 39 cardetail components -- a small hand-rolled palette (flat
// MeshStandardMaterial per matKey) plus 2 CanvasTexture-noise exceptions (engine block dark metal,
// radiator finned texture) matching the "engine block dark metal, radiator finned texture via
// CanvasTexture, hoses black rubber, turbo metallic" brief. Same deterministic mulberry32 value-noise
// technique as game/src/world/materials.ts, but NOT imported from there (this feature folder is
// self-contained per the WorldFeature contract) -- a small local copy instead.
//
// DOM GUARD: game/src/world/materials.ts's CanvasTexture path calls document.createElement('canvas'),
// which throws in the headless sim-test environment (game/sim's vitest config runs `environment:
// 'node'`, no DOM/document -- see feature.ts's contract note that a feature module must be directly
// importable by a headless sim test). Both canvas-based builders below fall back to an equivalent
// flat-color material when `document` is unavailable, so this module (and the whole cardetail
// feature) works in both the browser and game/sim/features-cardetail.test.mjs.

import * as THREE from 'three';

function hasDom(): boolean {
	return typeof document !== 'undefined';
}

function mulberry32(seed: number) {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function clamp8(v: number): number {
	return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

/** Dark gunmetal cast-aluminum block with fine speckle noise (guarded; flat color if no DOM). */
function buildEngineMetalMaterial(): THREE.MeshStandardMaterial {
	const base = { r: 58, g: 60, b: 63 };
	if (!hasDom()) return new THREE.MeshStandardMaterial({ color: (base.r << 16) | (base.g << 8) | base.b, metalness: 0.7, roughness: 0.5 });
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(size, size);
	const rand = mulberry32(4242);
	for (let i = 0; i < size * size; i++) {
		const n = (rand() - 0.5) * 26;
		const p = i * 4;
		img.data[p] = clamp8(base.r + n);
		img.data[p + 1] = clamp8(base.g + n);
		img.data[p + 2] = clamp8(base.b + n);
		img.data[p + 3] = 255;
	}
	ctx.putImageData(img, 0, 0);
	const map = new THREE.CanvasTexture(canvas);
	map.colorSpace = THREE.SRGBColorSpace;
	map.needsUpdate = true;
	return new THREE.MeshStandardMaterial({ map, metalness: 0.7, roughness: 0.5 });
}

/** Aluminum radiator core with horizontal fin stripes (guarded; flat color if no DOM). */
function buildRadiatorMaterial(): THREE.MeshStandardMaterial {
	const base = { r: 184, g: 190, b: 194 };
	if (!hasDom()) return new THREE.MeshStandardMaterial({ color: (base.r << 16) | (base.g << 8) | base.b, metalness: 0.8, roughness: 0.35 });
	const size = 128;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(size, size);
	for (let y = 0; y < size; y++) {
		const onFin = y % 6 < 2;
		for (let x = 0; x < size; x++) {
			const p = (y * size + x) * 4;
			const shade = onFin ? 0.62 : 1.0;
			img.data[p] = clamp8(base.r * shade);
			img.data[p + 1] = clamp8(base.g * shade);
			img.data[p + 2] = clamp8(base.b * shade);
			img.data[p + 3] = 255;
		}
	}
	ctx.putImageData(img, 0, 0);
	const map = new THREE.CanvasTexture(canvas);
	map.colorSpace = THREE.SRGBColorSpace;
	map.wrapS = map.wrapT = THREE.RepeatWrapping;
	map.repeat.set(1, 6);
	map.needsUpdate = true;
	return new THREE.MeshStandardMaterial({ map, metalness: 0.8, roughness: 0.35 });
}

interface FlatEntry {
	color: number;
	metalness: number;
	roughness: number;
	transparent?: boolean;
	opacity?: number;
}

const FLAT_PALETTE: Record<string, FlatEntry> = {
	castAluminum: { color: 0x9aa0a6, metalness: 0.8, roughness: 0.35 },
	castIronHot: { color: 0x53524f, metalness: 0.6, roughness: 0.55 },
	plasticBlackMatte: { color: 0x1c1c1e, metalness: 0.0, roughness: 0.85 },
	plasticBlackGloss: { color: 0x151516, metalness: 0.0, roughness: 0.25 },
	rubberBlack: { color: 0x0d0d0d, metalness: 0.0, roughness: 0.95 },
	steelMattePowder: { color: 0x2b2b2d, metalness: 0.3, roughness: 0.7 },
	steelBrushed: { color: 0xb0b0ae, metalness: 0.9, roughness: 0.3 },
	stainlessBrushed: { color: 0xb7b7ad, metalness: 0.85, roughness: 0.4 },
	clothBlack: { color: 0x1a1a1a, metalness: 0.0, roughness: 0.85 },
	plasticTranslucentWhite: { color: 0xe8e8e0, metalness: 0.0, roughness: 0.2, transparent: true, opacity: 0.6 },
	lensClear: { color: 0xdfe9f0, metalness: 0.0, roughness: 0.1, transparent: true, opacity: 0.55 },
	lensRed: { color: 0x7a1010, metalness: 0.0, roughness: 0.2, transparent: true, opacity: 0.65 },
	paintGeneric: { color: 0x555555, metalness: 0.4, roughness: 0.4 },
};

export type CarDetailMaterials = Record<string, THREE.MeshStandardMaterial>;

/** Builds one material instance per matKey referenced by tuning.ts's CAR_DETAIL_SPECS. Flat-color
 * palette entries are cheap plain MeshStandardMaterials (no textures, negligible VRAM); the 2 noise
 * exceptions build a small CanvasTexture (guarded, see this file's top doc comment). */
export function buildCarDetailMaterials(): CarDetailMaterials {
	const materials: CarDetailMaterials = {};
	for (const [key, entry] of Object.entries(FLAT_PALETTE)) {
		materials[key] = new THREE.MeshStandardMaterial({
			color: entry.color,
			metalness: entry.metalness,
			roughness: entry.roughness,
			transparent: entry.transparent ?? false,
			opacity: entry.opacity ?? 1,
		});
	}
	materials.engineMetal = buildEngineMetalMaterial();
	materials.radiatorFin = buildRadiatorMaterial();
	return materials;
}

export function disposeCarDetailMaterials(materials: CarDetailMaterials): void {
	for (const mat of Object.values(materials)) {
		mat.map?.dispose();
		mat.dispose();
	}
}
