#!/usr/bin/env node
// Analyze a car GLB and (re)generate src/assets/car-map.ts.
//
// Walks the raw glTF node graph via manual GLB/JSON/accessor parsing —
// deliberately NOT GLTFLoader, which needs image/canvas decode not available
// headlessly in plain Node — and computes exact world-space bounding boxes per
// node-of-interest from the ACTUAL geometry (not eyeballed). Only three's pure
// math classes (Matrix4/Vector3/Quaternion/Box3, no DOM dependency) are used.
//
// CAR-AGNOSTIC: a per-car CONFIG (see CAR_CONFIGS below) names the wheel/panel/
// chassis/glass nodes and how to find glass + logo materials for THAT asset.
// The active config is auto-detected from the node names present in the GLB
// (so both the legacy Khronos CarConcept.glb and the Mustang-65 hero asset can
// be re-analyzed with the same script). The emitted schema is identical across
// cars — only the measured numbers + node names differ.
//
// Usage: node scripts/analyze-car.mjs [path-to-glb]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const glbPath = process.argv[2] || path.join(__dirname, '../public/assets/car/mustang65.glb');
const outPath = path.join(__dirname, '../src/assets/car-map.ts');
const buf = readFileSync(glbPath);

// ---------------------------------------------------------------------------------------------
// Per-car CONFIG registry. `detect(nodeNames)` picks the config that matches the loaded GLB.
// ---------------------------------------------------------------------------------------------
const CAR_CONFIGS = {
  // Mustang-65 hero asset: scripts/split-mustang.py output — flat, one mesh per part, identity
  // transforms baked into vertices (so every node's worldQuat is identity), Z-forward game frame.
  mustang65: {
    sourceFile: 'public/assets/car/mustang65.glb',
    // NOTE: excludes DoorRL so this doesn't also match the 4-door S90 GLB (both assets share
    // BodyShell/WheelFL node names) — see volvoS90's detect below, which requires DoorRL.
    detect: (names) => names.has('BodyShell') && names.has('WheelFL') && !names.has('DoorRL'),
    axisConvention:
      'Y-up, X-right (width), Z-forward (length); left/front-left wheel at +X/+Z; wheel-bottoms ~ Y=0; identity node transforms (baked)',
    header:
      "// Source: public/assets/car/mustang65.glb (Sketchfab \"Rigged Car Mustang 1965 with Engine\", CC-BY-4.0,\n" +
      "// split into named rigid parts by scripts/split-mustang.py). Axis convention (confirmed empirically\n" +
      "// from the file, not assumed): Y-up, X-right (width), +Z forward (length); front-left wheel at +X/+Z.\n" +
      "// Every part is a top-level node with an IDENTITY transform (the split baked pose + game-frame reorient\n" +
      "// straight into vertices), so every worldQuat below is identity — unlike the legacy CarConcept rig,\n" +
      "// there is no shared -90deg BodyUnderside ancestor. Car root sits with wheel bottoms at world Y ~ 0.",
    wheels: { frontLeft: 'WheelFL', frontRight: 'WheelFR', rearLeft: 'WheelRL', rearRight: 'WheelRR' },
    // Damage panels: hood + 2 doors + trunk (NO roof panel — a 2-door fastback folds the roof into the
    // shell; the rear lid is a trunk, which replaces the concept car's hatch semantics).
    panels: ['Hood', 'DoorL', 'DoorR', 'Trunk'],
    // Chassis (non-panel structural/visual bodies). EngineBlock = compact under-hood block (the modeled
    // engine-bay reveal); Drivetrain = the underbody drivetrain/exhaust run. Both fall back gracefully
    // to a single 'Engine' node if the sub-split wasn't produced (see split-mustang.py).
    chassis: ['BodyShell', 'EngineBlock', 'Drivetrain', 'Engine'],
    // Glass detected by MATERIAL NAME (this asset carries no KHR_materials_transmission extension).
    glassMaterialNames: new Set(['TransparentGlass', 'refract glass']),
    // No KHR_materials_variants and no trademarked-logo textures in this asset (all flat color factors).
    logoMaterialsToSanitize: [],
  },
  // Volvo S90 4-door sedan (replaces the Mustang-65 hero asset). Export-validated: 377,054 verts /
  // 127 objects, dims 5.00 x 2.01 x 1.43 m. Same axis convention/game-frame as the Mustang split
  // (identity node transforms baked into vertices, Y-up/X-right/Z-forward, front-left wheel +X/+Z) —
  // confirmed empirically by reading the raw GLB node translations directly (WheelFL at
  // x=+0.816/z=+1.610, WheelRL at x=+0.816/z=-1.330 => wheelbase ~2.94m, matches spec).
  volvoS90: {
    sourceFile: 'public/assets/car/volvo-s90.glb',
    // DoorRL (rear-left door) only exists on the 4-door S90, not the Mustang — see mustang65's
    // detect exclusion above.
    detect: (names) => names.has('BodyShell') && names.has('WheelFL') && names.has('DoorRL'),
    axisConvention:
      'Y-up, X-right (width), Z-forward (length); left/front-left wheel at +X/+Z; wheel-bottoms ~ Y=0; identity node transforms (baked)',
    header:
      "// Source: public/assets/car/volvo-s90.glb (exported Volvo S90 4-door sedan, replacing the\n" +
      "// Mustang-65 hero asset). Axis convention (confirmed empirically from the file, not assumed):\n" +
      "// Y-up, X-right (width), +Z forward (length); front-left wheel at +X/+Z. Every part is a\n" +
      "// top-level node with an IDENTITY transform (pose + game-frame reorient baked into vertices\n" +
      "// at export time, same convention as the Mustang split), so every worldQuat below is identity.\n" +
      "// Car root sits with wheel bottoms at world Y ~ 0.",
    wheels: { frontLeft: 'WheelFL', frontRight: 'WheelFR', rearLeft: 'WheelRL', rearRight: 'WheelRR' },
    // Damage panels: hood + 4 doors (front L/R + rear L/R — a real 4-door sedan, unlike the Mustang
    // fastback's 2 doors) + trunk. Rear doors are full detachable panels (orchestrator decision,
    // 2026-07-11 S90-swap plan): PanelKey gains 'doorRL'/'doorRR'.
    panels: ['Hood', 'DoorL', 'DoorR', 'DoorRL', 'DoorRR', 'Trunk'],
    // Chassis (non-panel structural body). EngineBlock is a small filler box (72 verts / 36 faces) —
    // the S90 source has NO modeled engine (empty bay under the hood); no Drivetrain sub-split exists
    // for this asset (falls through gracefully — see the `if (!nameToIndex.has(...))` guard below).
    chassis: ['BodyShell', 'EngineBlock', 'Drivetrain', 'Engine'],
    // Glass detected by MATERIAL NAME. Verified by reading the raw GLB materials + primitive lists:
    // 'Glass' is used by Windshield, RearWindow, QuarterGlass, Sunroof, and baked as a sub-primitive
    // into DoorL/DoorR/DoorRL/DoorRR (door windows) and BodyShell (rearview-mirror glass) — same
    // "baked into panel mesh" pattern as the Mustang. Other glass-ish materials exist (e.g.
    // 'GlassInterior', 'Glass Taillight', 'Translucent_Glass', 'Black Glass', 'GlassRunninglight',
    // 'heaxagon glass') but those are lighting-lens/interior-trim glass, not structural panes, and are
    // deliberately excluded so they don't register as shatterable windshield/window glass.
    glassMaterialNames: new Set(['Glass']),
    // No trademarked-logo textures found needing sanitization for this asset.
    logoMaterialsToSanitize: [],
  },
  // Legacy Khronos CarConcept.glb (kept working so the original asset can still be re-analyzed).
  carConcept: {
    sourceFile: 'public/assets/car/CarConcept.glb',
    detect: (names) => names.has('BodyHood') && names.has('WheelFrontL'),
    axisConvention: 'Y-up, X-right (width), Z-forward (length); root identity transform, wheel-bottom ~ Y=0',
    header:
      "// Source: public/assets/car/CarConcept.glb (Khronos glTF-Sample-Assets \"CarConcept\", CC-BY-4.0)\n" +
      "// Axis convention (confirmed empirically from the file, not assumed): glTF standard Y-up, X-right\n" +
      "// (car width), Z (car length, +Z ~ front). Car root sits with wheel bottoms at world Y ~ 0.",
    wheels: { frontLeft: 'WheelFrontL', frontRight: 'WheelFrontR', rearLeft: 'WheelRearL', rearRight: 'WheelRearR' },
    panels: ['BodyHood', 'BodyDoorLColor1', 'BodyDoorRColor1', 'InteriorRearHatch', 'BodyRoofPanel', 'BodyRearPanelsColor1', 'BodyPanelsColor2', 'BodyPillars'],
    chassis: ['BodyUnderside', 'Engine', 'Axles', 'InteriorCage'],
    glassMaterialNames: new Set(),
    chosenVariantIndex: 2, // "Torched Graphite"
    logoMaterialsToSanitize: [
      { name: 'License', slot: 'map', reason: 'baseColorTexture is the Khronos Group wordmark PNG (license-plate decal)' },
      { name: 'Tireside', slot: 'map', reason: 'baseColorTexture is Khronos + 3D Commerce logos (tire sidewall decal)' },
      { name: 'Hardware', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
      { name: 'Mirror', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
      { name: 'Brake', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
      { name: 'Rim1', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
      { name: 'Rim2', slot: 'emissiveMap', reason: 'reuses the Khronos wordmark image as emissiveTexture' },
    ],
  },
};

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
    m.compose(new THREE.Vector3(t[0], t[1], t[2]), new THREE.Quaternion(r[0], r[1], r[2], r[3]), new THREE.Vector3(s[0], s[1], s[2]));
  }
  return m;
}

// ---- 4. Walk hierarchy, compute world matrices, per-node mesh AABB ----
const nodeAABB = new Map(); // nodeIndex -> Box3 (this node's own mesh only, world-space)
const nodeWorldMatrix = new Map(); // nodeIndex -> Matrix4 (TRS-chain world transform of the NODE itself)

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
  nodeWorldMatrix.set(nodeIndex, world);
  if (node.mesh !== undefined) nodeAABB.set(nodeIndex, meshWorldBox3(node.mesh, world));
  for (const child of node.children || []) walk(child, world);
}

const sceneRoots = json.scenes[json.scene || 0].nodes;
for (const rootIdx of sceneRoots) walk(rootIdx, new THREE.Matrix4());

// subtree AABB = this node's own mesh (if any) unioned with all descendants.
function subtreeBox(nodeIndex) {
  const node = json.nodes[nodeIndex];
  const box = new THREE.Box3();
  if (nodeAABB.has(nodeIndex)) box.union(nodeAABB.get(nodeIndex));
  for (const child of node.children || []) box.union(subtreeBox(child));
  return box;
}

const nameToIndex = new Map();
json.nodes.forEach((n, i) => { if (n.name) nameToIndex.set(n.name, i); });

// ---- Select the active per-car config from the node names present ----
const nodeNames = new Set(nameToIndex.keys());
const CONFIG = Object.values(CAR_CONFIGS).find((c) => c.detect(nodeNames));
if (!CONFIG) throw new Error('analyze-car: no CAR_CONFIG matches the nodes in ' + glbPath + ' — add one to CAR_CONFIGS.');

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

// ---- 4b. Per-node world ROTATION quaternion (identity for the baked Mustang parts) ----
const roundQ = (q) => [q.x, q.y, q.z, q.w].map((v) => Math.round(v * 1e8) / 1e8);
const worldQuatOf = (nodeName) => {
  const idx = nameToIndex.get(nodeName);
  if (idx === undefined) throw new Error('node not found: ' + nodeName);
  const m = nodeWorldMatrix.get(idx);
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  m.decompose(pos, quat, scl);
  return roundQ(quat);
};

// ---- 5. Whole-car AABB (union of ALL scene roots — the Mustang has 11 sibling roots, not one) ----
const overallBox = new THREE.Box3();
for (const rootIdx of sceneRoots) overallBox.union(subtreeBox(rootIdx));
const overallSize = new THREE.Vector3();
const overallCenter = new THREE.Vector3();
overallBox.getSize(overallSize);
overallBox.getCenter(overallCenter);
const overallDimsMm = { length: mm(overallSize.z), width: mm(overallSize.x), height: mm(overallSize.y) };
// World-space center of the whole-body AABB (mm). The car is NOT symmetric front/rear, so this Z is
// non-zero -- consumers (e.g. cardetail-containment.test.mjs's ENVELOPE) need it to place the body box.
const overallCenterMm = [mm(overallCenter.x), mm(overallCenter.y), mm(overallCenter.z)];

// ---- Wheels ----
const wheelData = {};
for (const [key, nodeName] of Object.entries(CONFIG.wheels)) {
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
    worldQuat: worldQuatOf(nodeName),
  };
}

