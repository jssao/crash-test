// SPDX-License-Identifier: MIT
//
// Renderer-free destructible-world physics assembly (G4 spec): stacked-block walls, a crate tower,
// a barrel bowling triangle, tippable poles, and 2 static ramps. No `three` import anywhere in this
// file -- shared verbatim by the browser game (main.ts) and the headless perf-bench harness
// (game/sim/perf-bench.mjs), same convention as game/src/vehicle/vehicle.ts.
//
// Every dynamic body is created, given its shape(s)/mass, then immediately put to sleep
// (Body.setAwake(false)) -- box3d-js's BodyOptions has no "start asleep" flag at creation time (see
// ../../../src/ts/body.ts's BodyOptions), so "spawning asleep" here means create-then-sleep, which is
// observably identical (isAwake() reads false, contributes zero solver work) before the first
// world.step() call ever runs. Verified directly: see the doc comment on createDestructibleWorld().

import { Body, BodyType, Shape, World } from '../../../src/ts/index.js';
import { IDENTITY_Q, type Q4, type V3 } from '../vehicle/mathUtil';
import {
	BARREL_FRICTION,
	BARREL_HEIGHT_M,
	BARREL_LATERAL_SPACING_M,
	BARREL_MASS_KG,
	BARREL_RADIUS_M,
	BARREL_ROW_SPACING_M,
	BARREL_SIDES,
	BARREL_TRIANGLE_APEX,
	type BarrelMaterial,
	CRATE_FRICTION,
	CRATE_GAP_M,
	CRATE_HALF_EXTENT_M,
	CRATE_MASS_KG,
	CRATE_TOWER_CENTER,
	CRATE_TOWER_LAYERS,
	CRATE_TOWER_WIDE_LAYERS,
	POLE_FRICTION,
	POLE_MASS_KG,
	POLE_POSITIONS,
	POLE_SHAFT_HALF_EXTENTS_M,
	RAMP_CONFIGS,
	RAMP_FRICTION,
	WALL_BLOCK_FRICTION,
	WALL_BLOCK_GAP_M,
	WALL_BLOCK_HALF_EXTENTS_M,
	WALL_BLOCK_MASS_MAX_KG,
	WALL_BLOCK_MASS_MIN_KG,
	WALL_COLS,
	WALL_CONFIGS,
	WALL_ROWS,
	type WallMaterial,
} from './tuning';

export type DestructibleKind = 'wallBlock' | 'crate' | 'barrel' | 'pole';
export type DestructibleMaterial = WallMaterial | 'wood' | BarrelMaterial;

/** One dynamic destructible body + everything the visuals layer (game/src/world/visuals.ts) needs to
 * build a matching THREE mesh, without either module depending on the other's internals. */
export interface DestructibleBody {
	readonly kind: DestructibleKind;
	readonly body: Body;
	readonly shapes: readonly Shape[];
	readonly spawnPos: V3;
	readonly spawnRot: Q4;
	readonly material: DestructibleMaterial;
	/** Box half-extents (wallBlock/crate/pole -- see tuning.ts's POLE_SHAFT_HALF_EXTENTS_M note on why
	 * poles are a single uniform box rather than a compound). */
	readonly halfExtents?: V3;
	/** Barrel only. */
	readonly radius?: number;
	readonly height?: number;
	readonly sides?: number;
}

export interface RampBody {
	readonly id: 'kicker' | 'wide';
	readonly body: Body;
	readonly shape: Shape;
	readonly angleDeg: number;
	readonly width: number;
	readonly length: number;
	readonly height: number;
	readonly position: V3;
}

export interface DestructibleWorld {
	readonly bodies: DestructibleBody[];
	readonly ramps: RampBody[];
}

/** Regular n-gon prism point cloud, centered on its own local origin (y in [-h/2, h/2]) -- box3d
 * computes the actual convex hull from these points (Body.createHullShape()), same pattern as
 * vehicle/geometry.ts's buildChassisHullPoints(). */
