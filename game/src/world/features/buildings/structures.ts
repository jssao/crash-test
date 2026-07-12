// SPDX-License-Identifier: MIT
//
// Renderer-free physics assembly for the 'buildings' feature: garden shed, house-corner framed wall,
// free-standing brick wall, and fence lines. No `three` import anywhere in this file -- mirrors
// world/bodies.ts's convention so this module can be imported directly by a headless sim test (see
// game/sim/features-buildings.test.mjs) without dragging in a renderer.
//
// Every dynamic body is created then immediately put to sleep (see world/bodies.ts's doc comment on
// why create-then-sleep is observably identical to "spawn asleep"). Bodies are NEVER destroyed (only
// weld joints are, on break/reset) -- so getTransform() is always safe on any body this feature owns,
// per features/feature.ts's warning #1.

import { Body, World, type Shape } from '../../../../../src/ts/index.js';
import { length, quatFromAxisAngle, type Q4, type V3 } from '../../../vehicle/mathUtil';
import { rebuildWeld, spawnDynamicBox, spawnDynamicCapsuleVertical, spawnStaticBox, weldAt, type SettleDamping, type WeldSpec } from './common';
import {
	DRYWALL_FRACTURE,
	exceedsFracture,
	FENCE_POST_FRACTURE,
	FENCE_RAIL_FRACTURE,
	fractureBoxMember,
	fractureRng,
	fractureSeed,
	fractureSheetMember,
	PLANK_FRACTURE,
	STUD_FRACTURE,
	tryConsumeFractureBudget,
	type FractureBudget,
	type FractureFragment,
	type FractureIdAllocator,
	type FractureThreshold,
} from '../fracture';
import {
	BRICK_ANGULAR_DAMPING,
	BRICK_BREAK_FORCE_N,
	BRICK_BREAK_TORQUE_NM,
	BRICK_FOOTING_BREAK_FORCE_N,
	BRICK_FOOTING_BREAK_TORQUE_NM,
	BRICK_FRICTION,
	BRICK_HALF_EXTENTS,
	BRICK_LINEAR_DAMPING,
	BRICK_MASS_KG,
	BRICK_PROFILE,
	BRICK_RESTITUTION,
	BRICK_WALL_CENTER,
	BRICK_WALL_COLUMNS,
	BRICK_WALL_LENGTH_M,
	BRICK_WALL_ROWS,
	CORNER_DRYWALL_HALF_THICKNESS_M,
	CORNER_DRYWALL_SHEET_WIDTH_M,
	CORNER_PIPE_COUNT,
	CORNER_POINT,
	CORNER_SEGMENT_LENGTH_M,
	CORNER_STUD_HALF_CROSS_M,
	CORNER_STUD_SPACING_M,
	CORNER_WALL_HEIGHT_M,
	DRYWALL_ANGULAR_DAMPING,
	DRYWALL_BREAK_FORCE_N,
	DRYWALL_BREAK_TORQUE_NM,
	DRYWALL_FRICTION,
	DRYWALL_LINEAR_DAMPING,
	DRYWALL_PANEL_MASS_KG,
	DRYWALL_PROFILE,
	DRYWALL_RESTITUTION,
	FENCE_ANGULAR_DAMPING,
	FENCE_BREAK_FORCE_N,
	FENCE_BREAK_TORQUE_NM,
	FENCE_CONFIGS,
	FENCE_FRICTION,
	FENCE_LINEAR_DAMPING,
	FENCE_MASS_KG,
	FENCE_POST_HALF_CROSS_M,
	FENCE_POST_HEIGHT_M,
	FENCE_PROFILE,
	FENCE_RAIL_HALF_DEPTH_M,
	FENCE_RAIL_HALF_HEIGHT_M,
	FENCE_RAIL_HEIGHTS_M,
	FENCE_SPAN_COUNT,
	FENCE_SPAN_LENGTH_M,
	IDENTITY_Q,
	PIPE_ANGULAR_DAMPING,
	PIPE_FRICTION,
	PIPE_HALF_LENGTH_M,
	PIPE_LINEAR_DAMPING,
	PIPE_MASS_KG,
	PIPE_RADIUS_M,
	PIPE_RESTITUTION,
	PIPE_ROLLING_RESISTANCE,
	ROOF_PROFILE,
	SHED_CENTER,
	SHED_DEPTH_M,
	SHED_PLANK_THICKNESS_HALF_M,
	SHED_ROOF_HEIGHT_M,
	SHED_ROOF_PANEL_SPLITS,
	SHED_STUD_HALF_CROSS_M,
	SHED_STUD_SPACING_M,
	SHED_WALL_HEIGHT_M,
	SHED_WIDTH_M,
	WOOD_ANGULAR_DAMPING,
	WOOD_BREAK_FORCE_N,
	WOOD_BREAK_TORQUE_NM,
	WOOD_FRICTION,
	WOOD_LINEAR_DAMPING,
	WOOD_PLANK_MASS_KG,
	WOOD_RESTITUTION,
	WOOD_STUD_MASS_KG,
	WOOD_STUD_PROFILE,
	type FenceConfig,
	type YieldProfile,
} from './tuning';

export type PieceKind = 'stud' | 'plank' | 'roof' | 'drywall' | 'pipe' | 'brick' | 'post' | 'rail' | 'footing';
export type PieceMaterial = 'wood' | 'drywall' | 'brick' | 'pipe';

export interface Piece {
	/** Mutable: a FRACTURED piece's body/shape are destroyed at fracture time and rebuilt fresh by
	 * resetStructure() (the ONE exception to this module's old "bodies are never destroyed" doc --
	 * every read site guards on `fractured` first, preserving feature.ts's warning #1). */
	body: Body;
	shape: Shape;
	readonly kind: PieceKind;
	readonly material: PieceMaterial;
	readonly spawnPos: V3;
	readonly spawnRot: Q4;
	readonly isStatic: boolean;
	/** Box half-extents (all kinds except pipe). */
	readonly half?: V3;
	/** Pipe (capsule) only. */
	readonly capsule?: { halfLength: number; radius: number };
	/** Deterministic entity id (BUILDINGS_PIECE_ENTITY_ID_BASE + per-structure salt + piece ordinal),
	 * tagged onto the body's userData at spawn -- lets the damage system's foreign-mass registry
	 * attenuate car damage from this piece (fracture spec §E), and seeds this piece's fracture RNG. */
	readonly entityId: number;
	/** Spawn parameters kept so resetStructure() can rebuild a fractured piece's body identically. */
	readonly massKg: number;
	readonly friction: number;
	readonly damping: SettleDamping;
	/** True once this piece SNAPPED into fragments (body+shape destroyed, fragments spawned) -- the
	 * fracture feature (docs/loom/d1-fracture-material-spec.md). Cleared by resetStructure()'s rebuild. */
	fractured: boolean;
}