// ---- Panels ----
const panelData = {};
for (const nodeName of CONFIG.panels) {
  if (!nameToIndex.has(nodeName)) continue; // config may list optional panels
  const b = bboxMm(nodeName);
  panelData[nodeName] = { node: nodeName, ...b, childNodes: childNames(nodeName), worldQuat: worldQuatOf(nodeName) };
}

// ---- Chassis (skip config entries not present, e.g. Engine vs EngineBlock/Drivetrain sub-split) ----
const chassisData = {};
for (const nodeName of CONFIG.chassis) {
  if (!nameToIndex.has(nodeName)) continue;
  const b = bboxMm(nodeName);
  chassisData[nodeName] = { node: nodeName, ...b, worldQuat: worldQuatOf(nodeName) };
}

const wheelbaseMm = mm(Math.abs(bbox(CONFIG.wheels.frontLeft).center[2] - bbox(CONFIG.wheels.rearLeft).center[2]));
const trackFrontMm = mm(Math.abs(bbox(CONFIG.wheels.frontLeft).center[0] - bbox(CONFIG.wheels.frontRight).center[0]));
const trackRearMm = mm(Math.abs(bbox(CONFIG.wheels.rearLeft).center[0] - bbox(CONFIG.wheels.rearRight).center[0]));

// ---- 6. Material variants (KHR_materials_variants, if any) ----
const variantsExt = json.extensions && json.extensions.KHR_materials_variants;
const variants = variantsExt ? variantsExt.variants.map((v) => v.name) : [];
const CHOSEN_VARIANT_INDEX = variants.length ? (CONFIG.chosenVariantIndex ?? 0) : 0;