function ngonPrismPoints(sides: number, radius: number, height: number): Float32Array {
	const pts: number[] = [];
	for (const y of [-height / 2, height / 2]) {
		for (let i = 0; i < sides; i++) {
			const theta = (i / sides) * Math.PI * 2;
			pts.push(radius * Math.cos(theta), y, radius * Math.sin(theta));
		}
	}
	return new Float32Array(pts);
}

/** Exact area of a regular n-gon with circumradius r: (n/2) r^2 sin(2*pi/n). */
function ngonArea(sides: number, radius: number): number {
	return (sides / 2) * radius * radius * Math.sin((2 * Math.PI) / sides);
}

/** Wedge hull points (local space: X lateral, Y up, Z = direction of travel, rising with +Z): a flat
 * bottom rectangle at y=0 plus a raised ridge line at z=length, giving a single inclined ramp face
 * from (z=0,y=0) up to (z=length,y=height) at atan(height/length). Exported so the visuals layer
 * (game/src/world/visuals.ts) can build a ConvexGeometry from the EXACT same point cloud the physics
 * hull uses, guaranteeing the render mesh matches the collision shape precisely. */
export function wedgeHullPoints(width: number, length: number, height: number): Float32Array {
	const hw = width / 2;
	// prettier-ignore
	return new Float32Array([
		-hw, 0, 0,       hw, 0, 0,       hw, 0, length,       -hw, 0, length,
		-hw, height, length,   hw, height, length,
	]);
}

function boxVolume(half: V3): number {
	return 8 * half.x * half.y * half.z;
}

/** Per-kind settle damping (playtest issue #1: "debris keeps spinning/rolling ages after it should
 * settle"). box3d's rollingResistance is spheres/capsules-only (types.h:407) and every legacy
 * destructible here is a box or a convex hull (barrels are 12-gon prisms), so the spin is bled with a
 * body-level angularDamping applied at spawn -- mild enough not to change the crash's scatter, firm
 * enough that freed blocks/crates/poles stop pirouetting within ~1-2s. Masonry/lumber are "high",
 * steel drums "moderate" (a drum legitimately rolls a bit before stopping). LINEAR damping stays tiny
 * so debris still flies on a hard hit. These live here (not world/tuning.ts) because they are behavior
 * this module owns; see game/src/world/features/buildings/tuning.ts for the mirror values on the
 * newer 'buildings' feature and tests/rolling-resistance.test.ts for the mechanism validation. */
const WALL_BLOCK_ANGULAR_DAMPING = 1.6;
const WALL_BLOCK_LINEAR_DAMPING = 0.15;
const CRATE_ANGULAR_DAMPING = 1.3;
const CRATE_LINEAR_DAMPING = 0.08;
const BARREL_ANGULAR_DAMPING = 0.7;
const BARREL_LINEAR_DAMPING = 0.08;
const POLE_ANGULAR_DAMPING = 1.2;
const POLE_LINEAR_DAMPING = 0.08;

/** Creates one dynamic body + its shape(s) at `pos`/rotation, puts it to sleep, and returns the raw
 * Body + Shape handles (caller assembles the DestructibleBody record). `angularDamping`/`linearDamping`
 * default 0 (unchanged from before this playtest fix for any caller that omits them). */
function spawnAsleepBody(world: World, pos: V3, rot: Q4 = IDENTITY_Q, angularDamping = 0, linearDamping = 0): Body {
	const body = world.createBody({ type: BodyType.Dynamic, position: pos, rotation: rot, angularDamping, linearDamping });
	return body;
}

function buildWall(world: World, config: (typeof WALL_CONFIGS)[number]): DestructibleBody[] {
	const out: DestructibleBody[] = [];
	const half = WALL_BLOCK_HALF_EXTENTS_M;
	const stepX = half.x * 2 + WALL_BLOCK_GAP_M;
	const stepY = half.y * 2 + WALL_BLOCK_GAP_M;
	const totalWidth = WALL_COLS * stepX - WALL_BLOCK_GAP_M;
	for (let row = 0; row < WALL_ROWS; row++) {
		const massKg = WALL_BLOCK_MASS_MAX_KG + (WALL_BLOCK_MASS_MIN_KG - WALL_BLOCK_MASS_MAX_KG) * (row / Math.max(1, WALL_ROWS - 1));
		const density = massKg / boxVolume(half);
		const y = half.y + row * stepY;
		for (let col = 0; col < WALL_COLS; col++) {
			const x = config.center.x - totalWidth / 2 + half.x + col * stepX;
			const pos: V3 = { x, y, z: config.center.z };
			const body = spawnAsleepBody(world, pos, IDENTITY_Q, WALL_BLOCK_ANGULAR_DAMPING, WALL_BLOCK_LINEAR_DAMPING);
			const shape = body.createBoxShape({ halfExtents: half, density, friction: WALL_BLOCK_FRICTION });
			body.applyMassFromShapes();
			out.push({ kind: 'wallBlock', body, shapes: [shape], spawnPos: pos, spawnRot: IDENTITY_Q, material: config.material, halfExtents: half });
		}
	}
	return out;
}