export interface StructureJointRecord {
	spec: WeldSpec;
	joint: ReturnType<World['createWeldJoint']> | null;
	broken: boolean;
	/** Plastic-yield profile for this weld's material (see tuning.ts). */
	profile: YieldProfile;
	/** 'rigid' until the weld first yields, then 'yielded' (softened in place, piece leans/bulges). */
	stage: 'rigid' | 'yielded';
	/** The dynamic piece body released when this weld breaks (bodyA is always the dynamic piece in
	 * every addWeld() call site) -- its velocity is clamped at break-time for impulse-proportional
	 * release. Mutable: re-pointed at the rebuilt body when resetStructure() rebuilds a fractured
	 * piece. */
	pieceBody: Body;
}

/** Per-material contact restitution (bricks/drywall thud, wood clatters, pipe rings) -- masonry and
 * drywall do not bounce; wood/pipe get a little. */
function restitutionFor(material: PieceMaterial): number {
	switch (material) {
		case 'brick':
			return BRICK_RESTITUTION;
		case 'drywall':
			return DRYWALL_RESTITUTION;
		case 'pipe':
			return PIPE_RESTITUTION;
		case 'wood':
			return WOOD_RESTITUTION;
	}
}

/** Per-material settle damping (playtest issue #1) -- see tuning.ts's DEBRIS SETTLE DAMPING block. */
function dampingFor(material: PieceMaterial): SettleDamping {
	switch (material) {
		case 'brick':
			return { angularDamping: BRICK_ANGULAR_DAMPING, linearDamping: BRICK_LINEAR_DAMPING };
		case 'drywall':
			return { angularDamping: DRYWALL_ANGULAR_DAMPING, linearDamping: DRYWALL_LINEAR_DAMPING };
		case 'pipe':
			return { angularDamping: PIPE_ANGULAR_DAMPING, linearDamping: PIPE_LINEAR_DAMPING };
		case 'wood':
			return { angularDamping: WOOD_ANGULAR_DAMPING, linearDamping: WOOD_LINEAR_DAMPING };
	}
}

const FENCE_DAMPING: SettleDamping = { angularDamping: FENCE_ANGULAR_DAMPING, linearDamping: FENCE_LINEAR_DAMPING };

/** Clamp a freed debris body's linear+angular velocity to a per-material cap at the instant its weld
 * breaks -- keeps the release impulse-proportional (debris tumbles a few metres) instead of the
 * baseline's explosive fling (single bricks were flung 60-77m). Direction is preserved; only excess
 * magnitude is trimmed. */
function clampDebrisVelocity(body: Body, capMs: number, capRad: number): void {
	const v = body.getLinearVelocity();
	const s = Math.hypot(v.x, v.y, v.z);
	if (s > capMs) {
		const k = capMs / s;
		body.setLinearVelocity({ x: v.x * k, y: v.y * k, z: v.z * k });
	}
	const w = body.getAngularVelocity();
	const ws = Math.hypot(w.x, w.y, w.z);
	if (ws > capRad) {
		const k = capRad / ws;
		body.setAngularVelocity({ x: w.x * k, y: w.y * k, z: w.z * k });
	}
}

export interface Structure {
	readonly id: string;
	readonly pieces: Piece[];
	readonly joints: StructureJointRecord[];
	/** Per-structure entity-id base (BUILDINGS_PIECE_ENTITY_ID_BASE + a fixed per-structure salt) --
	 * pieces get base + their ordinal, so ids are unique across every structure in one world AND
	 * byte-stable across runs (creation order is deterministic, warning #3). */
	readonly entityIdBase: number;
}

/** Buildings piece entity-id range -- see world/tuning.ts's LEGACY_DESTRUCTIBLE_ENTITY_ID_BASE doc
 * comment for the full cross-codebase range map (47,000,000+ is buildings'). */
export const BUILDINGS_PIECE_ENTITY_ID_BASE = 47_000_000;

/** Fixed per-structure id salts (multiples of 1000 -- every structure has well under 1000 pieces:
 * brick wall is the largest at 161). FENCE_CONFIGS ids get ordinal-derived salts; an id this table
 * doesn't know (a hypothetical future structure) falls back to a high salt from a tiny string hash,
 * still deterministic. */
function structureEntityIdBase(id: string): number {
	const fixed: Record<string, number> = { shed: 0, 'house-corner': 1, 'brick-wall': 2 };
	let ordinal = fixed[id];
	if (ordinal === undefined) {
		const fenceIdx = FENCE_CONFIGS.findIndex((c) => c.id === id);
		if (fenceIdx >= 0) ordinal = 3 + fenceIdx;
		else {
			let h = 0;
			for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
			ordinal = 100 + (h % 900);
		}
	}
	return BUILDINGS_PIECE_ENTITY_ID_BASE + ordinal * 1000;
}

function addBoxPiece(
	structure: Structure,
	world: World,
	pos: V3,
	rot: Q4,
	half: V3,
	massKg: number,
	friction: number,
	kind: PieceKind,
	material: PieceMaterial,
	isStatic: boolean,
	dampingOverride?: SettleDamping,
): Body {
	const damping = dampingOverride ?? dampingFor(material);
	const { body, shape } = isStatic
		? spawnStaticBox(world, pos, rot, half, friction)
		: spawnDynamicBox(world, pos, rot, half, massKg, friction, restitutionFor(material), damping);
	const entityId = structure.entityIdBase + structure.pieces.length;
	if (!isStatic) body.setUserData(entityId); // static footings stay untagged (wall-like, factor 1)
	structure.pieces.push({ body, shape, kind, material, spawnPos: pos, spawnRot: rot, isStatic, half, entityId, massKg, friction, damping, fractured: false });
	return body;
}

function addCapsulePiece(structure: Structure, world: World, pos: V3, halfLength: number, radius: number, massKg: number, friction: number): Body {
	const { body, shape } = spawnDynamicCapsuleVertical(world, pos, halfLength, radius, massKg, friction, restitutionFor('pipe'), dampingFor('pipe'), PIPE_ROLLING_RESISTANCE);
	const entityId = structure.entityIdBase + structure.pieces.length;
	body.setUserData(entityId);
	structure.pieces.push({ body, shape, kind: 'pipe', material: 'pipe', spawnPos: pos, spawnRot: IDENTITY_Q, isStatic: false, capsule: { halfLength, radius }, entityId, massKg, friction, damping: dampingFor('pipe'), fractured: false });
	return body;
}

function addWeld(
	structure: Structure,
	world: World,
	bodyA: Body,
	posA: V3,
	rotA: Q4,
	bodyB: Body,
	posB: V3,
	rotB: Q4,
	anchorWorld: V3,
	forceThresholdN: number,
	torqueThresholdNm: number,
	profile: YieldProfile,
): void {
	const { joint, spec } = weldAt(world, bodyA, posA, rotA, bodyB, posB, rotB, anchorWorld, forceThresholdN, torqueThresholdNm);
	structure.joints.push({ spec, joint, broken: false, profile, stage: 'rigid', pieceBody: bodyA });
}