// ---- 7. Glass / transmission survey (transmission ext OR config material-name allowlist) ----
const glassMatNames = CONFIG.glassMaterialNames || new Set();
const isGlassMaterial = (m) =>
  (m.extensions && m.extensions.KHR_materials_transmission) || glassMatNames.has(m.name);
const glassMaterials = [];
json.materials.forEach((m) => {
  if (!isGlassMaterial(m)) return;
  glassMaterials.push({ name: m.name, transmissionFactor: m.extensions?.KHR_materials_transmission?.transmissionFactor ?? 0 });
});
// Only DEDICATED glass panes count as shatter-glass. Door windows are baked into the door PANEL
// meshes (they travel + crumple with the door, not as a separately-swappable pane), so panel nodes
// are excluded here even though their meshes contain a glass-material primitive.
const panelNameSet = new Set(CONFIG.panels);
const chassisNameSet = new Set(CONFIG.chassis);
const glassMeshNodes = [];
json.nodes.forEach((n) => {
  if (n.mesh === undefined || !n.name) return;
  if (panelNameSet.has(n.name) || chassisNameSet.has(n.name)) return;
  const mesh = json.meshes[n.mesh];
  const usesGlass = mesh.primitives.some((p) => p.material !== undefined && isGlassMaterial(json.materials[p.material]));
  if (usesGlass) glassMeshNodes.push(n.name);
});