function buildCrateTower(world: World): DestructibleBody[] {
	const out: DestructibleBody[] = [];
	const half = CRATE_HALF_EXTENT_M;
	const step = half * 2 + CRATE_GAP_M;
	const density = CRATE_MASS_KG / boxVolume({ x: half, y: half, z: half });
	const halfExtents: V3 = { x: half, y: half, z: half };
	for (let layer = 0; layer < CRATE_TOWER_LAYERS; layer++) {
		const gridSize = layer < CRATE_TOWER_WIDE_LAYERS ? 3 : 2;
		const y = half + layer * step;
		for (let gz = 0; gz < gridSize; gz++) {
			for (let gx = 0; gx < gridSize; gx++) {
				const x = CRATE_TOWER_CENTER.x + (gx - (gridSize - 1) / 2) * step;
				const z = CRATE_TOWER_CENTER.z + (gz - (gridSize - 1) / 2) * step;
				const pos: V3 = { x, y, z };
				const body = spawnAsleepBody(world, pos, IDENTITY_Q, CRATE_ANGULAR_DAMPING, CRATE_LINEAR_DAMPING);
				const shape = body.createBoxShape({ halfExtents, density, friction: CRATE_FRICTION });
				body.applyMassFromShapes();
				out.push({ kind: 'crate', body, shapes: [shape], spawnPos: pos, spawnRot: IDENTITY_Q, material: 'wood', halfExtents });
			}
		}
	}
	return out;
}

function buildBarrelTriangle(world: World): DestructibleBody[] {
	const out: DestructibleBody[] = [];
	const hullPoints = ngonPrismPoints(BARREL_SIDES, BARREL_RADIUS_M, BARREL_HEIGHT_M);
	const volume = ngonArea(BARREL_SIDES, BARREL_RADIUS_M) * BARREL_HEIGHT_M;
	const density = BARREL_MASS_KG / volume;
	const rows = 4;
	let rowIndex = 0;
	for (let row = 0; row < rows; row++) {
		const countInRow = row + 1;
		const z = BARREL_TRIANGLE_APEX.z + row * BARREL_ROW_SPACING_M;
		for (let i = 0; i < countInRow; i++) {
			const x = BARREL_TRIANGLE_APEX.x + (i - (countInRow - 1) / 2) * BARREL_LATERAL_SPACING_M;
			const pos: V3 = { x, y: BARREL_HEIGHT_M / 2, z };
			const body = spawnAsleepBody(world, pos, IDENTITY_Q, BARREL_ANGULAR_DAMPING, BARREL_LINEAR_DAMPING);
			const shape = body.createHullShape(hullPoints, { density, friction: BARREL_FRICTION });
			body.applyMassFromShapes();
			const material: BarrelMaterial = rowIndex % 2 === 0 ? 'barrelBlue' : 'barrelRust';
			out.push({
				kind: 'barrel',
				body,
				shapes: [shape],
				spawnPos: pos,
				spawnRot: IDENTITY_Q,
				material,
				radius: BARREL_RADIUS_M,
				height: BARREL_HEIGHT_M,
				sides: BARREL_SIDES,
			});
			rowIndex++;
		}
	}
	return out;
}

