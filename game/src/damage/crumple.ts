// SPDX-License-Identifier: MIT
//
// Persistent, CPU-side plastic-crumple vertex deformation (G3 spec). Operates purely on typed arrays
// (positions/indices/normals) plus plain {x,y,z} points -- deliberately NOT on THREE.Mesh/BufferGeometry
// directly, so this module has no three/DOM import and is shared, unmodified, by both the browser game
// (game/src/scene/carDeformables.ts adapts real GLB geometry into this shape) and the headless sim
// tests (game/sim/damage-*.test.mjs, which register small synthetic grid meshes via buildGridPlane()
// below -- no GLTFLoader/three available in plain node).
//
// Determinism: every source of "randomness" here (the per-vertex crease jitter) is a pure integer
// hash of the vertex index (+ a per-mesh string seed), NOT Math.random()/Date.now() -- required by
// game/sim/damage-determinism.test.mjs.

import type { V3 } from '../vehicle/mathUtil';
import {
	CRUMPLE_CLAMP_CHASSIS_M,
	CRUMPLE_CLAMP_PANEL_GLASS_M,
	CRUMPLE_CRUSH_FLOOR_M,
	CRUMPLE_CRUSH_SPEED_CAP_MS,
	CRUMPLE_CRUSH_SPEED_COEF_M,
	CRUMPLE_DENT_EPSILON_M,
	CRUMPLE_FALLOFF_POWER,
	CRUMPLE_JITTER_FRACTION,
	CRUMPLE_MAG_COEF_M_PER_MS,
	CRUMPLE_MAG_SPEED_CAP_MS,
	CRUMPLE_PERF_NEAREST_EXEMPT_COUNT,
	CRUMPLE_PERF_VERTEX_GUARD,
	CRUMPLE_RADIUS0_M,
	CRUMPLE_RADIUS_SPEED_CAP_MS,
	CRUMPLE_RADIUS_SPEED_COEF_M,
	GLASS_SHATTER_THRESHOLD_M,
} from './damage-tuning';

export type DeformableKind = 'chassis' | 'panel' | 'glass';

export interface DeformableMeshHandle {
	readonly id: string;
	readonly kind: DeformableKind;
	readonly vertexCount: number;
	/** Local-space, cached at registration time, immutable forever after (the "rest shape"). */
	readonly basePositions: Float32Array;
	/** Local-space, mutated in place: basePositions + offsets (clamped), what the renderer should
	 * upload each frame something changed. */
	readonly positions: Float32Array;
	/** Recomputed (recomputeNormals()) after every event that touches this mesh; null if `indices`
	 * wasn't supplied (no normal recompute possible/needed). */
	readonly normals: Float32Array | null;
	readonly indices: Uint32Array | null;
	/** Per-vertex ACCUMULATED displacement vector (local space), persistent, clamped to `clampM`
	 * magnitude every time it grows -- this is what "never heals" means: it is only ever added to. */
	readonly offsets: Float32Array;
	/** 0/1 per vertex: has this vertex's offset magnitude ever crossed CRUMPLE_DENT_EPSILON_M? */
	readonly dentedFlags: Uint8Array;
	dentedCount: number;
	/** Local-space bounding-sphere center/radius, for the impact-radius quick-reject + "2 nearest
	 * meshes" perf guard. */
	readonly centerLocal: V3;
	readonly boundsRadius: number;
	readonly clampM: number;
	shattered: boolean;
	/** Which body's local frame this mesh's positions are expressed in -- 'chassis' or a PanelKey
	 * string; purely informational for the caller's `localize` callback (see applyCrumpleEvent()),
	 * crumple.ts itself never reads this. */
	readonly attachedTo: string;
}

function clampMFor(kind: DeformableKind): number {
	return kind === 'chassis' ? CRUMPLE_CLAMP_CHASSIS_M : CRUMPLE_CLAMP_PANEL_GLASS_M;
}