function evenPositions(start: number, end: number, spacing: number): number[] {
	const n = Math.max(1, Math.round((end - start) / spacing));
	const out: number[] = [];
	for (let i = 0; i <= n; i++) out.push(start + ((end - start) * i) / n);
	return out;
}

// =================================================================================================
// 1) Garden shed
// =================================================================================================

interface WallRun {
	/** World positions of each stud along the wall, plus its fixed cross-axis coordinate. */
	readonly studPos: V3[];
	readonly studBodies: Body[];
}

/** One perimeter wall run: studs (welded to `footing`) + one plank bay panel per gap between studs
 * (welded to the bay's near stud), all at `wallHeight`. `axis` is which world coordinate varies along
 * the wall's length; the other stays fixed at `fixed`. `outward` is the sign (+1/-1) along the
 * fixed-axis direction the plank sits offset toward (the wall's outer face). */
function buildWallRun(
	structure: Structure,
	world: World,
	footing: Body,
	footingPos: V3,
	axis: 'x' | 'z',
	fixed: number,
	start: number,
	end: number,
	wallHeight: number,
	studSpacing: number,
	studHalfCross: number,
	plankThicknessHalf: number,
	outward: 1 | -1,
): WallRun {
	const positions = evenPositions(start, end, studSpacing);
	const studHalf: V3 = { x: studHalfCross, y: wallHeight / 2, z: studHalfCross };
	const studBodies: Body[] = [];
	const studPos: V3[] = [];
	for (const p of positions) {
		const pos: V3 = axis === 'x' ? { x: p, y: wallHeight / 2, z: fixed } : { x: fixed, y: wallHeight / 2, z: p };
		const body = addBoxPiece(structure, world, pos, IDENTITY_Q, studHalf, WOOD_STUD_MASS_KG, WOOD_FRICTION, 'stud', 'wood', false);
		studBodies.push(body);
		studPos.push(pos);
		const anchor: V3 = { x: pos.x, y: 0, z: pos.z };
		addWeld(structure, world, body, pos, IDENTITY_Q, footing, footingPos, IDENTITY_Q, anchor, WOOD_BREAK_FORCE_N, WOOD_BREAK_TORQUE_NM, WOOD_STUD_PROFILE);
	}

	const plankOffset = studHalfCross + plankThicknessHalf;
	for (let i = 0; i < positions.length - 1; i++) {
		const mid = (positions[i] + positions[i + 1]) / 2;
		const bayHalfWidth = (positions[i + 1] - positions[i]) / 2;
		let plankPos: V3;
		let plankHalf: V3;
		if (axis === 'x') {
			plankPos = { x: mid, y: wallHeight / 2, z: fixed + outward * plankOffset };
			plankHalf = { x: bayHalfWidth, y: wallHeight / 2, z: plankThicknessHalf };
		} else {
			plankPos = { x: fixed + outward * plankOffset, y: wallHeight / 2, z: mid };
			plankHalf = { x: plankThicknessHalf, y: wallHeight / 2, z: bayHalfWidth };
		}
		const plankBody = addBoxPiece(structure, world, plankPos, IDENTITY_Q, plankHalf, WOOD_PLANK_MASS_KG, WOOD_FRICTION, 'plank', 'wood', false);
		const stud = studBodies[i];
		const anchor: V3 = axis === 'x' ? { x: positions[i], y: wallHeight / 2, z: fixed } : { x: fixed, y: wallHeight / 2, z: positions[i] };
		addWeld(structure, world, plankBody, plankPos, IDENTITY_Q, stud, studPos[i], IDENTITY_Q, anchor, WOOD_BREAK_FORCE_N, WOOD_BREAK_TORQUE_NM, WOOD_STUD_PROFILE);
	}

	return { studPos, studBodies };
}

export function buildShed(world: World): Structure {
	const structure: Structure = { id: 'shed', pieces: [], joints: [], entityIdBase: structureEntityIdBase('shed') };
	const c = SHED_CENTER;
	const hw = SHED_WIDTH_M / 2;
	const hd = SHED_DEPTH_M / 2;

	const footingHalf: V3 = { x: hw + 0.05, y: 0.1, z: hd + 0.05 };
	const footingPos: V3 = { x: c.x, y: -0.1, z: c.z };
	const footing = addBoxPiece(structure, world, footingPos, IDENTITY_Q, footingHalf, 0, 0.8, 'footing', 'wood', true);

	const zFront = c.z - hd;
	const zBack = c.z + hd;
	const xLeft = c.x - hw;
	const xRight = c.x + hw;

	const front = buildWallRun(structure, world, footing, footingPos, 'x', zFront, xLeft, xRight, SHED_WALL_HEIGHT_M, SHED_STUD_SPACING_M, SHED_STUD_HALF_CROSS_M, SHED_PLANK_THICKNESS_HALF_M, -1);
	const back = buildWallRun(structure, world, footing, footingPos, 'x', zBack, xLeft, xRight, SHED_WALL_HEIGHT_M, SHED_STUD_SPACING_M, SHED_STUD_HALF_CROSS_M, SHED_PLANK_THICKNESS_HALF_M, 1);
	// Side walls: exclude the two corner positions already built by front/back (start+spacing .. end-spacing).
	buildWallRun(structure, world, footing, footingPos, 'z', xLeft, zFront + SHED_STUD_SPACING_M, zBack - SHED_STUD_SPACING_M, SHED_WALL_HEIGHT_M, SHED_STUD_SPACING_M, SHED_STUD_HALF_CROSS_M, SHED_PLANK_THICKNESS_HALF_M, -1);
	buildWallRun(structure, world, footing, footingPos, 'z', xRight, zFront + SHED_STUD_SPACING_M, zBack - SHED_STUD_SPACING_M, SHED_WALL_HEIGHT_M, SHED_STUD_SPACING_M, SHED_STUD_HALF_CROSS_M, SHED_PLANK_THICKNESS_HALF_M, 1);

	// Roof: 2 sloped panel rows (front slope + back slope), each split into SHED_ROOF_PANEL_SPLITS
	// segments along the ridge (X) direction. See this feature's design notes (structures.ts history)
	// for the Rx(pitch) derivation -- both panels sit at the SAME height (wall-top + roofHeight/2) and
	// at the Z midpoint between their wall edge and the ridge; only the sign of the pitch differs.
	const run = hd;
	const rise = SHED_ROOF_HEIGHT_M;
	const slopeLen = Math.hypot(run, rise);
	const pitch = Math.atan2(rise, run);
	const ridgeZ = c.z;
	const roofY = SHED_WALL_HEIGHT_M + rise / 2;
	const segW = SHED_WIDTH_M / SHED_ROOF_PANEL_SPLITS;
	const roofPanelHalf: V3 = { x: segW / 2, y: 0.015, z: slopeLen / 2 };

	function addRoofSlope(zEdge: number, zMid: number, rot: Q4, edgeStuds: WallRun): void {
		for (let i = 0; i < SHED_ROOF_PANEL_SPLITS; i++) {
			const px = xLeft + segW * (i + 0.5);
			const pos: V3 = { x: px, y: roofY, z: zMid };
			const body = addBoxPiece(structure, world, pos, rot, roofPanelHalf, WOOD_PLANK_MASS_KG * 0.6, WOOD_FRICTION, 'roof', 'wood', false);
			// Weld to the nearest wall-top stud on this slope's own wall.
			let nearestIdx = 0;
			let nearestDist = Infinity;
			for (let s = 0; s < edgeStuds.studPos.length; s++) {
				const d = Math.abs(edgeStuds.studPos[s].x - px);
				if (d < nearestDist) {
					nearestDist = d;
					nearestIdx = s;
				}
			}
			const stud = edgeStuds.studBodies[nearestIdx];
			const studPos = edgeStuds.studPos[nearestIdx];
			const anchor: V3 = { x: studPos.x, y: SHED_WALL_HEIGHT_M, z: zEdge };
			addWeld(structure, world, body, pos, rot, stud, studPos, IDENTITY_Q, anchor, WOOD_BREAK_FORCE_N * 0.6, WOOD_BREAK_TORQUE_NM * 0.6, ROOF_PROFILE);
		}
	}

	addRoofSlope(zFront, (zFront + ridgeZ) / 2, quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -pitch), front);
	addRoofSlope(zBack, (ridgeZ + zBack) / 2, quatFromAxisAngle({ x: 1, y: 0, z: 0 }, pitch), back);

	for (const p of structure.pieces) if (!p.isStatic) p.body.setAwake(false);
	return structure;
}

