// SPDX-License-Identifier: MIT
//
// Procedural PBR materials for the destructible world (G4 spec): concrete, brick, wood-crate, and
// two rusted-steel barrel variants -- all hand-rolled CanvasTexture albedo/roughness maps (no texture
// downloads, per the spec's "no new runtime deps" constraint), same technique as
// game/src/scene/proceduralAsphalt.ts (deterministic mulberry32 value-noise octaves), reused here
// rather than duplicated blindly: this module's own small noise helper mirrors that file's algorithm.

import * as THREE from 'three';

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

/** Deterministic tileable octave value-noise field in [-1,1], same algorithm as
 * proceduralAsphalt.ts's addOctave() -- factored here as a small reusable helper since this module
 * builds several distinct noise-based materials. */
function buildNoiseField(size: number, seed: number, octaves: readonly { cellSize: number; amp: number }[]): Float32Array {
	const rand = mulberry32(seed);
	const height = new Float32Array(size * size);
	for (const { cellSize, amp } of octaves) {
		const cols = Math.ceil(size / cellSize) + 2;
		const rows = cols;
		const grid = new Float32Array(cols * rows);
		for (let i = 0; i < grid.length; i++) grid[i] = rand() * 2 - 1;
		for (let y = 0; y < size; y++) {
			const gy = y / cellSize;
			const gy0 = Math.floor(gy);
			const fy = gy - gy0;
			for (let x = 0; x < size; x++) {
				const gx = x / cellSize;
				const gx0 = Math.floor(gx);
				const fx = gx - gx0;
				const v00 = grid[gy0 * cols + gx0];
				const v10 = grid[gy0 * cols + gx0 + 1];
				const v01 = grid[(gy0 + 1) * cols + gx0];
				const v11 = grid[(gy0 + 1) * cols + gx0 + 1];
				const vx0 = v00 + (v10 - v00) * fx;
				const vx1 = v01 + (v11 - v01) * fx;
				height[y * size + x] += (vx0 + (vx1 - vx0) * fy) * amp;
			}
		}
	}
	let hMin = Infinity;
	let hMax = -Infinity;
	for (let i = 0; i < height.length; i++) {
		if (height[i] < hMin) hMin = height[i];
		if (height[i] > hMax) hMax = height[i];
	}
	const range = hMax - hMin || 1;
	for (let i = 0; i < height.length; i++) height[i] = ((height[i] - hMin) / range) * 2 - 1;
	return height;
}

interface RGB {
	r: number;
	g: number;
	b: number;
}

function makeCanvasTexture(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; img: ImageData } {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	const img = ctx.createImageData(size, size);
	return { canvas, ctx, img };
}

function finishTexture(canvas: HTMLCanvasElement, colorSpace: THREE.ColorSpace, repeat: number): THREE.CanvasTexture {
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = colorSpace;
	tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
	tex.repeat.set(repeat, repeat);
	tex.anisotropy = 8;
	tex.needsUpdate = true;
	return tex;
}

export interface ProceduralMaterialSet {
	map: THREE.CanvasTexture;
	roughnessMap: THREE.CanvasTexture;
	material: THREE.MeshStandardMaterial;
}

function buildFromNoise(
	size: number,
	seed: number,
	base: RGB,
	tintAmp: number,
	roughBase: number,
	roughAmp: number,
	repeat: number,
	extraPaint?: (albedo: ImageData, rough: ImageData, size: number) => void,
): { map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture } {
	const height = buildNoiseField(size, seed, [
		{ cellSize: 5, amp: 0.12 },
		{ cellSize: 20, amp: 0.22 },
		{ cellSize: 70, amp: 0.4 },
	]);
	const { canvas: albedoCanvas, ctx: actx, img: albedoImg } = makeCanvasTexture(size);
	const { canvas: roughCanvas, ctx: rctx, img: roughImg } = makeCanvasTexture(size);

	for (let i = 0; i < size * size; i++) {
		const h = height[i];
		const p = i * 4;
		albedoImg.data[p] = clamp8(base.r + h * tintAmp);
		albedoImg.data[p + 1] = clamp8(base.g + h * tintAmp);
		albedoImg.data[p + 2] = clamp8(base.b + h * tintAmp);
		albedoImg.data[p + 3] = 255;
		const rough = clamp8(roughBase + h * roughAmp);
		roughImg.data[p] = rough;
		roughImg.data[p + 1] = rough;
		roughImg.data[p + 2] = rough;
		roughImg.data[p + 3] = 255;
	}

	extraPaint?.(albedoImg, roughImg, size);

	actx.putImageData(albedoImg, 0, 0);
	rctx.putImageData(roughImg, 0, 0);

	return {
		map: finishTexture(albedoCanvas, THREE.SRGBColorSpace, repeat),
		roughnessMap: finishTexture(roughCanvas, THREE.NoColorSpace, repeat),
	};
}