// ---- 8. Trademarked-logo textures to neutralize at load (config-provided; empty for the Mustang) ----
const logoMaterialsToSanitize = CONFIG.logoMaterialsToSanitize || [];

// ---- 9. Emit src/assets/car-map.ts ----
const generatedAt = new Date().toISOString();
const ts = `// AUTO-GENERATED by scripts/analyze-car.mjs — DO NOT HAND-EDIT.
// Re-run \`npm run analyze-car\` after the source GLB changes to refresh these numbers.
//
${CONFIG.header}
// Generated: ${generatedAt}

export interface Vec3Mm { readonly 0: number; readonly 1: number; readonly 2: number }
export interface Vec4 { readonly 0: number; readonly 1: number; readonly 2: number; readonly 3: number }

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
  /** Rim / brake pad / brake disc / tire child node names (empty for the flat Mustang parts). */
  childNodes: string[];
  /**
   * This node's own world-space rotation quaternion [x,y,z,w] at load time (car root at scene origin).
   * For the Mustang split every part carries an IDENTITY transform (pose baked into vertices), so this
   * is [0,0,0,1] for all nodes — wheels.ts strips authored wheel rotation regardless (a wheel is
   * rotationally symmetric about its hub, so any authored spin is discarded).
   */
  worldQuat: Vec4;
}

export interface PanelNode extends NodeBox {
  node: string;
  /** Sub-nodes that move as one rigid group with this panel (empty for the flat Mustang parts). */
  childNodes: string[];
  /**
   * This node's own world-space rotation quaternion [x,y,z,w] at load time. Identity for the Mustang
   * (baked transforms); panels.ts still composes chassisSpawnRotation * worldQuat when spawning/welding
   * each panel body, which reduces to the bare chassis rotation when worldQuat is identity.
   */
  worldQuat: Vec4;
}

export interface ChassisNode extends NodeBox {
  node: string;
  /** See WheelNode/PanelNode's worldQuat doc comment — identity for the Mustang parts. */
  worldQuat: Vec4;
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
  /** World-space center of the whole-body AABB, mm (X≈0, Y≈height/2, Z non-zero: front/rear asymmetry). */
  overallCenterMm: Vec3Mm;
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
  /** Index into materialVariants selected at load (see render/car.ts). 0 when the asset has no variants. */
  chosenVariantIndex: number;
  glassMaterials: GlassMaterial[];
  glassMeshNodes: string[];
  /**
   * Materials carrying a trademarked logo texture to neutralize at load (scene/car.ts clears these
   * texture slots). Empty for the Mustang asset (no logo textures — all flat color factors).
   */
  logoMaterialsToSanitize: LogoSanitizeEntry[];
}

export const CAR_MAP: CarMap = ${JSON.stringify(
  {
    sourceFile: CONFIG.sourceFile,
    generatedAt,
    axisConvention: CONFIG.axisConvention,
    overallDimsMm,
    overallCenterMm,
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
console.log('wrote', outPath, '(config:', Object.keys(CAR_CONFIGS).find((k) => CAR_CONFIGS[k] === CONFIG) + ')');
console.log('overall dims mm (L x W x H):', overallDimsMm.length, 'x', overallDimsMm.width, 'x', overallDimsMm.height);
console.log('wheelbase mm:', wheelbaseMm, 'track F/R mm:', trackFrontMm, '/', trackRearMm);
console.log('wheel radius mm (FL):', wheelData.frontLeft.radiusMm, 'width mm:', wheelData.frontLeft.widthMm);
console.log('panels:', Object.keys(panelData).join(', '));
console.log('chassis:', Object.keys(chassisData).join(', '));
console.log('glass materials:', glassMaterials.map((g) => g.name).join(', ') || '(none)', '| glass nodes:', glassMeshNodes.join(', ') || '(none)');
console.log('variants:', variants.join(', ') || '(none)', '| logo-sanitize:', logoMaterialsToSanitize.length);