// =================================================================================================
// 2) House corner: 2 framed wall segments (studs + drywall both sides) meeting at a right angle,
// plus 2-3 free-standing vertical pipes in the cavity (unwelded).
// =================================================================================================

function buildCornerSegment(
	structure: Structure,
	world: World,
	footing: Body,
	footingPos: V3,
	axis: 'x' | 'z',
	fixed: number,
	start: number,
	end: number,
): void {
	const positions = evenPositions(start, end, CORNER_STUD_SPACING_M);
	const studHalf: V3 = { x: CORNER_STUD_HALF_CROSS_M, y: CORNER_WALL_HEIGHT_M / 2, z: CORNER_STUD_HALF_CROSS_M };
	const studBodies: Body[] = [];
	const studPos: V3[] = [];
	for (const p of positions) {
		const pos: V3 = axis === 'x' ? { x: p, y: CORNER_WALL_HEIGHT_M / 2, z: fixed } : { x: fixed, y: CORNER_WALL_HEIGHT_M / 2, z: p };
		const body = addBoxPiece(structure, world, pos, IDENTITY_Q, studHalf, WOOD_STUD_MASS_KG, WOOD_FRICTION, 'stud', 'wood', false);
		studBodies.push(body);
		studPos.push(pos);
		addWeld(structure, world, body, pos, IDENTITY_Q, footing, footingPos, IDENTITY_Q, { x: pos.x, y: 0, z: pos.z }, WOOD_BREAK_FORCE_N, WOOD_BREAK_TORQUE_NM, WOOD_STUD_PROFILE);
	}

	// Drywall sheets on both faces, one sheet per ~sheet-width bay, welded to the bay's near stud.
	const sheetHalf: V3 = axis === 'x'
		? { x: CORNER_DRYWALL_SHEET_WIDTH_M / 2, y: CORNER_WALL_HEIGHT_M / 2, z: CORNER_DRYWALL_HALF_THICKNESS_M }
		: { x: CORNER_DRYWALL_HALF_THICKNESS_M, y: CORNER_WALL_HEIGHT_M / 2, z: CORNER_DRYWALL_SHEET_WIDTH_M / 2 };
	const faceOffset = CORNER_STUD_HALF_CROSS_M + CORNER_DRYWALL_HALF_THICKNESS_M;

	for (const side of [-1, 1] as const) {
		let cursor = start;
		while (cursor < end - 1e-6) {
			const sheetLen = Math.min(CORNER_DRYWALL_SHEET_WIDTH_M, end - cursor);
			const mid = cursor + sheetLen / 2;
			const half: V3 = axis === 'x' ? { ...sheetHalf, x: sheetLen / 2 } : { ...sheetHalf, z: sheetLen / 2 };
			const pos: V3 = axis === 'x' ? { x: mid, y: CORNER_WALL_HEIGHT_M / 2, z: fixed + side * faceOffset } : { x: fixed + side * faceOffset, y: CORNER_WALL_HEIGHT_M / 2, z: mid };
			const body = addBoxPiece(structure, world, pos, IDENTITY_Q, half, DRYWALL_PANEL_MASS_KG, DRYWALL_FRICTION, 'drywall', 'drywall', false);
			// Weld to the nearest stud.
			let nearestIdx = 0;
			let nearestDist = Infinity;
			for (let s = 0; s < positions.length; s++) {
				const d = Math.abs(positions[s] - mid);
				if (d < nearestDist) {
					nearestDist = d;
					nearestIdx = s;
				}
			}
			const stud = studBodies[nearestIdx];
			const sPos = studPos[nearestIdx];
			const anchor: V3 = axis === 'x' ? { x: sPos.x, y: CORNER_WALL_HEIGHT_M / 2, z: fixed } : { x: fixed, y: CORNER_WALL_HEIGHT_M / 2, z: sPos.z };
			addWeld(structure, world, body, pos, IDENTITY_Q, stud, sPos, IDENTITY_Q, anchor, DRYWALL_BREAK_FORCE_N, DRYWALL_BREAK_TORQUE_NM, DRYWALL_PROFILE);
			cursor += sheetLen;
		}
	}
}

export function buildHouseCorner(world: World): Structure {
	const structure: Structure = { id: 'house-corner', pieces: [], joints: [], entityIdBase: structureEntityIdBase('house-corner') };
	const cp = CORNER_POINT;
	const footingHalf: V3 = { x: CORNER_SEGMENT_LENGTH_M / 2 + 0.1, y: 0.1, z: CORNER_SEGMENT_LENGTH_M / 2 + 0.1 };
	const footingPos: V3 = { x: cp.x - CORNER_SEGMENT_LENGTH_M / 2, y: -0.1, z: cp.z + CORNER_SEGMENT_LENGTH_M / 2 };
	const footing = addBoxPiece(structure, world, footingPos, IDENTITY_Q, footingHalf, 0, 0.8, 'footing', 'wood', true);

	// "Front" segment: perpendicular to the approach lane (spans X, from the corner back toward -X),
	// the one a car driving +Z from spawn hits first.
	buildCornerSegment(structure, world, footing, footingPos, 'x', cp.z, cp.x - CORNER_SEGMENT_LENGTH_M, cp.x);
	// "Side" segment: parallel to the approach (spans Z, from the corner forward toward +Z).
	buildCornerSegment(structure, world, footing, footingPos, 'z', cp.x, cp.z, cp.z + CORNER_SEGMENT_LENGTH_M);

	// Free-standing vertical pipes in the front segment's cavity -- resting on the ground (unwelded),
	// so they simply sit asleep until the drywall around them breaks and the car (or debris) hits them.
	const pipeXs = evenPositions(cp.x - CORNER_SEGMENT_LENGTH_M + 0.6, cp.x - 0.6, (CORNER_SEGMENT_LENGTH_M - 1.2) / Math.max(1, CORNER_PIPE_COUNT - 1)).slice(0, CORNER_PIPE_COUNT);
	for (const px of pipeXs) {
		addCapsulePiece(structure, world, { x: px, y: PIPE_HALF_LENGTH_M, z: cp.z }, PIPE_HALF_LENGTH_M, PIPE_RADIUS_M, PIPE_MASS_KG, PIPE_FRICTION);
	}

	for (const p of structure.pieces) if (!p.isStatic) p.body.setAwake(false);
	return structure;
}

