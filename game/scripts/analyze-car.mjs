#!/usr/bin/env node
// Analyze CarConcept.glb and (re)generate src/assets/car-map.ts.
//
// Walks the raw glTF node graph via manual GLB/JSON/accessor parsing —
// deliberately NOT GLTFLoader, which needs image/canvas decode not available
// headlessly in plain Node — and computes exact world-space bounding boxes per
// node-of-interest from the ACTUAL geometry (not eyeballed). Only three's pure
// math classes (Matrix4/Vector3/Quaternion/Box3, no DOM dependency) are used.
//
// Usage: node scripts/analyze-car.mjs [path-to-glb]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const glbPath = process.argv[2] || path.join(__dirname, '../public/assets/car/CarConcept.glb');
const outPath = path.join(__dirname, '../src/assets/car-map.ts');
const buf = readFileSync(glbPath);

// ---- 1. Split GLB container into JSON + BIN chunks ----
function parseGLB(buffer) {
  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== 'glTF') throw new Error('not a GLB file: ' + glbPath);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < buffer.length) {
    const chunkLength = buffer.readUInt32LE(offset);
    const chunkType = buffer.toString('ascii', offset + 4, offset + 8);
    const chunkData = buffer.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 'JSON') json = JSON.parse(chunkData.toString('utf8'));
    else if (chunkType.startsWith('BIN')) bin = chunkData;
    offset += 8 + chunkLength;
  }
  return { json, bin };
}

const { json, bin } = parseGLB(buf);

// ---- 2. Minimal accessor reader (POSITION, VEC3 float32 — all we need) ----
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  const bufferView = json.bufferViews[accessor.bufferView];
  const compBytes = COMPONENT_BYTES[accessor.componentType];
  const numComponents = TYPE_COMPONENTS[accessor.type];
  const stride = bufferView.byteStride || compBytes * numComponents;
  const base = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
  const out = new Float32Array(accessor.count * numComponents);
  for (let i = 0; i < accessor.count; i++) {
    const elOffset = base + i * stride;
    for (let c = 0; c < numComponents; c++) {
      const byteOff = elOffset + c * compBytes;
      let v;
      switch (accessor.componentType) {
        case 5126: v = bin.readFloatLE(byteOff); break; // FLOAT
        case 5125: v = bin.readUInt32LE(byteOff); break; // UNSIGNED_INT
        case 5123: v = bin.readUInt16LE(byteOff); break; // UNSIGNED_SHORT
        case 5121: v = bin.readUInt8(byteOff); break; // UNSIGNED_BYTE
        default: throw new Error('unsupported componentType ' + accessor.componentType);
      }
      out[i * numComponents + c] = v;
    }
  }
  return out;
}

// ---- 3. Node local matrix (TRS or explicit matrix) ----
function localMatrix(node) {
  const m = new THREE.Matrix4();
  if (node.matrix) {
    m.fromArray(node.matrix);
  } else {
    const t = node.translation || [0, 0, 0];
    const r = node.rotation || [0, 0, 0, 1];
    const s = node.scale || [1, 1, 1];
    m.compose(
      new THREE.Vector3(t[0], t[1], t[2]),
      new THREE.Quaternion(r[0], r[1], r[2], r[3]),
      new THREE.Vector3(s[0], s[1], s[2]),
    );
  }
  return m;
}

// ---- 4. Walk hierarchy, compute world matrices, per-node mesh AABB ----
const nodeAABB = new Map(); // nodeIndex -> Box3 (this node's own mesh only, world-space)

function meshWorldBox3(meshIndex, matrix) {
  const box = new THREE.Box3();
  const mesh = json.meshes[meshIndex];
  const v = new THREE.Vector3();
  for (const prim of mesh.primitives) {
    const posAccessor = prim.attributes.POSITION;
    if (posAccessor === undefined) continue;
    const positions = readAccessor(posAccessor);
    for (let i = 0; i < positions.length; i += 3) {
      v.set(positions[i], positions[i + 1], positions[i + 2]).applyMatrix4(matrix);
      box.expandByPoint(v);
    }
  }
  return box;
}

function walk(nodeIndex, parentMatrix) {
  const node = json.nodes[nodeIndex];
  const world = parentMatrix.clone().multiply(localMatrix(node));
  if (node.mesh !== undefined) nodeAABB.set(nodeIndex, meshWorldBox3(node.mesh, world));
  for (const child of node.children || []) walk(child, world);
}

const sceneRoots = json.scenes[json.scene || 0].nodes;
for (const rootIdx of sceneRoots) walk(rootIdx, new THREE.Matrix4());

// subtree AABB = this node's own mesh (if any) unioned with all descendants —
// correct for "wheel" groups (pure transform nodes whose meshes live on Rim/
// BrakePad/BrakeDisc/tire children) and for "panel" assemblies (a door's glass/
// mirror/handle/interior-trim children move as one rigid group with the panel).
function subtreeBox(nodeIndex) {
  const node = json.nodes[nodeIndex];
  const box = new THREE.Box3();
  if (nodeAABB.has(nodeIndex)) box.union(nodeAABB.get(nodeIndex));
  for (const child of node.children || []) box.union(subtreeBox(child));
  return box;
}