function computeBoundingSphere(basePositions: Float32Array): { center: V3; radius: number } {
	const vertexCount = basePositions.length / 3;
	let cx = 0;
	let cy = 0;
	let cz = 0;
	for (let i = 0; i < vertexCount; i++) {
		cx += basePositions[i * 3];
		cy += basePositions[i * 3 + 1];
		cz += basePositions[i * 3 + 2];
	}
	if (vertexCount > 0) {
		cx /= vertexCount;
		cy /= vertexCount;
		cz /= vertexCount;
	}
	let maxR = 0;
	for (let i = 0; i < vertexCount; i++) {
		const dx = basePositions[i * 3] - cx;
		const dy = basePositions[i * 3 + 1] - cy;
		const dz = basePositions[i * 3 + 2] - cz;
		const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (r > maxR) maxR = r;
	}
	return { center: { x: cx, y: cy, z: cz }, radius: maxR };
}

/** Registers one deformable mesh. `basePositions` is CLONED (the caller's array is never mutated or
 * retained); pass `indices` (a flat triangle list) to enable recomputeNormals(), or null to skip it
 * (e.g. a mesh you never plan to light with per-vertex normals). */
export function registerDeformable(
	id: string,
	kind: DeformableKind,
	attachedTo: string,
	basePositions: Float32Array,
	indices: Uint32Array | Int32Array | null,
): DeformableMeshHandle {
	const vertexCount = basePositions.length / 3;
	const base = basePositions.slice();
	const { center, radius } = computeBoundingSphere(base);
	return {
		id,
		kind,
		attachedTo,
		vertexCount,
		basePositions: base,
		positions: base.slice(),
		normals: indices ? new Float32Array(base.length) : null,
		indices: indices ? Uint32Array.from(indices) : null,
		offsets: new Float32Array(base.length),
		dentedFlags: new Uint8Array(vertexCount),
		dentedCount: 0,
		centerLocal: center,
		boundsRadius: radius,
		clampM: clampMFor(kind),
		shattered: false,
	};
}

// ---------------------------------------------------------------------------------------------
// Deterministic per-vertex jitter -- NO Math.random()/Date.now() anywhere in this module.
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

/** Deterministic per-mesh seed from its string id (FNV-1a), so different meshes don't share identical
 * jitter patterns even though they're all driven by the same vertex-index hash. */