/** Concrete: light-medium neutral gray, fine aggregate speckle + broad weathering blotches. */
export function buildConcreteMaterial(size = 512): ProceduralMaterialSet {
	const { map, roughnessMap } = buildFromNoise(size, 71, { r: 150, g: 148, b: 142 }, 22, 205, 30, 2);
	const material = new THREE.MeshStandardMaterial({ map, roughnessMap, metalness: 0.0 });
	return { map, roughnessMap, material };
}

/** Brick-red: base terracotta tone + noise, with dark mortar joint gridlines painted on top. */
export function buildBrickMaterial(size = 512): ProceduralMaterialSet {
	const brickW = size / 8;
	const brickH = size / 16;
	const { map, roughnessMap } = buildFromNoise(size, 133, { r: 140, g: 62, b: 46 }, 26, 210, 24, 2, (albedo, rough) => {
		for (let y = 0; y < size; y++) {
			const row = Math.floor(y / brickH);
			const onJointY = y % brickH < 2;
			for (let x = 0; x < size; x++) {
				const offset = (row % 2) * (brickW / 2);
				const onJointX = Math.floor((x + offset) % brickW) < 2;
				if (onJointY || onJointX) {
					const p = (y * size + x) * 4;
					albedo.data[p] = 168;
					albedo.data[p + 1] = 162;
					albedo.data[p + 2] = 150;
					rough.data[p] = rough.data[p + 1] = rough.data[p + 2] = 235;
				}
			}
		}
	});
	const material = new THREE.MeshStandardMaterial({ map, roughnessMap, metalness: 0.0 });
	return { map, roughnessMap, material };
}

/** Wood crate: tan/brown plank grain with dark inter-plank gap lines. */
export function buildWoodMaterial(size = 512): ProceduralMaterialSet {
	const plankW = size / 4;
	const { map, roughnessMap } = buildFromNoise(size, 251, { r: 150, g: 108, b: 62 }, 20, 175, 35, 1, (albedo, rough) => {
		// Horizontal grain streaks.
		const rand = mulberry32(999);
		for (let i = 0; i < 900; i++) {
			const y = Math.floor(rand() * size);
			const xStart = Math.floor(rand() * size);
			const len = 20 + Math.floor(rand() * 80);
			const dark = rand() > 0.5;
			for (let dx = 0; dx < len; dx++) {
				const x = (xStart + dx) % size;
				const p = (y * size + x) * 4;
				const delta = dark ? -14 : 10;
				albedo.data[p] = clamp8(albedo.data[p] + delta);
				albedo.data[p + 1] = clamp8(albedo.data[p + 1] + delta);
				albedo.data[p + 2] = clamp8(albedo.data[p + 2] + delta * 0.6);
			}
		}
		// Plank gap lines (vertical).
		for (let x = 0; x < size; x++) {
			if (Math.floor(x % plankW) < 2) {
				for (let y = 0; y < size; y++) {
					const p = (y * size + x) * 4;
					albedo.data[p] = clamp8(albedo.data[p] - 45);
					albedo.data[p + 1] = clamp8(albedo.data[p + 1] - 45);
					albedo.data[p + 2] = clamp8(albedo.data[p + 2] - 45);
					rough.data[p] = rough.data[p + 1] = rough.data[p + 2] = 250;
				}
			}
		}
	});
	const material = new THREE.MeshStandardMaterial({ map, roughnessMap, metalness: 0.0 });
	return { map, roughnessMap, material };
}

/** Rusted-steel barrel, in two variants (mostly-blue-paint vs. mostly-rusted): a metal base with
 * blotchy vertical rust-streak overlays (real weathered-drum look, not a flat color). */
export function buildBarrelMaterial(variant: 'blue' | 'rust', size = 512): ProceduralMaterialSet {
	const base: RGB = variant === 'blue' ? { r: 58, g: 84, b: 118 } : { r: 120, g: 66, b: 40 };
	const seed = variant === 'blue' ? 407 : 409;
	const rustAmount = variant === 'blue' ? 0.22 : 0.75;
	const { map, roughnessMap } = buildFromNoise(size, seed, base, 18, 140, 60, 1, (albedo, rough) => {
		const rand = mulberry32(seed + 1);
		const streaks = Math.floor(30 * rustAmount) + 6;
		for (let i = 0; i < streaks; i++) {
			const x0 = Math.floor(rand() * size);
			const width = 6 + Math.floor(rand() * 18);
			const yStart = Math.floor(rand() * size * 0.4);
			const len = size * (0.3 + rand() * 0.6);
			for (let y = yStart; y < Math.min(size, yStart + len); y++) {
				const spread = Math.floor(Math.sin(((y - yStart) / len) * Math.PI) * width);
				for (let dx = -spread; dx < spread; dx++) {
					const x = (((x0 + dx) % size) + size) % size;
					const p = (y * size + x) * 4;
					const rustR = 120,
						rustG = 58,
						rustB = 28;
					const t = 0.55;
					albedo.data[p] = clamp8(albedo.data[p] * (1 - t) + rustR * t);
					albedo.data[p + 1] = clamp8(albedo.data[p + 1] * (1 - t) + rustG * t);
					albedo.data[p + 2] = clamp8(albedo.data[p + 2] * (1 - t) + rustB * t);
					rough.data[p] = rough.data[p + 1] = rough.data[p + 2] = clamp8(rough.data[p] + 60);
				}
			}
		}
		// A couple of horizontal chime/rib bands, like a real drum.
		for (const bandY of [size * 0.12, size * 0.5, size * 0.88]) {
			const y0 = Math.floor(bandY);
			for (let y = y0; y < Math.min(size, y0 + Math.max(2, size / 128)); y++) {
				for (let x = 0; x < size; x++) {
					const p = (y * size + x) * 4;
					albedo.data[p] = clamp8(albedo.data[p] * 0.7);
					albedo.data[p + 1] = clamp8(albedo.data[p + 1] * 0.7);
					albedo.data[p + 2] = clamp8(albedo.data[p + 2] * 0.7);
				}
			}
		}
	});
	const material = new THREE.MeshStandardMaterial({ map, roughnessMap, metalness: 0.75 });
	return { map, roughnessMap, material };
}

