import * as THREE from 'three';

// Deterministic PRNG (mulberry32) so the generated texture is stable across
// reloads/screenshots instead of re-rolling noise every run.
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

/**
 * Procedurally generates a tileable worn-asphalt PBR texture set (albedo +
 * roughness + normal) directly on <canvas> — no external texture file, keeps
 * the whole ground material inside the render pipeline's own remit. Real
 * asphalt is dark, low-saturation gray with fine aggregate speckle, soft
 * wear/patch blotches, and faint concrete-slab expansion joints (this HDRI is
 * an old airfield runway, so joints read as "realistic", not "cartoon grid" —
 * they're subtle, irregular-spaced, dark hairlines, not bright checker lines).
 */
export function buildAsphaltTextures(size = 1024, seed = 20260708) {
  const rand = mulberry32(seed);

  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = albedoCanvas.height = size;
  const actx = albedoCanvas.getContext('2d')!;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = roughCanvas.height = size;
  const rctx = roughCanvas.getContext('2d')!;

  // Base asphalt gray (linear-ish mid-dark, tuned so it reads correctly once
  // the loader tags it sRGB and the renderer converts to linear).
  const baseR = 54, baseG = 52, baseB = 50;
  actx.fillStyle = `rgb(${baseR},${baseG},${baseB})`;
  actx.fillRect(0, 0, size, size);

  const albedoImg = actx.getImageData(0, 0, size, size);
  const roughImg = rctx.createImageData(size, size);
  // Height buffer (grayscale) used both to darken/lighten albedo speckle and
  // to derive the normal map via a Sobel gradient — keeps the two correlated
  // the way real aggregate bump-and-tint would be.
  const height = new Float32Array(size * size);

  // Fine speckle (aggregate grain) — several octaves of blocky value noise,
  // cheap and looks correct at this scale (no need for true Perlin/Simplex).
  function addOctave(cellSize: number, amp: number) {
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
        const v = vx0 + (vx1 - vx0) * fy;
        height[y * size + x] += v * amp;
      }
    }
  }
  addOctave(6, 0.14); // fine aggregate speckle (subtle — real asphalt reads
  addOctave(24, 0.16); // smooth at a few meters away, not sandpaper-grainy)
  addOctave(96, 0.4); // broad wear/staining blotches (dominant macro variation)
  addOctave(320, 0.3); // very broad tonal drift (patch repairs / dirt gradients)

  // Normalize height to ~[-1,1]
  let hMin = Infinity, hMax = -Infinity;
  for (let i = 0; i < height.length; i++) { if (height[i] < hMin) hMin = height[i]; if (height[i] > hMax) hMax = height[i]; }
  const hRange = hMax - hMin || 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const h = ((height[idx] - hMin) / hRange) * 2 - 1; // [-1,1]
      const tint = h * 16; // albedo variation amplitude
      const p = idx * 4;
      albedoImg.data[p] = clamp8(baseR + tint);
      albedoImg.data[p + 1] = clamp8(baseG + tint);
      albedoImg.data[p + 2] = clamp8(baseB + tint);
      albedoImg.data[p + 3] = 255;

      // Rougher in the darker (unworn) areas, slightly smoother/polished in
      // lighter worn/tire-track areas.
      const roughness = clamp8(230 - h * 40);
      roughImg.data[p] = roughness;
      roughImg.data[p + 1] = roughness;
      roughImg.data[p + 2] = roughness;
      roughImg.data[p + 3] = 255;
    }
  }

  // Faint concrete expansion joints at the tile border (continuous grid once
  // RepeatWrapping tiles this texture across the ground plane).
  const jointDarken = 26;
  const jointWidth = 2;
  for (let y = 0; y < size; y++) {
    for (let k = 0; k < jointWidth; k++) {
      for (const x of [k, size - 1 - k]) {
        const p = (y * size + x) * 4;
        albedoImg.data[p] = clamp8(albedoImg.data[p] - jointDarken);
        albedoImg.data[p + 1] = clamp8(albedoImg.data[p + 1] - jointDarken);
        albedoImg.data[p + 2] = clamp8(albedoImg.data[p + 2] - jointDarken);
      }
    }
  }
  for (let x = 0; x < size; x++) {
    for (let k = 0; k < jointWidth; k++) {
      for (const y of [k, size - 1 - k]) {
        const p = (y * size + x) * 4;
        albedoImg.data[p] = clamp8(albedoImg.data[p] - jointDarken);
        albedoImg.data[p + 1] = clamp8(albedoImg.data[p + 1] - jointDarken);
        albedoImg.data[p + 2] = clamp8(albedoImg.data[p + 2] - jointDarken);
      }
    }
  }

  actx.putImageData(albedoImg, 0, 0);
  rctx.putImageData(roughImg, 0, 0);

  // Normal map via Sobel gradient of the height buffer.
  const normalCanvas = document.createElement('canvas');
  normalCanvas.width = normalCanvas.height = size;
  const nctx = normalCanvas.getContext('2d')!;
  const normalImg = nctx.createImageData(size, size);
  const strength = 1.4;
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const n = new THREE.Vector3(-dx, -dy, 1).normalize();
      const p = (y * size + x) * 4;
      normalImg.data[p] = clamp8((n.x * 0.5 + 0.5) * 255);
      normalImg.data[p + 1] = clamp8((n.y * 0.5 + 0.5) * 255);
      normalImg.data[p + 2] = clamp8((n.z * 0.5 + 0.5) * 255);
      normalImg.data[p + 3] = 255;
    }
  }
  nctx.putImageData(normalImg, 0, 0);

  const map = new THREE.CanvasTexture(albedoCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.colorSpace = THREE.NoColorSpace;
  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.colorSpace = THREE.NoColorSpace;

  for (const tex of [map, roughnessMap, normalMap]) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
  }

  return { map, roughnessMap, normalMap };
}