// =================================================================================================
// 3) Free-standing brick wall: running-bond pattern, weld lattice (horizontal same-row + vertical
// row-to-row nearest-overlap) + brick-to-footing on the bottom row.
// =================================================================================================

export function buildBrickWall(world: World): Structure {
	const structure: Structure = { id: 'brick-wall', pieces: [], joints: [], entityIdBase: structureEntityIdBase('brick-wall') };
	const c = BRICK_WALL_CENTER;
	const half = BRICK_HALF_EXTENTS;
	const wallHalfLen = BRICK_WALL_LENGTH_M / 2;

	const footingHalf: V3 = { x: wallHalfLen + 0.1, y: 0.1, z: half.z + 0.1 };
	const footingPos: V3 = { x: c.x, y: -0.1, z: c.z };
	const footing = addBoxPiece(structure, world, footingPos, IDENTITY_Q, footingHalf, 0, 0.8, 'footing', 'wood', true);

	// rows[r] = the brick bodies + world positions in row r, left to right.
	const rows: { body: Body; pos: V3 }[][] = [];

	for (let r = 0; r < BRICK_WALL_ROWS; r++) {
		const y = half.y + r * half.y * 2;
		// Running-bond offset on odd rows (half a brick width) -- deliberately keeps the SAME column
		// count on every row for simplicity (a real bond tapers with half-bricks at alternating wall
		// ends instead); the visible result is alternate rows overhanging by half a brick on one edge,
		// an accepted simplification (same convention as world/tuning.ts's pole-shaft doc comment).
		const offset = r % 2 === 1 ? half.x : 0;
		const rowBricks: { body: Body; pos: V3 }[] = [];
		for (let col = 0; col < BRICK_WALL_COLUMNS; col++) {
			const x = c.x - wallHalfLen + half.x + col * half.x * 2 + offset;
			const pos: V3 = { x, y, z: c.z };
			const body = addBoxPiece(structure, world, pos, IDENTITY_Q, half, BRICK_MASS_KG, BRICK_FRICTION, 'brick', 'brick', false);
			rowBricks.push({ body, pos });
		}
		// Horizontal (same-row) welds between adjacent bricks.
		for (let col = 0; col < rowBricks.length - 1; col++) {
			const a = rowBricks[col];
			const b = rowBricks[col + 1];
			const anchor: V3 = { x: (a.pos.x + b.pos.x) / 2, y, z: c.z };
			addWeld(structure, world, a.body, a.pos, IDENTITY_Q, b.body, b.pos, IDENTITY_Q, anchor, BRICK_BREAK_FORCE_N, BRICK_BREAK_TORQUE_NM, BRICK_PROFILE);
		}
		// Vertical: weld each brick to its nearest-overlap neighbor in the row below (or the footing
		// for row 0).
		if (r === 0) {
			for (const brick of rowBricks) {
				addWeld(structure, world, brick.body, brick.pos, IDENTITY_Q, footing, footingPos, IDENTITY_Q, { x: brick.pos.x, y: 0, z: c.z }, BRICK_FOOTING_BREAK_FORCE_N, BRICK_FOOTING_BREAK_TORQUE_NM, BRICK_PROFILE);
			}
		} else {
			const below = rows[r - 1];
			for (const brick of rowBricks) {
				let nearestIdx = 0;
				let nearestDist = Infinity;
				for (let i = 0; i < below.length; i++) {
					const d = Math.abs(below[i].pos.x - brick.pos.x);
					if (d < nearestDist) {
						nearestDist = d;
						nearestIdx = i;
					}
				}
				const target = below[nearestIdx];
				const anchor: V3 = { x: (target.pos.x + brick.pos.x) / 2, y: (target.pos.y + brick.pos.y) / 2, z: c.z };
				addWeld(structure, world, brick.body, brick.pos, IDENTITY_Q, target.body, target.pos, IDENTITY_Q, anchor, BRICK_BREAK_FORCE_N, BRICK_BREAK_TORQUE_NM, BRICK_PROFILE);
			}
		}
		rows.push(rowBricks);
	}

	for (const p of structure.pieces) if (!p.isStatic) p.body.setAwake(false);
	return structure;
}

// =================================================================================================
// 4) Fence line: posts + 2 rails per span, welded low-threshold.
// =================================================================================================

export function buildFenceLine(world: World, config: FenceConfig): Structure {
	const structure: Structure = { id: config.id, pieces: [], joints: [], entityIdBase: structureEntityIdBase(config.id) };
	const c = config.center;
	const halfLen = (FENCE_SPAN_COUNT * FENCE_SPAN_LENGTH_M) / 2;

	const footingHalf: V3 = { x: halfLen + 0.1, y: 0.05, z: FENCE_POST_HALF_CROSS_M + 0.05 };
	const footingPos: V3 = { x: c.x, y: -0.05, z: c.z };
	const footing = addBoxPiece(structure, world, footingPos, IDENTITY_Q, footingHalf, 0, 0.8, 'footing', 'wood', true);

	const postHalf: V3 = { x: FENCE_POST_HALF_CROSS_M, y: FENCE_POST_HEIGHT_M / 2, z: FENCE_POST_HALF_CROSS_M };
	const postXs: number[] = [];
	const postBodies: Body[] = [];
	for (let i = 0; i <= FENCE_SPAN_COUNT; i++) {
		const x = c.x - halfLen + i * FENCE_SPAN_LENGTH_M;
		const pos: V3 = { x, y: FENCE_POST_HEIGHT_M / 2, z: c.z };
		const body = addBoxPiece(structure, world, pos, IDENTITY_Q, postHalf, FENCE_MASS_KG, FENCE_FRICTION, 'post', 'wood', false, FENCE_DAMPING);
		postXs.push(x);
		postBodies.push(body);
		addWeld(structure, world, body, pos, IDENTITY_Q, footing, footingPos, IDENTITY_Q, { x, y: 0, z: c.z }, FENCE_BREAK_FORCE_N, FENCE_BREAK_TORQUE_NM, FENCE_PROFILE);
	}

	for (let i = 0; i < FENCE_SPAN_COUNT; i++) {
		const midX = (postXs[i] + postXs[i + 1]) / 2;
		const railHalfLen = FENCE_SPAN_LENGTH_M / 2 - FENCE_POST_HALF_CROSS_M;
		for (const railY of FENCE_RAIL_HEIGHTS_M) {
			const pos: V3 = { x: midX, y: railY, z: c.z };
			const half: V3 = { x: railHalfLen, y: FENCE_RAIL_HALF_HEIGHT_M, z: FENCE_RAIL_HALF_DEPTH_M };
			const body = addBoxPiece(structure, world, pos, IDENTITY_Q, half, FENCE_MASS_KG * 0.6, FENCE_FRICTION, 'rail', 'wood', false, FENCE_DAMPING);
			const post = postBodies[i];
			const postPos: V3 = { x: postXs[i], y: FENCE_POST_HEIGHT_M / 2, z: c.z };
			addWeld(structure, world, body, pos, IDENTITY_Q, post, postPos, IDENTITY_Q, { x: postXs[i], y: railY, z: c.z }, FENCE_BREAK_FORCE_N, FENCE_BREAK_TORQUE_NM, FENCE_PROFILE);
		}
	}

	for (const p of structure.pieces) if (!p.isStatic) p.body.setAwake(false);
	return structure;
}