export function stringSeed(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Deterministic pseudo-random value in [0,1) for a given vertex index + mesh seed. */
export function deterministicJitter01(vertexIndex: number, seed: number): number {
	return hash32((vertexIndex * 0x9e3779b1) ^ seed) / 0x1_0000_0000;
}

// ---------------------------------------------------------------------------------------------
// Spatially COHERENT crease noise -- fixed physical wavelength, independent of mesh density.
//
// WHY (user playtest 2026-07-11, S90 swap): the original crease jitter hashed the VERTEX INDEX, so
// its spatial frequency equals the mesh resolution -- believable ~15cm creases on the Mustang's
// coarse panels became per-3cm "grocery bag" foil noise on the S90's 5x-denser metal. Real sheet
// metal folds at a scale set by panel stiffness, not by how finely we happened to tessellate it, so
// the noise must be sampled from the vertex's REST POSITION on a fixed-size lattice: any two nearby
// vertices now share nearly the same crease value regardless of density. Still fully deterministic
// (pure integer hash of quantized position + seed -- damage-determinism.test.mjs's requirement).
// ---------------------------------------------------------------------------------------------

function latticeHash01(ix: number, iy: number, iz: number, seed: number): number {
	let h = seed | 0;
	h = hash32(h ^ Math.imul(ix, 0x8da6b343));
	h = hash32(h ^ Math.imul(iy, 0xd8163841));
	h = hash32(h ^ Math.imul(iz, 0xcb1ab31f));
	return h / 0x1_0000_0000;
}

function smooth01(t: number): number {
	return t * t * (3 - 2 * t);
}

/** Trilinearly-interpolated value noise in [0,1) at rest-position (x,y,z), lattice cell size
 * `wavelengthM` meters. */
function valueNoise01(x: number, y: number, z: number, wavelengthM: number, seed: number): number {
	const fx = x / wavelengthM;
	const fy = y / wavelengthM;
	const fz = z / wavelengthM;
	const ix = Math.floor(fx);
	const iy = Math.floor(fy);
	const iz = Math.floor(fz);
	const tx = smooth01(fx - ix);
	const ty = smooth01(fy - iy);
	const tz = smooth01(fz - iz);
	const c000 = latticeHash01(ix, iy, iz, seed);
	const c100 = latticeHash01(ix + 1, iy, iz, seed);
	const c010 = latticeHash01(ix, iy + 1, iz, seed);
	const c110 = latticeHash01(ix + 1, iy + 1, iz, seed);
	const c001 = latticeHash01(ix, iy, iz + 1, seed);
	const c101 = latticeHash01(ix + 1, iy, iz + 1, seed);
	const c011 = latticeHash01(ix, iy + 1, iz + 1, seed);
	const c111 = latticeHash01(ix + 1, iy + 1, iz + 1, seed);
	const x00 = c000 + (c100 - c000) * tx;
	const x10 = c010 + (c110 - c010) * tx;
	const x01 = c001 + (c101 - c001) * tx;
	const x11 = c011 + (c111 - c011) * tx;
	const y0 = x00 + (x10 - x00) * ty;
	const y1 = x01 + (x11 - x01) * ty;
	return y0 + (y1 - y0) * tz;
}

/** Signed crease noise in [-1,1) at a REST-space point: a broad ~22cm fold octave plus a weaker
 * ~9cm crinkle octave -- the scale mix of struck sheet metal in the user's crash-test references. */
export function coherentCreaseNoise(x: number, y: number, z: number, seed: number): number {
	const n = 0.7 * valueNoise01(x, y, z, 0.22, seed) + 0.3 * valueNoise01(x, y, z, 0.09, seed ^ 0x5bd1e995);
	return n * 2 - 1;
}

/** Spec's "smoothfalloff": 1 at t=0, 0 at t>=1, smoothstep-shaped (C1 continuous). */
export function smoothFalloff(t: number): number {
	const c = t < 0 ? 0 : t > 1 ? 1 : t;
	return 1 - c * c * (3 - 2 * c);
}

// ---------------------------------------------------------------------------------------------
// Per-mesh impact application
// ---------------------------------------------------------------------------------------------

/** Applies one impact (already in this mesh's LOCAL space) to a single mesh: displaces every vertex
 * within the impact radius along -localNormal, accumulates (never heals), clamps per-vertex magnitude,
 * updates dentedCount/shattered. Returns the number of vertices touched (0 if the mesh's bounding
 * sphere doesn't even reach the impact radius -- cheap quick-reject).
 *
 * `massFactor` in (0,1] is the mass-aware attenuation of the crush DEPTH (system.ts computes it from
 * the OTHER body's effective mass ratio e = m_other/(m_other+m_car); static/ground/unknown obstacles
 * pass the default 1.0 -- see system.ts's carDamageMassFactor()). It scales only the per-vertex
 * displacement `mag`, deliberately NOT the impact radius or the quick-reject geometry, so at the
 * default 1.0 EVERY result is bit-for-bit identical to the pre-mass-aware code (x*1.0 is an exact
 * IEEE-754 identity) -- the byte-stable-against-static-obstacles guarantee the mass-aware rollout rests
 * on. A light plank (e~0.002) still "touches" the same vertices but deposits a ~500x shallower dent, so
 * essentially none clear CRUMPLE_DENT_EPSILON_M -> no cosmetic damage, exactly the user's plank case. */
export function applyImpactToMesh(mesh: DeformableMeshHandle, localPoint: V3, localNormal: V3, approachSpeedMs: number, massFactor = 1): number {
	const radius = CRUMPLE_RADIUS0_M + CRUMPLE_RADIUS_SPEED_COEF_M * Math.min(approachSpeedMs, CRUMPLE_RADIUS_SPEED_CAP_MS);

	const dxC = mesh.centerLocal.x - localPoint.x;
	const dyC = mesh.centerLocal.y - localPoint.y;
	const dzC = mesh.centerLocal.z - localPoint.z;
	const centerDist = Math.sqrt(dxC * dxC + dyC * dyC + dzC * dzC);
	if (centerDist > radius + mesh.boundsRadius) return 0;

	const seed = stringSeed(mesh.id);
	const magBase = CRUMPLE_MAG_COEF_M_PER_MS * Math.min(approachSpeedMs, CRUMPLE_MAG_SPEED_CAP_MS);
	// Speed-scaled crush cap for THIS hit: how deep this single (this-speed) contact is allowed to cave
	// a vertex, never above the absolute per-mesh clamp. Applied per-vertex below against the vertex's
	// PRE-hit magnitude so it only ever LIMITS new growth, never shrinks an already-deeper dent (that
	// would "heal" the crumple, violating the never-heals invariant) -- see crush cap logic below.
	const speedCrushCap = Math.min(mesh.clampM, CRUMPLE_CRUSH_FLOOR_M + CRUMPLE_CRUSH_SPEED_COEF_M * Math.min(approachSpeedMs, CRUMPLE_CRUSH_SPEED_CAP_MS));
	const base = mesh.basePositions;
	const pos = mesh.positions;
	const off = mesh.offsets;
	let touched = 0;

	for (let i = 0; i < mesh.vertexCount; i++) {
		const bx = base[i * 3];
		const by = base[i * 3 + 1];
		const bz = base[i * 3 + 2];
		const dx = bx - localPoint.x;
		const dy = by - localPoint.y;
		const dz = bz - localPoint.z;
		const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (dist > radius) continue;
		touched++;

		const t = dist / radius;
		const falloff = Math.pow(smoothFalloff(t), CRUMPLE_FALLOFF_POWER);
		// Coherent (fixed-wavelength) crease noise sampled at the REST position -- see
		// coherentCreaseNoise()'s doc for why per-vertex-index jitter was wrong here.
		const jitterSigned = coherentCreaseNoise(bx, by, bz, seed); // [-1,1)
		// massFactor last: for the default 1.0 this trailing `* 1` is an exact IEEE-754 no-op, so the
		// static-obstacle path stays bit-identical (see this function's doc comment).
		const mag = magBase * falloff * (1 + CRUMPLE_JITTER_FRACTION * jitterSigned) * massFactor;
		if (mag <= 0) continue;

		const px = off[i * 3];
		const py = off[i * 3 + 1];
		const pz = off[i * 3 + 2];
		const prevMag = Math.sqrt(px * px + py * py + pz * pz);
		// Displace ALONG the contact normal (+normal), which for box3d's convention (the normal points
		// from the struck obstacle back toward the car body) caves the surface INWARD -- a real crush.
		// (The prior `- normal` pushed nose vertices toward the wall, i.e. bulged the front OUTWARD on a
		// frontal hit -- geometrically inverted; every damage test only checked displacement MAGNITUDE,
		// never direction, so it went unnoticed. Verified against measured hit normals: a frontal wall
		// reports (0,0,-1), so +normal = -Z = rearward into the car. See crash-deformation-reference.md.)
		let ox = px + localNormal.x * mag;
		let oy = py + localNormal.y * mag;
		let oz = pz + localNormal.z * mag;
		const offMag = Math.sqrt(ox * ox + oy * oy + oz * oz);
		// Effective cap = the greater of what already accumulated and this hit's speed cap (both under
		// the absolute clamp) -- monotonic: a later slow contact can't undo a deep fast dent.
		const effClamp = Math.max(prevMag, speedCrushCap);
		if (offMag > effClamp && offMag > 1e-12) {
			const s = effClamp / offMag;
			ox *= s;
			oy *= s;
			oz *= s;
		}
		off[i * 3] = ox;
		off[i * 3 + 1] = oy;
		off[i * 3 + 2] = oz;
		pos[i * 3] = bx + ox;
		pos[i * 3 + 1] = by + oy;
		pos[i * 3 + 2] = bz + oz;

		const newOffMag = Math.sqrt(ox * ox + oy * oy + oz * oz);
		if (!mesh.dentedFlags[i] && newOffMag > CRUMPLE_DENT_EPSILON_M) {
			mesh.dentedFlags[i] = 1;
			mesh.dentedCount++;
		}
		if (mesh.kind === 'glass' && !mesh.shattered && newOffMag > GLASS_SHATTER_THRESHOLD_M) {
			mesh.shattered = true;
		}
	}
	return touched;
}

/** Recomputes smooth per-vertex normals (face-area-weighted accumulate + normalize) from the current
 * (deformed) positions + the mesh's fixed triangle list. No-op if the mesh has no indices/normals. */
export function recomputeNormals(mesh: DeformableMeshHandle): void {
	if (!mesh.normals || !mesh.indices) return;
	const norm = mesh.normals;
	const idx = mesh.indices;
	const pos = mesh.positions;
	norm.fill(0);
	for (let f = 0; f < idx.length; f += 3) {
		const ia = idx[f];
		const ib = idx[f + 1];
		const ic = idx[f + 2];
		const ax = pos[ia * 3];
		const ay = pos[ia * 3 + 1];
		const az = pos[ia * 3 + 2];
		const bx = pos[ib * 3];
		const by = pos[ib * 3 + 1];
		const bz = pos[ib * 3 + 2];
		const cx = pos[ic * 3];
		const cy = pos[ic * 3 + 1];
		const cz = pos[ic * 3 + 2];
		const e1x = bx - ax;
		const e1y = by - ay;
		const e1z = bz - az;
		const e2x = cx - ax;
		const e2y = cy - ay;
		const e2z = cz - az;
		const nx = e1y * e2z - e1z * e2y;
		const ny = e1z * e2x - e1x * e2z;
		const nz = e1x * e2y - e1y * e2x;
		norm[ia * 3] += nx;
		norm[ia * 3 + 1] += ny;
		norm[ia * 3 + 2] += nz;
		norm[ib * 3] += nx;
		norm[ib * 3 + 1] += ny;
		norm[ib * 3 + 2] += nz;
		norm[ic * 3] += nx;
		norm[ic * 3 + 1] += ny;
		norm[ic * 3 + 2] += nz;
	}
	for (let i = 0; i < mesh.vertexCount; i++) {
		const x = norm[i * 3];
		const y = norm[i * 3 + 1];
		const z = norm[i * 3 + 2];
		const len = Math.sqrt(x * x + y * y + z * z);
		if (len > 1e-12) {
			norm[i * 3] = x / len;
			norm[i * 3 + 1] = y / len;
			norm[i * 3 + 2] = z / len;
		} else {
			norm[i * 3] = 0;
			norm[i * 3 + 1] = 1;
			norm[i * 3 + 2] = 0;
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Registry: the full set of registered deformables + a whole-event driver.
// ---------------------------------------------------------------------------------------------

export interface CrumpleRegistry {
	meshes: DeformableMeshHandle[];
}

export function createCrumpleRegistry(): CrumpleRegistry {
	return { meshes: [] };
}

export function addDeformable(registry: CrumpleRegistry, mesh: DeformableMeshHandle): void {
	registry.meshes.push(mesh);
}

export function getDentedVertexCount(registry: CrumpleRegistry): number {
	let sum = 0;
	for (const m of registry.meshes) sum += m.dentedCount;
	return sum;
}

/** Restores one deformable mesh to its pristine (never-hit) rest shape in place -- positions back to
 * basePositions, offsets/dentedFlags/dentedCount/shattered all cleared, normals recomputed from the
 * now-flat positions. Used by the "R = full car repair" reset (main.ts): the mesh HANDLE OBJECTS
 * themselves are kept (not replaced), since game/src/scene/carDeformables.ts's bindings hold direct
 * references into them -- only their mutable contents are reset, so no re-registration is needed. */
export function resetDeformableMesh(mesh: DeformableMeshHandle): void {
	mesh.positions.set(mesh.basePositions);
	mesh.offsets.fill(0);
	mesh.dentedFlags.fill(0);
	mesh.dentedCount = 0;
	mesh.shattered = false;
	recomputeNormals(mesh);
}

/** Resets every registered mesh (see resetDeformableMesh()) -- call after a full car repair, then
 * sync the result back into the THREE geometries (game/src/scene/carDeformables.ts's
 * syncCarDeformablesToThree()). */
export function resetCrumpleRegistry(registry: CrumpleRegistry): void {
	for (const mesh of registry.meshes) resetDeformableMesh(mesh);
}

export interface LocalImpact {
	point: V3;
	normal: V3;
}

export interface CrumpleEventResult {
	touchedMeshIds: string[];
	shatteredNowMeshIds: string[];
}

/**
 * Applies one qualifying hit event to every candidate registered mesh: `localize(mesh)` converts the
 * (already-known-in-world-space) impact point/normal into THAT mesh's local space (each mesh may be
 * attached to a different body -- chassis vs. a specific panel -- so the caller, which knows the
 * Vehicle/panel bodies, supplies this; crumple.ts itself never touches Body/World). Sorts candidates
 * by distance and applies the spec's perf guard: meshes beyond the 2 nearest are skipped if they have
 * more than CRUMPLE_PERF_VERTEX_GUARD vertices.
 */
export function applyCrumpleEvent(registry: CrumpleRegistry, approachSpeedMs: number, localize: (mesh: DeformableMeshHandle) => LocalImpact, massFactor = 1): CrumpleEventResult {
	const radius = CRUMPLE_RADIUS0_M + CRUMPLE_RADIUS_SPEED_COEF_M * Math.min(approachSpeedMs, CRUMPLE_RADIUS_SPEED_CAP_MS);

	const candidates: { mesh: DeformableMeshHandle; local: LocalImpact; dist: number }[] = [];
	for (const mesh of registry.meshes) {
		const local = localize(mesh);
		const dx = mesh.centerLocal.x - local.point.x;
		const dy = mesh.centerLocal.y - local.point.y;
		const dz = mesh.centerLocal.z - local.point.z;
		const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (dist <= radius + mesh.boundsRadius) candidates.push({ mesh, local, dist });
	}
	candidates.sort((a, b) => a.dist - b.dist);

	const touchedMeshIds: string[] = [];
	const shatteredNowMeshIds: string[] = [];
	candidates.forEach((c, i) => {
		if (i >= CRUMPLE_PERF_NEAREST_EXEMPT_COUNT && c.mesh.vertexCount > CRUMPLE_PERF_VERTEX_GUARD) return;
		const wasShattered = c.mesh.shattered;
		const touched = applyImpactToMesh(c.mesh, c.local.point, c.local.normal, approachSpeedMs, massFactor);
		if (touched > 0) {
			touchedMeshIds.push(c.mesh.id);
			recomputeNormals(c.mesh);
		}
		if (!wasShattered && c.mesh.shattered) shatteredNowMeshIds.push(c.mesh.id);
	});
	return { touchedMeshIds, shatteredNowMeshIds };
}

// ---------------------------------------------------------------------------------------------
// Synthetic grid-plane mesh builder -- used by the headless sim tests (no three.js/GLB available in
// plain node) to stand in for a real shell/panel/glass mesh, and reusable in the browser as a fallback
// if a registered node ever turns out to carry no actual mesh geometry.
// ---------------------------------------------------------------------------------------------

export interface GridPlaneOptions {
	center: V3;
	halfU: number;
	halfV: number;
	axisU: 'x' | 'y' | 'z';
	axisV: 'x' | 'y' | 'z';
	segsU?: number;
	segsV?: number;
}

export function buildGridPlane(opts: GridPlaneOptions): { positions: Float32Array; indices: Uint32Array } {
	const segsU = opts.segsU ?? 6;
	const segsV = opts.segsV ?? 6;
	const positions = new Float32Array((segsU + 1) * (segsV + 1) * 3);
	const indices = new Uint32Array(segsU * segsV * 6);

	let p = 0;
	for (let j = 0; j <= segsV; j++) {
		const v = (j / segsV) * 2 - 1;
		for (let i = 0; i <= segsU; i++) {
			const u = (i / segsU) * 2 - 1;
			const vertex: V3 = { x: opts.center.x, y: opts.center.y, z: opts.center.z };
			vertex[opts.axisU] += u * opts.halfU;
			vertex[opts.axisV] += v * opts.halfV;
			positions[p * 3] = vertex.x;
			positions[p * 3 + 1] = vertex.y;
			positions[p * 3 + 2] = vertex.z;
			p++;
		}
	}
	let ii = 0;
	for (let j = 0; j < segsV; j++) {
		for (let i = 0; i < segsU; i++) {
			const a = j * (segsU + 1) + i;
			const b = a + 1;
			const c = a + (segsU + 1);
			const d = c + 1;
			indices[ii++] = a;
			indices[ii++] = c;
			indices[ii++] = b;
			indices[ii++] = b;
			indices[ii++] = c;
			indices[ii++] = d;
		}
	}
	return { positions, indices };
}