const nameToIndex = new Map();
json.nodes.forEach((n, i) => { if (n.name) nameToIndex.set(n.name, i); });

function childNames(nodeName) {
  const idx = nameToIndex.get(nodeName);
  return (json.nodes[idx].children || []).map((c) => json.nodes[c].name).filter(Boolean);
}

function bbox(nodeName) {
  const idx = nameToIndex.get(nodeName);
  if (idx === undefined) throw new Error('node not found: ' + nodeName);
  const box = subtreeBox(idx);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return { center: [center.x, center.y, center.z], size: [size.x, size.y, size.z] };
}

const mm = (m) => Math.round(m * 1000);
const bboxMm = (nodeName) => {
  const b = bbox(nodeName);
  return { centerMm: b.center.map(mm), sizeMm: b.size.map(mm) };
};

// ---- 5. Whole-car AABB — confirms axis convention empirically ----
// Result: Y = up (height), Z = length (front/back), X = width (left/right) —
// standard glTF Y-up; smallest extent is Y, largest is Z. Ground (wheel bottom)
// sits at world Y ~ 0 already (root node has identity transform), confirmed by
// the wheel AABBs' min.y being ~0.
const rootName = json.nodes[sceneRoots[0]].name;
const rootBbox = bboxMm(rootName);

const WHEELS = {
  frontLeft: 'WheelFrontL',
  frontRight: 'WheelFrontR',
  rearLeft: 'WheelRearL',
  rearRight: 'WheelRearR',
};
const wheelData = {};
for (const [key, nodeName] of Object.entries(WHEELS)) {
  const raw = bbox(nodeName);
  const radiusM = Math.max(raw.size[1], raw.size[2]) / 2; // circular cross-section is Y-Z plane
  const widthM = raw.size[0]; // extent along the axle (X) axis
  wheelData[key] = {
    node: nodeName,
    centerMm: raw.center.map(mm),
    sizeMm: raw.size.map(mm),
    radiusMm: mm(radiusM),
    widthMm: mm(widthM),
    childNodes: childNames(nodeName),
  };
}

const PANELS = ['BodyHood', 'BodyDoorLColor1', 'BodyDoorRColor1', 'InteriorRearHatch', 'BodyRoofPanel', 'BodyRearPanelsColor1', 'BodyPanelsColor2', 'BodyPillars'];
const panelData = {};
for (const nodeName of PANELS) {
  const b = bboxMm(nodeName);
  panelData[nodeName] = { node: nodeName, ...b, childNodes: childNames(nodeName) };
}

const CHASSIS = ['BodyUnderside', 'Engine', 'Axles', 'InteriorCage'];
const chassisData = {};
for (const nodeName of CHASSIS) {
  const b = bboxMm(nodeName);
  chassisData[nodeName] = { node: nodeName, ...b };
}

const wheelbaseMm = mm(Math.abs(bbox('WheelFrontL').center[2] - bbox('WheelRearL').center[2]));
const trackFrontMm = mm(Math.abs(bbox('WheelFrontL').center[0] - bbox('WheelFrontR').center[0]));
const trackRearMm = mm(Math.abs(bbox('WheelRearL').center[0] - bbox('WheelRearR').center[0]));

// ---- 6. Variants ----
const variantsExt = json.extensions && json.extensions.KHR_materials_variants;
const variants = variantsExt ? variantsExt.variants.map((v) => v.name) : [];
const CHOSEN_VARIANT_INDEX = 2; // "Torched Graphite" — dark metallic paint, reads well under HDRI specular

// ---- 7. Glass / transmission survey ----
const glassMaterials = [];
json.materials.forEach((m) => {
  if (m.extensions && m.extensions.KHR_materials_transmission) {
    glassMaterials.push({ name: m.name, transmissionFactor: m.extensions.KHR_materials_transmission.transmissionFactor });
  }
});
const glassMeshNodes = [];
json.nodes.forEach((n) => {
  if (n.mesh === undefined) return;
  const mesh = json.meshes[n.mesh];
  const usesGlass = mesh.primitives.some((p) => json.materials[p.material]?.extensions?.KHR_materials_transmission);
  if (usesGlass) glassMeshNodes.push(n.name);
});