export function buildAllStructures(world: World): Structure[] {
	const structures: Structure[] = [buildShed(world), buildHouseCorner(world), buildBrickWall(world)];
	for (const cfg of FENCE_CONFIGS) structures.push(buildFenceLine(world, cfg));
	return structures;
}

// =================================================================================================
// FRACTURE (docs/loom/d1-fracture-material-spec.md): thin/long wood + sheet members SNAP into
// fragments in bending BEFORE their own welds pop (§B's "which fails first" column: rail 571N <
// weld 875N effective; stud 386N << 8400N; plank 375N; drywall 29N << 1100N) -- so the fracture
// check runs INSIDE pollStructureBreaks(), per joint record, BEFORE the weld break/yield checks,
// reading the exact same getConstraintForce()/Torque() poll. Opt-in via a StructureFractureContext
// (the browser feature index passes one; legacy sim tests that call pollStructureBreaks(structure)
// bare keep byte-identical weld-pop-primary behavior).
//
// BREAK-PLANE decision (documented per the fracture brief): jittered 45/55 split for rails (spec §C
// simplification -- the rail is a single-end cantilever whose max-moment point is at its ONE weld,
// so the existing weld-force poll is a valid trigger proxy and a jittered near-middle plane reads
// right); base-third split for posts/studs (cantilever max-moment at the footing); jittered
// crack-pattern (3 shards) for plank/drywall sheets. NO impact-point plane is computed -- that
// would need the hit event's position, and the damage system's single-drain invariant
// (game/src/damage/system.ts) makes a second world.hitEvents() drain here a correctness bug; the
// spec explicitly blesses the jittered mid-span simplification instead.
// =================================================================================================

/** One member's fracture, as reported to the caller (the feature index consumes these to hide the
 * parent's mesh + spawn fragment visuals + update the foreign-mass registry). */
export interface PieceFractureEvent {
	readonly structureId: string;
	readonly piece: Piece;
	readonly fragments: FractureFragment[];
}

export interface StructureFractureContext {
	world: World;
	/** Per-step fracture-event budget (fracture.ts) -- the CALLER resets it once per fixed step. */
	budget: FractureBudget;
	idAllocator: FractureIdAllocator;
	/** Caller-advanced sim time (seconds) stamped onto fragments for the age-despawn rule. */
	timeSec: number;
	/** Live fragment store (appended here; the caller owns despawn polling + visuals). */
	fragments: FractureFragment[];
	/** This-call fracture events (appended; caller drains after each poll). */
	events: PieceFractureEvent[];
	/** Hard cap on simultaneously-live fragments (spec §D) -- at the cap, members fall back to the
	 * legacy weld-pop path instead of fracturing. */
	liveFragmentCap: number;
	/** Foreign-mass registry (damage/system.ts's setForeignMass store) -- parent deregistered,
	 * fragments registered, per spec §E. Optional so headless physics tests can skip it. */
	massRegistry?: Map<number, number>;
}

function fractureThresholdFor(kind: PieceKind): FractureThreshold | null {
	switch (kind) {
		case 'rail':
			return FENCE_RAIL_FRACTURE;
		case 'post':
			return FENCE_POST_FRACTURE;
		case 'stud':
			return STUD_FRACTURE;
		case 'plank':
			return PLANK_FRACTURE;
		case 'drywall':
			return DRYWALL_FRACTURE;
		default:
			return null; // brick (breakOnly masonry), roof, pipe, footing: no member fracture (spec §C)
	}
}

/** Fragment release-velocity caps by kind -- reuse the matching yield profile's debris caps. */
function fractureCapsFor(kind: PieceKind): { speed: number; spin: number } {
	if (kind === 'rail' || kind === 'post') return { speed: FENCE_PROFILE.breakSpeedCapMs, spin: FENCE_PROFILE.breakSpinCapRad };
	if (kind === 'drywall') return { speed: DRYWALL_PROFILE.breakSpeedCapMs, spin: DRYWALL_PROFILE.breakSpinCapRad };
	return { speed: WOOD_STUD_PROFILE.breakSpeedCapMs, spin: WOOD_STUD_PROFILE.breakSpinCapRad };
}

function liveFragmentCount(ctx: StructureFractureContext): number {
	let n = 0;
	for (const f of ctx.fragments) if (!f.despawned) n++;
	return n;
}

/** The longest local axis of a box -- rails/posts/studs split across their long axis. */
function longestAxis(half: V3): 'x' | 'y' | 'z' {
	if (half.x >= half.y && half.x >= half.z) return 'x';
	return half.y >= half.z ? 'y' : 'z';
}

/** The thinnest local axis of a box -- a sheet's thickness axis; the other two are its plane. */
function thinnestAxis(half: V3): 'x' | 'y' | 'z' {
	if (half.x <= half.y && half.x <= half.z) return 'x';
	return half.y <= half.z ? 'y' : 'z';
}

/**
 * SNAPS one box piece into fragments: severs EVERY joint attached to the piece's body first (the
 * "sever, then destroy" ordering fracture.ts's module doc requires -- Joint.destroy() force-wakes the
 * attached bodies, so nothing here can trip the sleeping-joint wasm hazard), destroys the piece's
 * shape then body (registry-clean ordering, same as damage/system.ts's panel despawn), then spawns
 * the spec §C fragment plan: 2 boxes (jittered 45/55) for rails, 2 boxes (base-third stub + flyer)
 * for posts/studs, 3 jagged shards for plank/drywall sheets. Returns how many joints it broke.
 */
