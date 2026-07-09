// SPDX-License-Identifier: MIT
//
// The GAME's visual ground mesh, generated from the SAME terrain height data the physics height-field
// body uses (./heightfield.ts's terrainHeight()) so the rendered surface and the collision surface are
// identical by construction. Three real Poly Haven CC0 2k PBR sets are blended per-zone in a single
// MeshStandardMaterial (onBeforeCompile splat): muddy_tracks (dirt road), sparse_grass (meadow),
// forest_floor (forest). The flat asphalt apron is drawn by a separate pad mesh (scene/ground.ts), so
// it is not one of the blended zones here.
//
// Anti-tiling: each zone samples at a different world-space tile scale, plus a low-frequency macro
// tint modulates albedo so the repeat does not read as a grid at driving distance. Normal maps are
// blended in tangent space and applied via a derivative TBN (no per-vertex tangents needed).

import * as THREE from 'three';
import {
  TERRAIN_SPAN_M,
  TERRAIN_HALF_M,
  terrainHeight,
  terrainBlendWeights,
} from './heightfield';

export interface TerrainMeshBundle {
  mesh: THREE.Mesh;
  dispose(): void;
}

const TEX_BASE = 'assets/terrain';

function loadSet(loader: THREE.TextureLoader, dir: string, name: string, anisotropy: number) {
  const diff = loader.load(`${TEX_BASE}/${dir}/${name}_diff_2k.jpg`);
  const nor = loader.load(`${TEX_BASE}/${dir}/${name}_nor_gl_2k.jpg`);
  diff.colorSpace = THREE.SRGBColorSpace;
  nor.colorSpace = THREE.NoColorSpace;
  for (const t of [diff, nor]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
  }
  return { diff, nor };
}

/**
 * Builds the terrain mesh. `segments` is the visual tessellation per axis (physics uses its own finer
 * grid; both sample terrainHeight() so the surfaces coincide -- the normal maps carry the sub-vertex
 * relief the visual grid can't). Returns a mesh centred on the world origin, +Y up.
 */