export interface DestructibleMaterialSets {
	concrete: ProceduralMaterialSet;
	brick: ProceduralMaterialSet;
	wood: ProceduralMaterialSet;
	barrelBlue: ProceduralMaterialSet;
	barrelRust: ProceduralMaterialSet;
}

export function buildDestructibleMaterials(): DestructibleMaterialSets {
	return {
		concrete: buildConcreteMaterial(),
		brick: buildBrickMaterial(),
		wood: buildWoodMaterial(),
		barrelBlue: buildBarrelMaterial('blue'),
		barrelRust: buildBarrelMaterial('rust'),
	};
}

export function disposeDestructibleMaterials(sets: DestructibleMaterialSets): void {
	for (const set of Object.values(sets)) {
		set.map.dispose();
		set.roughnessMap.dispose();
		set.material.dispose();
	}
}

// -------------------------------------------------------------------------------------------------
// Exploding-barrels fireball/smoke sprite textures (world/visuals.ts's spawnExplosionEffects()) -- two
// small (128px, not the 512px tiled PBR maps above -- these are single soft blobs, not repeated
// materials) radial-gradient CanvasTextures, same "no runtime asset downloads" constraint as the rest
// of this module. NOT built through buildFromNoise()/finishTexture() above: those assume a REPEATING
// tiled material (RepeatWrapping, `repeat` factor), which is wrong for a single soft sprite blob
// (needs ClampToEdgeWrapping, repeat=1) -- so these get their own small, non-tiling helper.
// -------------------------------------------------------------------------------------------------

function makeSpriteTexture(size: number, paint: (ctx: CanvasRenderingContext2D, size: number) => void): THREE.CanvasTexture {
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = size;
	const ctx = canvas.getContext('2d')!;
	paint(ctx, size);
	const tex = new THREE.CanvasTexture(canvas);
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.needsUpdate = true;
	return tex;
}

/** Soft yellow-white core -> orange -> transparent -- a single billboard blob (world/visuals.ts
 * layers several, jittered, with THREE.AdditiveBlending for the "many overlapping licks of flame"
 * look, same cheap technique as most sprite-based fire VFX). */
export function buildFireballTexture(size = 128): THREE.CanvasTexture {
	return makeSpriteTexture(size, (ctx) => {
		const r = size / 2;
		const gradient = ctx.createRadialGradient(r, r, 0, r, r, r);
		gradient.addColorStop(0, 'rgba(255,246,214,1.0)');
		gradient.addColorStop(0.25, 'rgba(255,214,120,0.95)');
		gradient.addColorStop(0.55, 'rgba(255,120,40,0.65)');
		gradient.addColorStop(0.8, 'rgba(200,50,20,0.25)');
		gradient.addColorStop(1, 'rgba(120,20,10,0)');
		ctx.fillStyle = gradient;
		ctx.fillRect(0, 0, size, size);
	});
}

/** Soft gray puff with mulberry32-perturbed edge (a perfectly round gradient reads as a cheap glow, not
 * smoke -- the noisy alpha edge breaks the circular silhouette enough to sell "billowing"). */
export function buildSmokeTexture(size = 128): THREE.CanvasTexture {
	return makeSpriteTexture(size, (ctx) => {
		const r = size / 2;
		const rand = mulberry32(881);
		const img = ctx.createImageData(size, size);
		for (let y = 0; y < size; y++) {
			for (let x = 0; x < size; x++) {
				const dx = (x - r) / r;
				const dy = (y - r) / r;
				const dist = Math.hypot(dx, dy);
				const wobble = 1 + (rand() - 0.5) * 0.35;
				const falloff = Math.max(0, 1 - dist * wobble);
				const alpha = Math.pow(falloff, 1.6) * 0.85;
				const p = (y * size + x) * 4;
				const gray = 60 + Math.floor(rand() * 25);
				img.data[p] = gray;
				img.data[p + 1] = gray;
				img.data[p + 2] = gray;
				img.data[p + 3] = clamp8(alpha * 255);
			}
		}
		ctx.putImageData(img, 0, 0);
	});
}
