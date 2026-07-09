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
import { rebuildWeld, spawnDynamicBox, spawnDynamicCapsuleVertical, spawnStaticBox, weldAt, type WeldSpec } from './common';
import {
	BRICK_BREAK_FORCE_N,
	BRICK_BREAK_TORQUE_NM,
	BRICK_FRICTION,
	BRICK_HALF_EXTENTS,
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
	DRYWALL_BREAK_FORCE_N,
	DRYWALL_BREAK_TORQUE_NM,
	DRYWALL_FRICTION,
	DRYWALL_PANEL_MASS_KG,
	DRYWALL_PROFILE,
	DRYWALL_RESTITUTION,
	FENCE_BREAK_FORCE_N,
	FENCE_BREAK_TORQUE_NM,
	FENCE_CONFIGS,
	FENCE_FRICTION,
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
	PIPE_FRICTION,
	PIPE_HALF_LENGTH_M,
	PIPE_MASS_KG,
	PIPE_RADIUS_M,
	PIPE_RESTITUTION,
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
	WOOD_BREAK_FORCE_N,
	WOOD_BREAK_TORQUE_NM,
	WOOD_FRICTION,
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
	readonly body: Body;
	readonly shape: Shape;
	readonly kind: PieceKind;
	readonly material: PieceMaterial;
	readonly spawnPos: V3;
	readonly spawnRot: Q4;
	readonly isStatic: boolean;
	/** Box half-extents (all kinds except pipe). */
	readonly half?: V3;
	/** Pipe (capsule) only. */
	readonly capsule?: { halfLength: number; radius: number };
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
	 * release. */
	readonly pieceBody: Body;
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
): Body {
	const { body, shape } = isStatic
		? spawnStaticBox(world, pos, rot, half, friction)
		: spawnDynamicBox(world, pos, rot, half, massKg, friction, restitutionFor(material));
	structure.pieces.push({ body, shape, kind, material, spawnPos: pos, spawnRot: rot, isStatic, half });
	return body;
}

function addCapsulePiece(structure: Structure, world: World, pos: V3, halfLength: number, radius: number, massKg: number, friction: number): Body {
	const { body, shape } = spawnDynamicCapsuleVertical(world, pos, halfLength, radius, massKg, friction, restitutionFor('pipe'));
	structure.pieces.push({ body, shape, kind: 'pipe', material: 'pipe', spawnPos: pos, spawnRot: IDENTITY_Q, isStatic: false, capsule: { halfLength, radius } });
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
	const structure: Structure = { id: 'shed', pieces: [], joints: [] };
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
	const structure: Structure = { id: 'house-corner', pieces: [], joints: [] };
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
	const structure: Structure = { id: 'brick-wall', pieces: [], joints: [] };
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
				addWeld(structure, world, brick.body, brick.pos, IDENTITY_Q, footing, footingPos, IDENTITY_Q, { x: brick.pos.x, y: 0, z: c.z }, BRICK_BREAK_FORCE_N, BRICK_BREAK_TORQUE_NM, BRICK_PROFILE);
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
	const structure: Structure = { id: config.id, pieces: [], joints: [] };
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
		const body = addBoxPiece(structure, world, pos, IDENTITY_Q, postHalf, FENCE_MASS_KG, FENCE_FRICTION, 'post', 'wood', false);
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
			const body = addBoxPiece(structure, world, pos, IDENTITY_Q, half, FENCE_MASS_KG * 0.6, FENCE_FRICTION, 'rail', 'wood', false);
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
// Reset -- teleport+sleep every piece back to its spawn pose (same "cheap in-place reset" as
// world/bodies.ts's resetDestructibleWorld(), since pieces are never destroyed/mutated in place other
// than their welds), then destroy any surviving joint and rebuild EVERY joint fresh from its stored
// spec (cheaply idempotent: a spec's frames/thresholds never change, so recreating an unbroken joint
// is a harmless no-op besides the handle churn).
// =================================================================================================

export function resetStructure(world: World, structure: Structure): void {
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
export function pollStructureBreaks(structure: Structure): number {
	let brokenThisCall = 0;
	for (const record of structure.joints) {
		if (record.broken || !record.joint) continue;
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
