import { readFileSync } from 'node:fs';
import * as THREE from 'three';

const buf = readFileSync(new URL('../../public/assets/car/CarConcept.glb', import.meta.url));
function parseGLB(buffer) {
  let offset = 12, json = null, bin = null;
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
const { json } = parseGLB(buf);

function localMatrix(node) {
  const m = new THREE.Matrix4();
  if (node.matrix) { m.fromArray(node.matrix); return m; }
  const t = node.translation || [0,0,0];
  const r = node.rotation || [0,0,0,1];
  const s = node.scale || [1,1,1];
  m.compose(new THREE.Vector3(...t), new THREE.Quaternion(...r), new THREE.Vector3(...s));
  return m;
}

const nameToIndex = new Map();
json.nodes.forEach((n,i) => { if (n.name) nameToIndex.set(n.name, i); });
const parentOf = new Map();
json.nodes.forEach((n,i) => (n.children||[]).forEach(c => parentOf.set(c, i)));

function worldMatrix(nodeIndex) {
  let m = new THREE.Matrix4();
  let idx = nodeIndex;
  const chain = [];
  while (idx !== undefined) { chain.unshift(idx); idx = parentOf.get(idx); }
  for (const i of chain) m.multiply(localMatrix(json.nodes[i]));
  return m;
}

function dump(name) {
  const idx = nameToIndex.get(name);
  const node = json.nodes[idx];
  const localQ = new THREE.Quaternion(...(node.rotation||[0,0,0,1]));
  const localT = node.translation || [0,0,0];
  const wm = worldMatrix(idx);
  const wp = new THREE.Vector3(); const wq = new THREE.Quaternion(); const ws = new THREE.Vector3();
  wm.decompose(wp, wq, ws);
  const e = new THREE.Euler().setFromQuaternion(wq, 'XYZ');
  console.log(name.padEnd(14),
    'parent=', json.nodes[parentOf.get(idx)]?.name,
    'localQuat=', (node.rotation||[0,0,0,1]).map(x=>x.toFixed(4)),
    'localPos=', localT.map(x=>x.toFixed(4)),
    'worldQuat=', [wq.x,wq.y,wq.z,wq.w].map(x=>x.toFixed(4)),
    'worldPos=', [wp.x,wp.y,wp.z].map(x=>x.toFixed(4)),
    'worldEulerDeg=', [e.x,e.y,e.z].map(r=>(r*180/Math.PI).toFixed(2))
  );
  return wq;
}

const WORLD_UP = new THREE.Vector3(0,1,0);
function neutralizeSteerYaw(q) {
  const twist = new THREE.Quaternion(0, q.y * WORLD_UP.y, 0, q.w);
  const len = Math.hypot(twist.y, twist.w);
  if (len < 1e-8) return q.clone();
  twist.set(0, twist.y/len, 0, twist.w/len);
  return q.clone().multiply(twist.clone().invert());
}

console.log('--- panels ---');
for (const n of ['BodyHood','BodyDoorLColor1','BodyDoorRColor1','InteriorRearHatch','BodyRoofPanel']) dump(n);

console.log('\n--- wheels raw ---');
const flQ = dump('WheelFrontL');
const frQ = dump('WheelFrontR');
const rlQ = dump('WheelRearL');
const rrQ = dump('WheelRearR');

console.log('\n--- wheels after neutralizeSteerYaw (front only) ---');
const flN = neutralizeSteerYaw(flQ);
const frN = neutralizeSteerYaw(frQ);
function angDeg(a,b){ let d=Math.abs(a.x*b.x+a.y*b.y+a.z*b.z+a.w*b.w); d=Math.min(1,d); return 2*Math.acos(d)*180/Math.PI; }
console.log('FL neutralized quat', [flN.x,flN.y,flN.z,flN.w].map(x=>x.toFixed(4)), 'angle from identity(deg)=', angDeg(flN, new THREE.Quaternion()).toFixed(2));
console.log('FR neutralized quat', [frN.x,frN.y,frN.z,frN.w].map(x=>x.toFixed(4)), 'angle from identity(deg)=', angDeg(frN, new THREE.Quaternion()).toFixed(2));
console.log('RL raw quat        ', [rlQ.x,rlQ.y,rlQ.z,rlQ.w].map(x=>x.toFixed(4)), 'angle from identity(deg)=', angDeg(rlQ, new THREE.Quaternion()).toFixed(2));
console.log('RR raw quat        ', [rrQ.x,rrQ.y,rrQ.z,rrQ.w].map(x=>x.toFixed(4)), 'angle from identity(deg)=', angDeg(rrQ, new THREE.Quaternion()).toFixed(2));
console.log('angle FL-neutralized vs FR-neutralized (deg)=', angDeg(flN, frN).toFixed(2));
console.log('angle FL-neutralized vs RL-raw (deg)=', angDeg(flN, rlQ).toFixed(2));
console.log('angle FR-neutralized vs RR-raw (deg)=', angDeg(frN, rrQ).toFixed(2));