// ---- 8. Trademarked-logo textures found in this file (render-time sanitization) ----
// image 3  = Khronos Group wordmark  -> material "License" (baseColorTexture), node "License Plate"
// image 10 = Khronos + 3D Commerce   -> material "Tireside" (baseColorTexture), all 4 tire sidewalls
// Several trim materials (Hardware/Mirror/Brake/Rim1/Rim2 + one unnamed) reuse image 3
// as an emissiveTexture; UV footprint on those small trim meshes is unverified, so they
// are neutralized defensively too. None of this is gated by KHR_materials_variants —
// picking a non-"branded" variant name is NOT sufficient by itself.
const logoMaterialsToSanitize = [
  { name: 'License', slot: 'map', reason: 'baseColorTexture is the Khronos Group wordmark PNG (license-plate decal)' },
  { name: 'Tireside', slot: 'map', reason: 'baseColorTexture is Khronos + 3D Commerce logos (tire sidewall decal)' },
  { name: 'Hardware', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
  { name: 'Mirror', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
  { name: 'Brake', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
  { name: 'Rim1', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
  { name: 'Rim2', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
];

// ---- 9. Emit src/assets/car-map.ts ----
const generatedAt = new Date().toISOString();
const ts = `// AUTO-GENERATED by scripts/analyze-car.mjs — DO NOT HAND-EDIT.
// Re-run \`npm run analyze-car\` after the source GLB changes to refresh these numbers.
//
// Source: public/assets/car/CarConcept.glb (Khronos glTF-Sample-Assets "CarConcept", CC-BY-4.0)
// Generated: ${generatedAt}
// Axis convention (confirmed empirically from the file, not assumed): glTF standard
// Y-up, X-right (car width), Z (car length, +Z ~ front). Car root sits with wheel
// bottoms at world Y ~ 0 (identity root transform) — safe to place at scene origin.

export interface Vec3Mm { readonly 0: number; readonly 1: number; readonly 2: number }

export interface NodeBox {
  /** World-space AABB center at load time (car root at scene origin), millimeters. */
  centerMm: Vec3Mm;
  /** World-space AABB size, millimeters. */
  sizeMm: Vec3Mm;
}

export interface WheelNode extends NodeBox {
  node: string;
  radiusMm: number;
  widthMm: number;
  /** Rim / brake pad / brake disc / tire child node names. */
  childNodes: string[];
}

export interface PanelNode extends NodeBox {
  node: string;
  /** Sub-nodes that move as one rigid group with this panel (glass, mirrors, handles, trim). */
  childNodes: string[];
}

export interface ChassisNode extends NodeBox {
  node: string;
}

export interface GlassMaterial {
  name: string;
  transmissionFactor: number;
}

export interface LogoSanitizeEntry {
  /** glTF/three.js material name to patch at load time. */
  name: string;
  /** Texture slot on the built THREE.MeshStandardMaterial to clear. */
  slot: 'map' | 'emissiveMap';
  reason: string;
}

export interface CarMap {
  sourceFile: string;
  generatedAt: string;
  axisConvention: string;
  overallDimsMm: { length: number; width: number; height: number };
  wheelbaseMm: number;
  trackFrontMm: number;
  trackRearMm: number;
  wheels: {
    frontLeft: WheelNode;
    frontRight: WheelNode;
    rearLeft: WheelNode;
    rearRight: WheelNode;
  };
  panels: Record<string, PanelNode>;
  chassis: Record<string, ChassisNode>;
  materialVariants: string[];
  /** Index into materialVariants selected at load (see render/car.ts). */
  chosenVariantIndex: number;
  glassMaterials: GlassMaterial[];
  glassMeshNodes: string[];
  /**
   * Materials carrying a Khronos Group / 3D Commerce trademarked logo texture,
   * found in THIS file regardless of KHR_materials_variants selection (the
   * logo is NOT variant-gated — selecting a "non-logo" variant name is not
   * sufficient by itself). scene/car.ts clears these texture slots at load.
   */
  logoMaterialsToSanitize: LogoSanitizeEntry[];
}

export const CAR_MAP: CarMap = ${JSON.stringify(
  {
    sourceFile: 'public/assets/car/CarConcept.glb',
    generatedAt,
    axisConvention: 'Y-up, X-right (width), Z-forward (length); root identity transform, wheel-bottom ~ Y=0',
    overallDimsMm: { length: rootBbox.sizeMm[2], width: rootBbox.sizeMm[0], height: rootBbox.sizeMm[1] },
    wheelbaseMm,
    trackFrontMm,
    trackRearMm,
    wheels: wheelData,
    panels: panelData,
    chassis: chassisData,
    materialVariants: variants,
    chosenVariantIndex: CHOSEN_VARIANT_INDEX,
    glassMaterials,
    glassMeshNodes,
    logoMaterialsToSanitize,
  },
  null,
  2,
)};
`;

writeFileSync(outPath, ts, 'utf8');
console.log('wrote', outPath);
console.log('overall dims mm (L x W x H):', rootBbox.sizeMm[2], 'x', rootBbox.sizeMm[0], 'x', rootBbox.sizeMm[1]);
console.log('wheelbase mm:', wheelbaseMm, 'track F/R mm:', trackFrontMm, '/', trackRearMm);
console.log('wheel radius mm (FL):', wheelData.frontLeft.radiusMm, 'width mm:', wheelData.frontLeft.widthMm);
console.log('chosen variant:', variants[CHOSEN_VARIANT_INDEX]);
