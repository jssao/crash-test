// Small Node-side (no TS/three import needed) copy of panels.ts's attached-pose math, for CDP verify
// scripts that only get plain JSON back from the page (car-map.ts's measured panel nodes + tuning.ts's
// CHASSIS_ORIGIN_HEIGHT_M, mirrored here manually -- see this repo's convention of small intentional
// copies to avoid cross-module import cycles, e.g. panels.ts's own mmToLocalCenter() doc comment).
// Used by shoot.mjs (this dir) and shoot-alignment.mjs to compute a panel's "attached" target pose
// (chassisPos + chassisRot*localCenter, chassisRot*nodeWorldQuat) from a dumpPoses()-style snapshot,
// so a verify script can assert BODY-vs-ATTACHED-POSE (not just mesh-vs-body).
export const CHASSIS_ORIGIN_HEIGHT_M = 0.39; // tuning.ts's CHASSIS_ORIGIN_HEIGHT_M (= car-map wheels.frontLeft.radiusMm/1000)

export const PANEL_NODES = {
  hood: { centerMm: [0, 503, 1793], worldQuat: [-0.70710678, 0, 0, 0.70710678] },
  doorL: { centerMm: [952, 635, 159], worldQuat: [-0.70710678, 0, 0, 0.70710678] },
  doorR: { centerMm: [-952, 635, 159], worldQuat: [-0.70710678, 0, 0, 0.70710678] },
  hatch: { centerMm: [0, 1031, -1027], worldQuat: [-0.70710695, 0, 0, 0.70710661] },
  roof: { centerMm: [0, 1132, -82], worldQuat: [-0.70710678, 0, 0, 0.70710678] },
};

export function rotateVector(q, v) {
  const qv = { x: q[0], y: q[1], z: q[2] };
  const cross1 = { x: qv.y * v.z - qv.z * v.y, y: qv.z * v.x - qv.x * v.z, z: qv.x * v.y - qv.y * v.x };
  const t = { x: cross1.x * 2, y: cross1.y * 2, z: cross1.z * 2 };
  const cross2 = { x: qv.y * t.z - qv.z * t.y, y: qv.z * t.x - qv.x * t.z, z: qv.x * t.y - qv.y * t.x };
  return { x: v.x + q[3] * t.x + cross2.x, y: v.y + q[3] * t.y + cross2.y, z: v.z + q[3] * t.z + cross2.z };
}

export function multiplyQuat(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function quatAngleDeg(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  return (2 * Math.acos(Math.min(1, Math.abs(d))) * 180) / Math.PI;
}

/** `chassisPos`/`chassisQuat` as plain [x,y,z]/[x,y,z,w] arrays (matches dumpPoses()'s `chassis.pos`/
 * `chassis.quat` and this script's own bodyPos/bodyQuat .toArray() shape). */
export function attachedTargetPose(key, chassisPos, chassisQuat) {
  const node = PANEL_NODES[key];
  const localCenter = { x: node.centerMm[0] / 1000, y: node.centerMm[1] / 1000 - CHASSIS_ORIGIN_HEIGHT_M, z: node.centerMm[2] / 1000 };
  const worldOffset = rotateVector(chassisQuat, localCenter);
  const pos = [chassisPos[0] + worldOffset.x, chassisPos[1] + worldOffset.y, chassisPos[2] + worldOffset.z];
  const quat = multiplyQuat(chassisQuat, node.worldQuat);
  return { pos, quat };
}

/** posM/angleDeg delta between a panel body's CURRENT pose (`bodyPos`/`bodyQuat`, arrays) and its
 * attached target given the chassis's current pose. */
export function poseDeltaVsAttached(key, bodyPos, bodyQuat, chassisPos, chassisQuat) {
  const target = attachedTargetPose(key, chassisPos, chassisQuat);
  const dx = bodyPos[0] - target.pos[0];
  const dy = bodyPos[1] - target.pos[1];
  const dz = bodyPos[2] - target.pos[2];
  return { posM: Math.hypot(dx, dy, dz), angleDeg: quatAngleDeg(bodyQuat, target.quat) };
}