function buildPoles(world: World): DestructibleBody[] {
	const out: DestructibleBody[] = [];
	const half = POLE_SHAFT_HALF_EXTENTS_M;
	const density = POLE_MASS_KG / boxVolume(half);
	for (const groundPos of POLE_POSITIONS) {
		// Box shapes have no off-origin center (see tuning.ts's note above buying POLE_SHAFT_HALF_EXTENTS_M)
		// -- so the BODY's own origin is placed at half-height instead, putting the box's bottom face
		// exactly on the ground (y=0) the same way vehicle.ts's wheel/chassis spawn heights work.
		const pos: V3 = { x: groundPos.x, y: half.y, z: groundPos.z };
		const body = spawnAsleepBody(world, pos, IDENTITY_Q, POLE_ANGULAR_DAMPING, POLE_LINEAR_DAMPING);
		const shape = body.createBoxShape({ halfExtents: half, density, friction: POLE_FRICTION });
		body.applyMassFromShapes();
		out.push({ kind: 'pole', body, shapes: [shape], spawnPos: pos, spawnRot: IDENTITY_Q, material: 'wood', halfExtents: half });
	}
	return out;
}

function buildRamps(world: World): RampBody[] {
	const out: RampBody[] = [];
	for (const cfg of RAMP_CONFIGS) {
		const points = wedgeHullPoints(cfg.width, cfg.length, cfg.height);
		const position: V3 = { x: cfg.centerX, y: 0, z: cfg.backZ };
		const body = world.createBody({ type: BodyType.Static, position, rotation: IDENTITY_Q });
		const shape = body.createHullShape(points, { density: 1, friction: RAMP_FRICTION });
		out.push({ id: cfg.id, body, shape, angleDeg: cfg.angleDeg, width: cfg.width, length: cfg.length, height: cfg.height, position });
	}
	return out;
}

/**
 * Builds the full destructible world: 3 stacked-block walls, a crate tower, a barrel bowling
 * triangle, 5 tippable poles (all dynamic, spawned ASLEEP -- see this module's doc comment), and 2
 * static ramps (kicker + wide). Total dynamic body count is logged by the caller (main.ts/perf-
 * bench.mjs) for the "~110-160 dynamic destructible bodies" spec target.
 */
export function createDestructibleWorld(world: World): DestructibleWorld {
	const bodies: DestructibleBody[] = [];
	for (const wall of WALL_CONFIGS) bodies.push(...buildWall(world, wall));
	bodies.push(...buildCrateTower(world));
	bodies.push(...buildBarrelTriangle(world));
	bodies.push(...buildPoles(world));

	// Spawn asleep: every dynamic body above is fresh (b3DefaultBodyDef() starts awake), so put it to
	// sleep now, before the world has ever stepped -- observably identical to "spawned asleep" (zero
	// solver cost until something wakes it, e.g. the car driving into it or a neighboring body waking
	// it via contact).
	for (const b of bodies) b.body.setAwake(false);

	const ramps = buildRamps(world);
	return { bodies, ramps };
}

/** Teleports every dynamic destructible body back to its spawn pose, zeroes velocity, and re-sleeps
 * it (Shift+R's "world reset" -- see main.ts) -- the spec's "teleport+sleep" alternative to a full
 * destroy+rebuild, chosen here since these bodies never get destroyed/mutated by any other system
 * (unlike the car's panels/wheels), so an in-place teleport is exactly equivalent and far cheaper for
 * ~130+ bodies. */
export function resetDestructibleWorld(world: DestructibleWorld): void {
	for (const b of world.bodies) {
		b.body.setTransform(b.spawnPos, b.spawnRot);
		b.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		b.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		b.body.setAwake(false);
	}
}

/** Full teardown (shapes then bodies, mirroring vehicle.ts's destroyVehicle() ordering so every
 * native handle is explicitly unregistered from the box3d-js live-handle registry -- see
 * ../../../src/ts/registry.ts). Not on the normal Shift+R path (which teleports+sleeps instead, see
 * resetDestructibleWorld()) but kept available for completeness/tests. */
export function destroyDestructibleWorld(world: DestructibleWorld): void {
	for (const b of world.bodies) {
		for (const s of b.shapes) s.destroy(false);
		b.body.destroy();
	}
	for (const r of world.ramps) {
		r.shape.destroy(false);
		r.body.destroy();
	}
}