function fracturePiece(structure: Structure, piece: Piece, forceMag: number, threshold: FractureThreshold, ctx: StructureFractureContext): number {
	let brokeJoints = 0;
	for (const r of structure.joints) {
		if (r.spec.bodyA !== piece.body && r.spec.bodyB !== piece.body) continue;
		if (r.joint) {
			// A neighbour piece freed by this severing gets the same impulse-proportional release clamp
			// the ordinary weld-break path applies.
			if (r.pieceBody !== piece.body) clampDebrisVelocity(r.pieceBody, r.profile.breakSpeedCapMs, r.profile.breakSpinCapRad);
			r.joint.destroy();
			r.joint = null;
		}
		if (!r.broken) {
			r.broken = true;
			brokeJoints++;
		}
	}

	const t = piece.body.getTransform();
	const lv = piece.body.getLinearVelocity();
	const av = piece.body.getAngularVelocity();
	piece.shape.destroy(false);
	piece.body.destroy();
	piece.fractured = true;
	ctx.massRegistry?.delete(piece.entityId);

	const seed = fractureSeed(piece.entityId);
	const caps = fractureCapsFor(piece.kind);
	const half = piece.half!; // every fracturable kind is a box (pipe/capsule kinds return null threshold)
	const common = {
		world: ctx.world,
		position: t.position,
		rotation: t.rotation,
		linearVelocity: lv,
		angularVelocity: av,
		half,
		massKg: piece.massKg,
		friction: piece.friction,
		restitution: restitutionFor(piece.material),
		angularDamping: piece.damping.angularDamping,
		linearDamping: piece.damping.linearDamping,
		forceMag,
		threshold,
		seed,
		timeSec: ctx.timeSec,
		idAllocator: ctx.idAllocator,
		breakSpeedCapMs: caps.speed,
		breakSpinCapRad: caps.spin,
	};

	let fragments: FractureFragment[];
	if (piece.kind === 'plank' || piece.kind === 'drywall') {
		// Sheet: 3 jagged shards across the two in-plane axes.
		const thickness = thinnestAxis(half);
		const axes = (['x', 'y', 'z'] as const).filter((a) => a !== thickness);
		// Height (y) as the V axis when present, so the "lower piece + two upper shards" crack pattern
		// reads right for wall sheets.
		const axisV = axes.includes('y') ? 'y' : axes[1];
		const axisU = axes.find((a) => a !== axisV)!;
		fragments = fractureSheetMember({ ...common, axisU, axisV });
	} else {
		// Beam (rail/post/stud): 2 boxes. Rails split at a jittered 45/55 near-middle plane; uprights
		// (post/stud) split at a jittered base-third plane (short base stub + longer flyer).
		const axis = longestAxis(half);
		const splitRng = fractureRng(seed ^ 0x51e57e1f);
		const fullLen = half[axis] * 2;
		const splitFraction = piece.kind === 'rail' ? 0.45 + splitRng() * 0.1 : 0.28 + splitRng() * 0.14;
		const splitLocalCoord = -half[axis] + fullLen * splitFraction;
		const { neg, pos } = fractureBoxMember({ ...common, axis, splitLocalCoord });
		fragments = [neg, pos];
	}

	for (const f of fragments) {
		ctx.fragments.push(f);
		ctx.massRegistry?.set(f.entityId, f.massKg);
	}
	ctx.events.push({ structureId: structure.id, piece, fragments });
	return brokeJoints;
}

/** Total pieces currently in the fractured (snapped-into-fragments) state. */
export function totalFracturedPieceCount(structures: readonly Structure[]): number {
	let n = 0;
	for (const s of structures) for (const p of s.pieces) if (p.fractured) n++;
	return n;
}

// =================================================================================================
// Reset -- teleport+sleep every piece back to its spawn pose (same "cheap in-place reset" as
// world/bodies.ts's resetDestructibleWorld(), since pieces are never destroyed/mutated in place other
// than their welds), then destroy any surviving joint and rebuild EVERY joint fresh from its stored
// spec (cheaply idempotent: a spec's frames/thresholds never change, so recreating an unbroken joint
// is a harmless no-op besides the handle churn). FRACTURED pieces (body+shape destroyed at fracture
// time) are rebuilt fresh FIRST, and every joint spec referencing the old destroyed body is re-pointed
// at the rebuilt one so the weld-rebuild loop below never touches a dead handle.
// =================================================================================================

export function resetStructure(world: World, structure: Structure): void {
	for (const p of structure.pieces) {
		if (!p.fractured) continue;
		const oldBody = p.body;
		const spawned = spawnDynamicBox(world, p.spawnPos, p.spawnRot, p.half!, p.massKg, p.friction, restitutionFor(p.material), p.damping);
		p.body = spawned.body;
		p.shape = spawned.shape;
		p.body.setUserData(p.entityId);
		p.fractured = false;
		for (const r of structure.joints) {
			if (r.spec.bodyA === oldBody) r.spec.bodyA = p.body;
			if (r.spec.bodyB === oldBody) r.spec.bodyB = p.body;
			if (r.pieceBody === oldBody) r.pieceBody = p.body;
		}
	}
	for (const p of structure.pieces) {
		p.body.setTransform(p.spawnPos, p.spawnRot);
		p.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		p.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		if (!p.isStatic) p.body.setAwake(false);
	}
	for (const record of structure.joints) {
		if (record.joint) {
			// Default wakeAttached=true -- correct here anyway (reset teleports pieces; they
			// re-settle/re-sleep naturally on the next step). The previous destroy(false) was the only
			// call site in the codebase asking box3d not to wake a joint's attached bodies -- a
			// latent vendor solver-set/island bookkeeping hazard on its own terms (see
			// src/ts/joint.ts's Joint.destroy() doc comment + tests/joint-destroy-sleeping.test.ts),
			// even though it was NOT the cause of window.__GAME__.resetWorld()'s reproducing
			// "memory access out of bounds" trap (that one is in
			// game/src/world/features/cardetail/index.ts's destroyAll() -- see this task's report).
			// There was never a reason to ask for the risky flag here regardless.
			record.joint.destroy();
		}
		record.joint = rebuildWeld(world, record.spec);
		record.broken = false;
		record.stage = 'rigid'; // rebuildWeld() restores the rigid (hertz-0) weld; clear the yield state to match
	}

	// Re-sleep AFTER rebuilding welds (playtest issue #6: "shack falls apart on Shift+R"). createWeldJoint
	// wakes its attached bodies, so the sleep in the piece loop above is undone by the joint rebuilds --
	// leaving the whole structure AWAKE at the next step. The wake + first-solve transient in the
	// freshly-rebuilt rigid welds momentarily spikes getConstraintForce() well above the break threshold,
	// so the very next pollStructureBreaks() cracks a cascade of welds and the reset structure collapses
	// on its own with nothing touching it. The original build path (buildShed/etc.) sleeps its pieces
	// AFTER creating all welds for exactly this reason; reset must match. Asleep, the rebuilt welds report
	// ~zero constraint force to the poll and the structure stands until something legitimately wakes it.
	for (const p of structure.pieces) if (!p.isStatic) p.body.setAwake(false);
}