export function buildTerrainMesh(anisotropy = 8, segments = 256): TerrainMeshBundle {
  const loader = new THREE.TextureLoader();
  const grass = loadSet(loader, 'sparse_grass', 'sparse_grass', anisotropy);
  const dirt = loadSet(loader, 'muddy_tracks', 'muddy_tracks', anisotropy);
  const forest = loadSet(loader, 'forest_floor', 'forest_floor', anisotropy);

  // ---- Geometry: a world-aligned grid (x, terrainHeight, z), no rotation, so local == world XZ. ----
  const n = segments + 1;
  const step = TERRAIN_SPAN_M / segments;
  const positions = new Float32Array(n * n * 3);
  const uvs = new Float32Array(n * n * 2);
  const blend = new Float32Array(n * n * 3); // per-vertex (grass, dirt, forest) weights
  for (let row = 0; row < n; row++) {
    const z = -TERRAIN_HALF_M + row * step;
    for (let col = 0; col < n; col++) {
      const x = -TERRAIN_HALF_M + col * step;
      const i = row * n + col;
      positions[i * 3] = x;
      positions[i * 3 + 1] = terrainHeight(x, z);
      positions[i * 3 + 2] = z;
      uvs[i * 2] = x;
      uvs[i * 2 + 1] = z;
      const w = terrainBlendWeights(x, z);
      blend[i * 3] = w.grass;
      blend[i * 3 + 1] = w.dirt;
      blend[i * 3 + 2] = w.forest;
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < segments; row++) {
    for (let col = 0; col < segments; col++) {
      const a = row * n + col;
      const b = a + 1;
      const c = a + n;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('aBlend', new THREE.BufferAttribute(blend, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // ---- Material: MeshStandardMaterial + a 3-way splat injected via onBeforeCompile. ----
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    normalMap: dirt.nor, // presence enables three's normal-map plumbing; the chunk is replaced below
    normalScale: new THREE.Vector2(1, 1),
  });

  const uniforms = {
    uGrassDiff: { value: grass.diff },
    uDirtDiff: { value: dirt.diff },
    uForestDiff: { value: forest.diff },
    uGrassNor: { value: grass.nor },
    uDirtNor: { value: dirt.nor },
    uForestNor: { value: forest.nor },
    // Tile scale (tiles per meter) per zone -- different scales break cross-zone repetition.
    uScaleGrass: { value: 1 / 6.0 },
    uScaleDirt: { value: 1 / 8.5 },
    uScaleForest: { value: 1 / 5.0 },
    // Per-zone roughness (dirt track slightly polished by tires, grass/forest matte).
    uRough: { value: new THREE.Vector3(0.96, 0.82, 0.98) }, // (grass, dirt, forest)
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 aBlend;
         varying vec3 vBlendW;
         varying vec2 vWorldXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vBlendW = aBlend;
         vWorldXZ = position.xz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D uGrassDiff, uDirtDiff, uForestDiff;
         uniform sampler2D uGrassNor, uDirtNor, uForestNor;
         uniform float uScaleGrass, uScaleDirt, uScaleForest;
         uniform vec3 uRough;
         varying vec3 vBlendW;
         varying vec2 vWorldXZ;
         float terrHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
         float terrNoise(vec2 p){
           vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
           return mix(mix(terrHash(i), terrHash(i+vec2(1,0)), u.x),
                      mix(terrHash(i+vec2(0,1)), terrHash(i+vec2(1,1)), u.x), u.y);
         }
         vec3 terrSRGB(vec3 c){ return pow(c, vec3(2.2)); }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 wN = max(vBlendW, 0.0); wN /= max(wN.x + wN.y + wN.z, 1e-4);
         vec3 aG = terrSRGB(texture2D(uGrassDiff, vWorldXZ * uScaleGrass).rgb);
         vec3 aD = terrSRGB(texture2D(uDirtDiff, vWorldXZ * uScaleDirt).rgb);
         vec3 aF = terrSRGB(texture2D(uForestDiff, vWorldXZ * uScaleForest).rgb);
         vec3 terrAlbedo = aG * wN.x + aD * wN.y + aF * wN.z;
         float macro = terrNoise(vWorldXZ * 0.03) * 0.55 + terrNoise(vWorldXZ * 0.011) * 0.45;
         terrAlbedo *= mix(0.80, 1.16, macro);
         diffuseColor.rgb *= terrAlbedo;`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = dot(uRough, wN);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec3 nG = texture2D(uGrassNor, vWorldXZ * uScaleGrass).xyz * 2.0 - 1.0;
         vec3 nD = texture2D(uDirtNor, vWorldXZ * uScaleDirt).xyz * 2.0 - 1.0;
         vec3 nF = texture2D(uForestNor, vWorldXZ * uScaleForest).xyz * 2.0 - 1.0;
         vec3 mapN = normalize(nG * wN.x + nD * wN.y + nF * wN.z);
         mapN.xy *= normalScale;
         vec3 q0 = dFdx(-vViewPosition); vec3 q1 = dFdy(-vViewPosition);
         vec2 st0 = dFdx(vWorldXZ); vec2 st1 = dFdy(vWorldXZ);
         vec3 Ng = normalize(normal);
         vec3 T = normalize(q0 * st1.y - q1 * st0.y);
         vec3 B = -normalize(cross(Ng, T));
         normal = normalize(mat3(T, B, Ng) * mapN);`,
      );
  };
  // Cache-bust so a shader edit isn't served from three's program cache across HMR reloads.
  material.customProgramCacheKey = () => 'terrain-splat-v1';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Terrain';
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();

  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      for (const s of [grass, dirt, forest]) {
        s.diff.dispose();
        s.nor.dispose();
      }
    },
  };
}