/**
 * Advances the PLASTIC-YIELD -> BREAK state machine for every still-live joint. Call once per fixed
 * step, AFTER world.step() (so getConstraintForce() reflects this step's solve). Exported (rather than
 * kept private to index.ts) so headless sim tests that import this module directly -- skipping the
 * WorldFeature registry entirely, per registry.ts's own doc comment -- still exercise the exact same
 * logic the browser game runs. Returns the number of joints newly broken this call.
 *
 * Per joint, using the constraint force/torque measured on its CURRENT stiffness (generalizes damage/
 * welds.ts's direct-force-spike check -- NOT world.jointEvents(), see index.ts's doc comment):
 *
 *   1. BREAK first. A weld breaks once force/torque exceeds BREAK * ductileBreakMult. Because break is
 *      checked before yield, a hard (fast) hit that spikes a still-RIGID weld straight past the break
 *      line snaps it on the first contact step -> the wall sprays. For ductile materials (studs/posts,
 *      mult > 1) the softened yielded weld rarely climbs back to that raised line, so they stay bent.
 *      The freed piece's release velocity is clamped (impulse-proportional; see clampDebrisVelocity).
 *
 *   2. Else YIELD. A still-RIGID weld whose force/torque crosses the (lower) yield line softens IN
 *      PLACE via the runtime hertz/damping setters (exactly loosenPanelWeld()'s trick) -- the piece
 *      now leans/bulges/creases and bleeds impact energy. A softened weld transmits LESS force to its
 *      neighbours, which is what interrupts the brick-wall cascade at low speed: a slow nudge bulges/
 *      slumps a few courses instead of detonating all 120 bricks.
 */
export function pollStructureBreaks(structure: Structure, fracture?: StructureFractureContext): number {
	let brokenThisCall = 0;

	// ---- 0. MEMBER FRACTURE pre-pass (parallel, independent check -- see this file's FRACTURE
	// section doc). Runs BEFORE the weld break/yield loop off the SAME force/torque poll, because for
	// rails/studs/planks/drywall the derived fracture line sits BELOW the weld-pop line -- the member
	// snaps before its nails pull (spec §B's "which fails first"). Opt-in: no ctx (legacy sim tests)
	// = byte-identical weld-pop-primary behavior.
	//
	// WHY a pre-pass with WEAKEST-THRESHOLD-FIRST ordering + DEFERRAL (measured, throwaway probe): a
	// car-through-fence impact spikes the post's footing weld (~33kN) and the rail's weld (~2.2kN)
	// past their fracture lines on the SAME step. In-loop checking in joint order let the post always
	// win the 1-per-step budget AND -- because fracturing a post severs every joint attached to it,
	// including the rails' -- collaterally freed the rails whole, so a rail could never snap (same
	// story for studs starving the planks in the shed). Sorting this step's candidates by ascending
	// threshold (the weakest MEMBER fails first: drywall < plank < stud < rail < post -- real
	// chain-failure intuition) fractures the rail first; the post, still over-threshold, snaps on the
	// NEXT step. Candidates that lose the budget are DEFERRED (spec §D's "queue extra same-step
	// triggers for the next step(s)"): their weld break/yield is skipped this step so the weld-pop
	// path can't consume the member before its queued fracture fires. Budget: <=1 fracture event per
	// fixed step per feature (spec §D, mirroring refreshPanelHulls' <=1-panel/step rule); at the
	// live-fragment cap, members fall back to weld-pop entirely.
	const deferred = new Set<StructureJointRecord>();
	if (fracture && liveFragmentCount(fracture) < fracture.liveFragmentCap) {
		const candidates: { record: StructureJointRecord; piece: Piece; threshold: FractureThreshold; forceMag: number }[] = [];
		for (const record of structure.joints) {
			if (record.broken || !record.joint) continue;
			const piece = structure.pieces.find((pc) => !pc.isStatic && !pc.fractured && pc.body === record.pieceBody);
			const threshold = piece ? fractureThresholdFor(piece.kind) : null;
			if (!piece || !threshold) continue;
			const forceMag = length(record.joint.getConstraintForce());
			const torqueMag = length(record.joint.getConstraintTorque());
			if (exceedsFracture(forceMag, torqueMag, threshold)) candidates.push({ record, piece, threshold, forceMag });
		}
		candidates.sort((a, b) => a.threshold.forceN - b.threshold.forceN || a.piece.entityId - b.piece.entityId);
		for (const c of candidates) {
			// Re-check liveness: an earlier candidate's fracture may have severed this record already.
			if (c.record.broken || !c.record.joint || c.piece.fractured) continue;
			if (liveFragmentCount(fracture) < fracture.liveFragmentCap && tryConsumeFractureBudget(fracture.budget)) {
				brokenThisCall += fracturePiece(structure, c.piece, c.forceMag, c.threshold, fracture);
			} else {
				deferred.add(c.record); // queued: retry the fracture next step, don't weld-pop it now
			}
		}
	}

	for (const record of structure.joints) {
		if (record.broken || !record.joint) continue;
		if (deferred.has(record)) continue;
		const p = record.profile;
		const forceMag = length(record.joint.getConstraintForce());
		const torqueMag = length(record.joint.getConstraintTorque());

		const breakF = record.spec.forceThresholdN * p.ductileBreakMult;
		const breakT = record.spec.torqueThresholdNm * p.ductileBreakMult;
		if (forceMag > breakF || torqueMag > breakT) {
			clampDebrisVelocity(record.pieceBody, p.breakSpeedCapMs, p.breakSpinCapRad);
			record.joint.destroy();
			record.joint = null;
			record.broken = true;
			brokenThisCall++;
			continue;
		}

		// Break-only (masonry): the weld stays rigid until it cracks -- it never enters the soft yield
		// stage, so the wall cracks crisply in clumps instead of wobbling as a jelly blob (issue #3).
		if (p.breakOnly) continue;

		if (record.stage === 'rigid') {
			const yieldF = record.spec.forceThresholdN * p.yieldForceFrac;
			const yieldT = record.spec.torqueThresholdNm * p.yieldTorqueFrac;
			if (forceMag > yieldF || torqueMag > yieldT) {
				record.joint.setLinearHertz(p.yieldLinearHertz);
				record.joint.setAngularHertz(p.yieldAngularHertz);
				record.joint.setLinearDampingRatio(p.yieldDampingRatio);
				record.joint.setAngularDampingRatio(p.yieldDampingRatio);
				record.stage = 'yielded';
			}
		}
	}
	return brokenThisCall;
}

/** Count of joints currently in the plastic-yielded (bent-but-attached) state -- exposed for the
 * feature's playtest hooks + the destruction-feel test's bend-signature assertions. */
export function totalYieldedJointCount(structures: readonly Structure[]): number {
	let n = 0;
	for (const s of structures) for (const j of s.joints) if (!j.broken && j.stage === 'yielded') n++;
	return n;
}

export function totalPieceCount(structures: readonly Structure[]): number {
	let n = 0;
	for (const s of structures) n += s.pieces.length;
	return n;
}

export function totalBrokenJointCount(structures: readonly Structure[]): number {
	let n = 0;
	for (const s of structures) for (const j of s.joints) if (j.broken) n++;
	return n;
}
