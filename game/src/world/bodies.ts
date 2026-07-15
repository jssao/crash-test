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

import { Body, BodyType, Shape, WeldJoint, World } from '../../../src/ts/index.js';
import { IDENTITY_Q, type Q4, type V3 } from '../vehicle/mathUtil';
import {
	createFractureBudget,
	createFractureIdAllocator,
	fractureBoxMember,
	fractureCapsuleTrunk,
	fractureSeed,
	FRACTURE_FRAGMENT_ENTITY_ID_BASE,
	resetFractureBudget,
	tryConsumeFractureBudget,
	type FractureBudget,
	type FractureFragment,
	type FractureIdAllocator,
} from './features/fracture';
import {
	BARREL_CHAIN_FUSE_MAX_S,
	BARREL_CHAIN_FUSE_MIN_S,
	BARREL_CHAIN_RADIUS_M,
	BARREL_ENTITY_ID_BASE,
	BARREL_EXPLOSION_FALLOFF_M,
	BARREL_EXPLOSION_IMPULSE_PER_AREA,
	BARREL_EXPLOSION_RADIUS_M,
	BARREL_EXPLOSION_SEED,
	BARREL_EXPLOSION_TRIGGER_IMPULSE_KGMS,
	BARREL_FRICTION,
	BARREL_HEIGHT_M,
	BARREL_LATERAL_SPACING_M,
	BARREL_MASS_KG,
	BARREL_MASS_KG_BY_MATERIAL,
	BARREL_RADIUS_M,
	BARREL_ROCKET_JITTER_SPEED_MS,
	BARREL_ROCKET_UPWARD_SPEED_MS,
	BARREL_ROW_SPACING_M,
	BARREL_SIDES,
	BARREL_TRIANGLE_APEX,
	type BarrelMaterial,
	CRATE_ENTITY_ID_BASE,
	CRATE_FRACTURE_AXIS,
	CRATE_FRACTURE_THRESHOLD,
	CRATE_FRACTURE_TRIGGER_IMPULSE_KGMS,
	CRATE_FRAGMENT_SPEED_CAP_MS,
	CRATE_FRAGMENT_SPIN_CAP_RAD,
	CRATE_FRICTION,
	CRATE_GAP_M,
	CRATE_HALF_EXTENT_M,
	CRATE_MASS_KG,
	CRATE_TOWER_CENTER,
	CRATE_TOWER_LAYERS,
	CRATE_TOWER_WIDE_LAYERS,
	LEGACY_DESTRUCTIBLE_ENTITY_ID_BASE,
	POLE_ENTITY_ID_BASE,
	POLE_FORCE_THRESHOLD_N,
	POLE_FRACTURE_THRESHOLD,
	POLE_FRAGMENT_SPEED_CAP_MS,
	POLE_FRAGMENT_SPIN_CAP_RAD,
	POLE_FRICTION,
	POLE_HEIGHT_M,
	POLE_MASS_KG,
	POLE_POSITIONS,
	POLE_SHAFT_RADIUS_M,
	POLE_STUMP_FRACTION,
	POLE_TORQUE_THRESHOLD_NM,
	POLE_WELD_ANGULAR_HERTZ,
	POLE_WELD_DAMPING_RATIO,
	POLE_WELD_LINEAR_HERTZ,
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
export type DestructibleMaterial = WallMaterial | 'wood' | 'poleWood' | BarrelMaterial;

/** One dynamic destructible body + everything the visuals layer (game/src/world/visuals.ts) needs to
 * build a matching THREE mesh, without either module depending on the other's internals. `body` is
 * mutable (NOT readonly, unlike the other fields): a crate/pole's mirrored entry here gets its `.body`
 * re-pointed at whichever piece is currently "the live thing to render/sample" once it fractures (a
 * flying pole-top piece, or the first of a crate's splinter fragments) -- same "destroy + alias to the
 * replacement" convention as world/features/trees/bodies.ts's MidTree.trunk. */
export interface DestructibleBody {
	readonly kind: DestructibleKind;
	body: Body;
	readonly shapes: readonly Shape[];
	readonly spawnPos: V3;
	readonly spawnRot: Q4;
	readonly material: DestructibleMaterial;
	/** Box half-extents (wallBlock/crate). */
	readonly halfExtents?: V3;
	/** Barrel (prism) / pole (capsule shaft) only. */
	readonly radius?: number;
	readonly height?: number;
	/** Barrel only. */
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
	/** Down-slope length on the exit side (0 = the original sheer knife-edge drop) -- see
	 * wedgeHullPoints()'s doc comment. Carried on the record (not just used locally in buildRamps())
	 * so visuals.ts's buildRampMesh() can build the EXACT same point cloud the physics hull uses. */
	readonly backSlopeLength: number;
}

export interface DestructibleWorld {
	readonly bodies: DestructibleBody[];
	readonly ramps: RampBody[];
	/** Exploding-barrels bookkeeping (see ExplodingBarrelsState/stepExplodingBarrels() below) -- lives
	 * here (not a separate object main.ts has to thread through separately) so the SAME
	 * resetDestructibleWorld(destructibleWorld) call the Shift+R world-reset path already makes also
	 * resets this feature's exploded/fuse/RNG state, with no extra call site needed. */
	readonly explodingBarrels: ExplodingBarrelsState;
	/** P009 fix -- one PoleProp per POLE_POSITIONS entry (anchor + welded capsule shaft + fracture
	 * state), each mirrored 1:1 into `bodies` (see PoleProp.mirror doc comment). */
	readonly poles: PoleProp[];
	/** P011 fix -- one CrateProp per crate-tower box, mirrored 1:1 into `bodies` (see CrateProp.mirror
	 * doc comment), plus an entityId lookup for the per-step hitEvents drain. */
	readonly crates: CrateProp[];
	readonly crateByEntityId: ReadonlyMap<number, CrateProp>;
	readonly poleFracture: PropFractureContext;
	readonly crateFracture: PropFractureContext;
	/** The box3d World this destructible world was built in, and the caller's foreign-mass registry
	 * (null if built headless without one) -- stored so resetDestructibleWorld()/
	 * destroyDestructibleWorld() (which only ever received a DestructibleWorld, never a separate World
	 * param, and main.ts/every sim test already calls them that way) can rebuild a fractured pole/crate
	 * in place without needing either signature to change. */
	readonly world: World;
	readonly massRegistry: Map<number, number> | null;
}

// =================================================================================================
// Shared fracture-context plumbing for the pole (P009) and crate (P011) fixes below -- same shape as
// world/features/trees/bodies.ts's TreesFractureContext, reimplemented independently in this file (per
// this run's file ownership: trees/* is not touched) since both fixes reuse the SAME shared primitives
// (world/features/fracture.ts's fractureCapsuleTrunk/fractureBoxMember, imported only).
// =================================================================================================
export interface PropFractureContext {
	world: World;
	/** Per-step fracture budget (<=1 event/step) -- reset once per fixed step by stepDestructiblePoles()/
	 * stepDestructibleCrates() below (each fix owns its OWN budget instance, so a pole snap and a crate
	 * splinter can both happen in the same step). */
	budget: FractureBudget;
	idAllocator: FractureIdAllocator;
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

/** Wedge/roof hull points (local space: X lateral, Y up, Z = direction of travel, rising with +Z): a
 * flat bottom rectangle at y=0 plus a raised ridge at z=upLength, giving an inclined UP face from
 * (z=0,y=0) to (z=upLength,y=height) at atan(height/upLength), THEN (if `downLength` > 0) a second
 * inclined DOWN face back to the ground at z=upLength+downLength -- a continuous "roof" rather than a
 * knife-edge ridge with a sheer drop. `downLength` defaults to 0 (backward compatible with every
 * existing caller / the original knife-edge wedge -- with downLength=0 the "down face" collapses to a
 * zero-width vertical drop at z=upLength, byte-identical to the original 6-point wedge). Exported so
 * the visuals layer (game/src/world/visuals.ts) can build a ConvexGeometry from the EXACT same point
 * cloud the physics hull uses, guaranteeing the render mesh matches the collision shape precisely.
 *
 * KICKER-BEACHING FIX HISTORY (tuning.ts's KICKER_ANGLE_DEG/KICKER_BACK_SLOPE_LENGTH_M doc comment has
 * the full measurement writeup): the `downLength` roof shape here was explored as a candidate fix (a
 * knife-edge ridge with nothing supporting a short-of-launch-speed wheel is a real hazard -- box3d has
 * no stable contact normal there, and vehicle.ts's updateGroundAuthority() cuts drive-torque to ~0 the
 * instant <3 wheels are grounded, so a car straddling that edge has NO way to power itself out). Measured
 * in the real browser build, though, a roof down-slope did NOT fix the kicker's actual stall rate on its
 * own (still ~60-70% at the original 30deg angle) and it interferes with a genuinely-airborne car's free
 * flight (a low/slow launch can clip the down-slope mid-arc). The fix that actually shipped is gentling
 * the up-face angle itself (tuning.ts) -- `downLength` is kept here as inert, available infrastructure
 * (both ramps currently pass 0) in case a future ramp genuinely wants a supported back-slope, not because
 * the kicker needs it today. */
export function wedgeHullPoints(width: number, upLength: number, height: number, downLength = 0): Float32Array {
	const hw = width / 2;
	const backZ = upLength + downLength;
	// prettier-ignore
	return new Float32Array([
		-hw, 0, 0,       hw, 0, 0,       hw, 0, backZ,       -hw, 0, backZ,
		-hw, height, upLength,   hw, height, upLength,
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

/** Volume of a capsule (cylinder + 2 hemispherical caps), given the two end-cap centers' separation
 * (NOT the overall length -- the hemispheres add `radius` beyond each center). Same formula as world/
 * features/trees/bodies.ts's own private capsuleVolume() -- small-helper duplication, not a shared
 * import, matching this codebase's established convention (see this file's own header doc comment on
 * why it shares no code with visuals.ts). */
function capsuleVolume(radius: number, capToCapLength: number): number {
	return Math.PI * radius * radius * capToCapLength + (4 / 3) * Math.PI * radius ** 3;
}

// =================================================================================================
// P011 FIX -- wooden crate tower: was a stack of monolithic 15kg boxes with no break/fracture path at
// all (bug: "wooden crates should splinter/break apart on impact; currently monolithic boxes"). Each
// crate is now a CrateProp (a plain free box, same as before, PLUS fracture bookkeeping): a world.
// hitEvents() read (checkCrateHitTrigger()/stepCrateFractures() below -- same "approachSpeed * this
// body's own mass" trigger technique as this file's existing checkHitEntityForBarrelTrigger()) fires
// fractureBoxMember() (world/features/fracture.ts, called as-is) once a hit is hard enough, splitting
// the crate into 2 plank-like fragments that scatter under the impact's own kick velocity. A gentle
// bump (or the tower's own inter-crate settle contacts) stays well under CRATE_FRACTURE_TRIGGER_IMPULSE_
// KGMS, so the tower still shoves/topples as a whole at low speed, exactly like before this fix.
// =================================================================================================

export interface CrateProp {
	readonly entityId: number;
	readonly spawnPos: V3;
	/** The intact crate box, OR (post-fracture) an alias to fragments[0]'s body -- kept always-live so
	 * any generic reader (this file's own resetDestructibleWorld()/destroyDestructibleWorld(), or a
	 * future main.ts diagnostic) never dereferences a destroyed handle. */
	body: Body;
	shape: Shape;
	fractured: boolean;
	/** The 2 splinter fragments, populated once fractured (spec: "2-4 plank-like pieces" -- 2 chosen
	 * for robustness, a single fractureBoxMember() split; see tuning.ts's CRATE_FRACTURE_AXIS doc). */
	fragments: FractureFragment[];
	/** Mirrored createDestructibleWorld() bodies[] entry this crate keeps `.body` aliased to -- null for
	 * standalone callers (crash lab / sim tests) that read this record directly. */
	mirror: DestructibleBody | null;
}

function buildCrateBox(world: World, pos: V3): { body: Body; shape: Shape } {
	const half: V3 = { x: CRATE_HALF_EXTENT_M, y: CRATE_HALF_EXTENT_M, z: CRATE_HALF_EXTENT_M };
	const density = CRATE_MASS_KG / boxVolume(half);
	const body = spawnAsleepBody(world, pos, IDENTITY_Q, CRATE_ANGULAR_DAMPING, CRATE_LINEAR_DAMPING);
	const shape = body.createBoxShape({ halfExtents: half, density, friction: CRATE_FRICTION });
	body.applyMassFromShapes();
	return { body, shape };
}

/** Builds ONE crate for standalone callers (crash lab / sim tests) -- no mirrored bodies[] entry. See
 * buildCrateTower() for the multi-instance variant createDestructibleWorld() uses. */
export function buildCrateProp(world: World, pos: V3, entityId: number): CrateProp {
	const { body, shape } = buildCrateBox(world, pos);
	body.setUserData(entityId);
	body.setAwake(false);
	return { entityId, spawnPos: pos, body, shape, fractured: false, fragments: [], mirror: null };
}

function fractureCrate(c: CrateProp, forceMag: number, ctx: PropFractureContext, massRegistry: Map<number, number> | null): void {
	if (c.fractured) return;
	const t = c.body.getTransform();
	const lv = c.body.getLinearVelocity();
	const av = c.body.getAngularVelocity();
	const half: V3 = { x: CRATE_HALF_EXTENT_M, y: CRATE_HALF_EXTENT_M, z: CRATE_HALF_EXTENT_M };
	c.shape.destroy(false);
	c.body.destroy();
	massRegistry?.delete(c.entityId);

	const { neg, pos } = fractureBoxMember({
		world: ctx.world,
		position: t.position,
		rotation: t.rotation,
		linearVelocity: lv,
		angularVelocity: av,
		half,
		axis: CRATE_FRACTURE_AXIS,
		splitLocalCoord: 0,
		massKg: CRATE_MASS_KG,
		friction: CRATE_FRICTION,
		restitution: 0,
		angularDamping: CRATE_ANGULAR_DAMPING,
		linearDamping: CRATE_LINEAR_DAMPING,
		forceMag,
		threshold: CRATE_FRACTURE_THRESHOLD,
		seed: fractureSeed(c.entityId),
		timeSec: 0,
		idAllocator: ctx.idAllocator,
		breakSpeedCapMs: CRATE_FRAGMENT_SPEED_CAP_MS,
		breakSpinCapRad: CRATE_FRAGMENT_SPIN_CAP_RAD,
	});

	c.fragments = [neg, pos];
	c.fractured = true;
	c.body = neg.body;
	c.shape = neg.shape;
	if (c.mirror) c.mirror.body = neg.body;
	massRegistry?.set(neg.entityId, neg.massKg);
	massRegistry?.set(pos.entityId, pos.massKg);
}

function checkCrateHitTrigger(crate: CrateProp, ctx: PropFractureContext, approachSpeed: number, massRegistry: Map<number, number> | null): void {
	if (crate.fractured) return;
	const massKg = crate.body.getMass();
	const impulseLike = approachSpeed * massKg;
	if (impulseLike >= CRATE_FRACTURE_TRIGGER_IMPULSE_KGMS && tryConsumeFractureBudget(ctx.budget)) {
		fractureCrate(crate, impulseLike, ctx, massRegistry);
	}
}

/** Drains world.hitEvents() for crate impacts hard enough to splinter (tuning.ts's
 * CRATE_FRACTURE_TRIGGER_IMPULSE_KGMS) -- call once per fixed step, AFTER world.step(). Exported for
 * standalone callers (crash lab / sim tests); createDestructibleWorld() users should prefer
 * stepDestructibleCrates() below (handles the budget reset too). */
export function stepCrateFractures(world: World, crateByEntityId: ReadonlyMap<number, CrateProp>, ctx: PropFractureContext, massRegistry: Map<number, number> | null): void {
	const hits = world.hitEvents();
	for (let i = 0; i < hits.count; i++) {
		const ev = hits.at(i);
		const a = crateByEntityId.get(ev.userDataA);
		if (a) checkCrateHitTrigger(a, ctx, ev.approachSpeed, massRegistry);
		const b = crateByEntityId.get(ev.userDataB);
		if (b) checkCrateHitTrigger(b, ctx, ev.approachSpeed, massRegistry);
	}
}

/** Idempotent single-crate reset (Shift+R): rebuilds a fresh intact box if fractured, else just
 * teleports+resleeps -- same shape as trees/bodies.ts's resetMid(). */
export function resetCrateProp(world: World, c: CrateProp, massRegistry: Map<number, number> | null): void {
	if (c.fractured) {
		for (const f of c.fragments) {
			f.shape.destroy(false);
			f.body.destroy();
			massRegistry?.delete(f.entityId);
		}
		c.fragments = [];
		c.fractured = false;
		massRegistry?.set(c.entityId, CRATE_MASS_KG);
		const { body, shape } = buildCrateBox(world, c.spawnPos);
		body.setUserData(c.entityId);
		c.body = body;
		c.shape = shape;
		if (c.mirror) c.mirror.body = body;
	} else {
		c.body.setTransform(c.spawnPos, IDENTITY_Q);
		c.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		c.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
	}
	c.body.setAwake(false);
}

/** Full teardown of one crate (its shape+body, or its live fragments if fractured). */
export function destroyCrateProp(c: CrateProp, massRegistry: Map<number, number> | null): void {
	massRegistry?.delete(c.entityId);
	if (c.fractured) {
		for (const f of c.fragments) {
			massRegistry?.delete(f.entityId);
			try {
				f.shape.destroy(false);
			} catch {
				/* already freed */
			}
			try {
				f.body.destroy();
			} catch {
				/* already freed */
			}
		}
	} else {
		try {
			c.shape.destroy(false);
		} catch {
			/* already freed */
		}
		try {
			c.body.destroy();
		} catch {
			/* already freed */
		}
	}
}

function buildCrateTower(world: World): { bodies: DestructibleBody[]; crates: CrateProp[] } {
	const bodiesOut: DestructibleBody[] = [];
	const crates: CrateProp[] = [];
	const half = CRATE_HALF_EXTENT_M;
	const step = half * 2 + CRATE_GAP_M;
	const halfExtents: V3 = { x: half, y: half, z: half };
	let index = 0;
	for (let layer = 0; layer < CRATE_TOWER_LAYERS; layer++) {
		const gridSize = layer < CRATE_TOWER_WIDE_LAYERS ? 3 : 2;
		const y = half + layer * step;
		for (let gz = 0; gz < gridSize; gz++) {
			for (let gx = 0; gx < gridSize; gx++) {
				const x = CRATE_TOWER_CENTER.x + (gx - (gridSize - 1) / 2) * step;
				const z = CRATE_TOWER_CENTER.z + (gz - (gridSize - 1) / 2) * step;
				const pos: V3 = { x, y, z };
				const entityId = CRATE_ENTITY_ID_BASE + index;
				const { body, shape } = buildCrateBox(world, pos);
				body.setUserData(entityId);
				const mirror: DestructibleBody = { kind: 'crate', body, shapes: [shape], spawnPos: pos, spawnRot: IDENTITY_Q, material: 'wood', halfExtents };
				bodiesOut.push(mirror);
				crates.push({ entityId, spawnPos: pos, body, shape, fractured: false, fragments: [], mirror });
				index++;
			}
		}
	}
	return { bodies: bodiesOut, crates };
}

/** Builds ONE free barrel (no triangle) for standalone callers (sim tests exercising a single variant
 * in isolation, or a future single-barrel lab target) -- P010's full/empty mass variant, the SAME
 * 12-gon hull buildBarrelTriangle() below uses. */
export function buildBarrel(world: World, pos: V3, variant: BarrelMaterial, entityId: number): Body {
	const hullPoints = ngonPrismPoints(BARREL_SIDES, BARREL_RADIUS_M, BARREL_HEIGHT_M);
	const massKg = BARREL_MASS_KG_BY_MATERIAL[variant];
	const density = massKg / (ngonArea(BARREL_SIDES, BARREL_RADIUS_M) * BARREL_HEIGHT_M);
	const body = spawnAsleepBody(world, pos, IDENTITY_Q, BARREL_ANGULAR_DAMPING, BARREL_LINEAR_DAMPING);
	body.createHullShape(hullPoints, { density, friction: BARREL_FRICTION });
	body.applyMassFromShapes();
	body.setUserData(entityId);
	return body;
}

function buildBarrelTriangle(world: World): DestructibleBody[] {
	const out: DestructibleBody[] = [];
	const hullPoints = ngonPrismPoints(BARREL_SIDES, BARREL_RADIUS_M, BARREL_HEIGHT_M);
	const volume = ngonArea(BARREL_SIDES, BARREL_RADIUS_M) * BARREL_HEIGHT_M;
	const rows = 4;
	let rowIndex = 0;
	for (let row = 0; row < rows; row++) {
		const countInRow = row + 1;
		const z = BARREL_TRIANGLE_APEX.z + row * BARREL_ROW_SPACING_M;
		for (let i = 0; i < countInRow; i++) {
			const x = BARREL_TRIANGLE_APEX.x + (i - (countInRow - 1) / 2) * BARREL_LATERAL_SPACING_M;
			const pos: V3 = { x, y: BARREL_HEIGHT_M / 2, z };
			// P010 FIX ("metal barrels don't deform when hit; want full-of-fluid vs empty variants with
			// different mass"): mass now depends on the barrel's own MATERIAL (blue=full/~200kg,
			// rust=empty/~20kg -- tuning.ts's BARREL_MASS_KG_BY_MATERIAL), not one flat 25kg for every
			// barrel. Material assignment is unchanged (alternating by triangle index).
			const material: BarrelMaterial = rowIndex % 2 === 0 ? 'barrelBlue' : 'barrelRust';
			const massKg = BARREL_MASS_KG_BY_MATERIAL[material];
			const density = massKg / volume;
			const body = spawnAsleepBody(world, pos, IDENTITY_Q, BARREL_ANGULAR_DAMPING, BARREL_LINEAR_DAMPING);
			const shape = body.createHullShape(hullPoints, { density, friction: BARREL_FRICTION });
			body.applyMassFromShapes();
			// Exploding-barrels feature (tuning.ts's BARREL_ENTITY_ID_BASE doc comment): tag the body so
			// a later world.hitEvents() drain (stepExplodingBarrels()) can resolve "which barrel got hit"
			// back to this triangle's own index. The shape falls back to the body's userData when its
			// OWN userData is left at 0 (shape.ts's ShapeOptions.userData doc comment), so tagging the
			// body alone is enough -- no need to also pass userData into createHullShape() above.
			body.setUserData(BARREL_ENTITY_ID_BASE + rowIndex);
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

// =================================================================================================
// P009 FIX -- utility poles: was a FREE dynamic box (40kg, friction-rested, no joint/anchor at all --
// bug: "the pole prop does nothing to the car, doesn't look like a utility pole, and should be rooted
// in the ground and behave like trees (lean/snap)"). Each pole is now a PoleProp: a static ground
// anchor + a dynamic capsule shaft (~420kg) welded to it with an angularly-COMPLIANT joint (bends/
// shudders under a sub-break-threshold hit, same technique as world/features/trees/bodies.ts's mid-
// trunk root weld, reimplemented independently here -- trees/* is not touched). A hit past tuning.ts's
// POLE_FORCE_THRESHOLD_N/POLE_TORQUE_THRESHOLD_NM (calibrated so ~50km/h+ reliably snaps it, a gentle
// nudge doesn't) snaps the joint and fractures the shaft at its base-third (fractureCapsuleTrunk(),
// world/features/fracture.ts, called as-is) into an anchored stump + a flying top piece.
// =================================================================================================

export interface PoleProp {
	readonly entityId: number;
	readonly spawnPos: V3;
	readonly anchor: Body;
	/** The standing shaft until a break; after a fracture this is re-pointed at the flying top piece
	 * (mirrors trees/bodies.ts's MidTree.trunk convention). */
	shaft: Body;
	joint: WeldJoint | null;
	/** True once the joint has been destroyed WITHOUT a fracture context available (legacy "fell whole"
	 * fallback -- kept for API parity with the trees module's shape; in every wired call site here a
	 * fracture context is always supplied, so this fallback is not the normal path). */
	broken: boolean;
	fractured: boolean;
	stump: { frag: FractureFragment; joint: WeldJoint } | null;
	flyerFrag: FractureFragment | null;
	/** Mirrored createDestructibleWorld() bodies[] entry this pole keeps `.body` aliased to -- null for
	 * standalone callers (crash lab / sim tests) that read this record directly. */
	mirror: DestructibleBody | null;
}

function buildPoleShaft(world: World, pos: V3): { body: Body; shape: Shape } {
	const r = POLE_SHAFT_RADIUS_M;
	const capLen = POLE_HEIGHT_M - 2 * r;
	const density = POLE_MASS_KG / capsuleVolume(r, capLen);
	const body = world.createBody({ type: BodyType.Dynamic, position: pos, rotation: IDENTITY_Q, angularDamping: POLE_ANGULAR_DAMPING, linearDamping: POLE_LINEAR_DAMPING });
	const shape = body.createCapsuleShape({ center1: { x: 0, y: r, z: 0 }, center2: { x: 0, y: POLE_HEIGHT_M - r, z: 0 }, radius: r, density, friction: POLE_FRICTION });
	body.applyMassFromShapes();
	return { body, shape };
}

function attachPoleJoint(world: World, anchor: Body, shaft: Body): WeldJoint {
	return world.createWeldJoint(anchor, shaft, {
		linearHertz: POLE_WELD_LINEAR_HERTZ,
		angularHertz: POLE_WELD_ANGULAR_HERTZ,
		linearDampingRatio: POLE_WELD_DAMPING_RATIO,
		angularDampingRatio: POLE_WELD_DAMPING_RATIO,
	});
}

/** Builds ONE utility pole for standalone callers (crash lab / sim tests) -- no mirrored bodies[]
 * entry. See buildPoles() for the multi-instance variant createDestructibleWorld() uses. */
export function buildPole(world: World, groundPos: V3, entityId: number): PoleProp {
	const pos: V3 = { x: groundPos.x, y: 0, z: groundPos.z };
	const anchor = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
	const { body: shaft } = buildPoleShaft(world, pos);
	shaft.setUserData(entityId);
	const joint = attachPoleJoint(world, anchor, shaft);
	shaft.setAwake(false);
	return { entityId, spawnPos: pos, anchor, shaft, joint, broken: false, fractured: false, stump: null, flyerFrag: null, mirror: null };
}

function fracturePole(p: PoleProp, forceMag: number, ctx: PropFractureContext, massRegistry: Map<number, number> | null): void {
	if (p.fractured || p.broken) return;
	p.joint!.destroy();
	p.joint = null;
	p.broken = true;

	const t = p.shaft.getTransform();
	const lv = p.shaft.getLinearVelocity();
	const av = p.shaft.getAngularVelocity();
	p.shaft.destroy();
	massRegistry?.delete(p.entityId);

	const { stump, flyer } = fractureCapsuleTrunk({
		world: ctx.world,
		position: t.position,
		rotation: t.rotation,
		linearVelocity: lv,
		angularVelocity: av,
		radius: POLE_SHAFT_RADIUS_M,
		fullHeight: POLE_HEIGHT_M,
		massKg: POLE_MASS_KG,
		friction: POLE_FRICTION,
		stumpFraction: POLE_STUMP_FRACTION,
		forceMag,
		threshold: POLE_FRACTURE_THRESHOLD,
		seed: fractureSeed(p.entityId),
		timeSec: 0,
		idAllocator: ctx.idAllocator,
		breakSpeedCapMs: POLE_FRAGMENT_SPEED_CAP_MS,
		breakSpinCapRad: POLE_FRAGMENT_SPIN_CAP_RAD,
	});

	// Rigid stump weld back onto the anchor (default identity frames): reads as "snapped off at the
	// base", same convention as trees/bodies.ts's fractureMid() stump joint.
	const stumpJoint = ctx.world.createWeldJoint(p.anchor, stump.body, { linearHertz: 0, angularHertz: 0, linearDampingRatio: 1, angularDampingRatio: 1 });
	p.stump = { frag: stump, joint: stumpJoint };
	p.flyerFrag = flyer;
	p.shaft = flyer.body;
	p.fractured = true;
	if (p.mirror) p.mirror.body = flyer.body;
	massRegistry?.set(stump.entityId, stump.massKg);
	massRegistry?.set(flyer.entityId, flyer.massKg);
}

/** Polls one pole's root-weld constraint force/torque (per-step polling, NOT world.jointEvents() --
 * same technique as trees/bodies.ts's pollMidBreaks(), since box3d joint-break events only report for
 * awake joints). Past threshold with a fracture context + budget available, SNAPS the pole at its
 * base-third; without one (or once the per-step budget is spent), falls back to felling the whole
 * shaft (legacy "joint just breaks" behavior). */
export function pollPoleBreak(p: PoleProp, ctx: PropFractureContext | undefined, massRegistry: Map<number, number> | null): void {
	if (p.broken || !p.joint) return;
	const f = p.joint.getConstraintForce();
	const forceMag = Math.hypot(f.x, f.y, f.z);
	const t = p.joint.getConstraintTorque();
	const torqueMag = Math.hypot(t.x, t.y, t.z);
	if (forceMag > POLE_FORCE_THRESHOLD_N || torqueMag > POLE_TORQUE_THRESHOLD_NM) {
		if (ctx && tryConsumeFractureBudget(ctx.budget)) {
			fracturePole(p, forceMag, ctx, massRegistry);
		} else {
			p.joint.destroy();
			p.joint = null;
			p.broken = true;
		}
	}
}

/** Polls every pole -- call once per fixed step, AFTER world.step(). Exported for standalone callers
 * (crash lab / sim tests); createDestructibleWorld() users should prefer stepDestructiblePoles() below
 * (handles the budget reset too). */
export function stepPoleBreaks(poles: readonly PoleProp[], ctx: PropFractureContext | undefined, massRegistry: Map<number, number> | null): void {
	for (const p of poles) pollPoleBreak(p, ctx, massRegistry);
}

/** Idempotent single-pole reset (Shift+R): rebuilds a fresh anchored shaft+joint if fractured/felled,
 * else just teleports+resleeps -- same shape as trees/bodies.ts's resetMid(). */
export function resetPole(world: World, p: PoleProp, massRegistry: Map<number, number> | null): void {
	if (p.fractured && p.stump && p.flyerFrag) {
		p.stump.joint.destroy();
		p.stump.frag.shape.destroy(false);
		p.stump.frag.body.destroy();
		p.flyerFrag.shape.destroy(false);
		p.flyerFrag.body.destroy(); // this IS p.shaft (re-pointed at fracture time)
		massRegistry?.delete(p.stump.frag.entityId);
		massRegistry?.delete(p.flyerFrag.entityId);
		massRegistry?.set(p.entityId, POLE_MASS_KG);
		p.stump = null;
		p.flyerFrag = null;
		p.fractured = false;
		const { body: shaft } = buildPoleShaft(world, p.spawnPos);
		shaft.setUserData(p.entityId);
		p.shaft = shaft;
		p.joint = attachPoleJoint(world, p.anchor, shaft);
		p.broken = false;
		if (p.mirror) p.mirror.body = shaft;
	} else if (p.broken || !p.joint) {
		p.shaft.destroy();
		const { body: shaft } = buildPoleShaft(world, p.spawnPos);
		shaft.setUserData(p.entityId);
		p.shaft = shaft;
		p.joint = attachPoleJoint(world, p.anchor, shaft);
		p.broken = false;
		if (p.mirror) p.mirror.body = shaft;
	} else {
		p.shaft.setTransform(p.spawnPos, IDENTITY_Q);
		p.shaft.setLinearVelocity({ x: 0, y: 0, z: 0 });
		p.shaft.setAngularVelocity({ x: 0, y: 0, z: 0 });
	}
	p.shaft.setAwake(false);
}

/** Full teardown of one pole (anchor + whatever's currently live -- shaft, or stump+flyer if
 * fractured). */
export function destroyPole(p: PoleProp, massRegistry: Map<number, number> | null): void {
	massRegistry?.delete(p.entityId);
	if (p.fractured && p.stump) {
		massRegistry?.delete(p.stump.frag.entityId);
		if (p.flyerFrag) massRegistry?.delete(p.flyerFrag.entityId);
		try {
			p.stump.joint.destroy();
		} catch {
			/* already freed */
		}
		try {
			p.stump.frag.shape.destroy(false);
		} catch {
			/* already freed */
		}
		try {
			p.stump.frag.body.destroy();
		} catch {
			/* already freed */
		}
		try {
			p.shaft.destroy(); // === flyerFrag.body
		} catch {
			/* already freed */
		}
	} else {
		if (p.joint) {
			try {
				p.joint.destroy();
			} catch {
				/* already freed */
			}
		}
		try {
			p.shaft.destroy();
		} catch {
			/* already freed */
		}
	}
	try {
		p.anchor.destroy();
	} catch {
		/* already freed */
	}
}

function buildPoles(world: World): { bodies: DestructibleBody[]; poles: PoleProp[] } {
	const bodiesOut: DestructibleBody[] = [];
	const poles: PoleProp[] = [];
	POLE_POSITIONS.forEach((groundPos, i) => {
		const entityId = POLE_ENTITY_ID_BASE + i;
		const pos: V3 = { x: groundPos.x, y: 0, z: groundPos.z };
		const anchor = world.createBody({ type: BodyType.Static, position: pos, rotation: IDENTITY_Q });
		const { body: shaft, shape } = buildPoleShaft(world, pos);
		shaft.setUserData(entityId);
		const joint = attachPoleJoint(world, anchor, shaft);
		shaft.setAwake(false);
		const mirror: DestructibleBody = { kind: 'pole', body: shaft, shapes: [shape], spawnPos: pos, spawnRot: IDENTITY_Q, material: 'poleWood', radius: POLE_SHAFT_RADIUS_M, height: POLE_HEIGHT_M };
		bodiesOut.push(mirror);
		poles.push({ entityId, spawnPos: pos, anchor, shaft, joint, broken: false, fractured: false, stump: null, flyerFrag: null, mirror });
	});
	return { bodies: bodiesOut, poles };
}

/** Once per fixed step, AFTER world.step(): resets the per-step fracture budget then polls every pole's
 * root weld (see pollPoleBreak()/stepPoleBreaks() above). */
export function stepDestructiblePoles(destructible: DestructibleWorld): void {
	resetFractureBudget(destructible.poleFracture.budget);
	stepPoleBreaks(destructible.poles, destructible.poleFracture, destructible.massRegistry);
}

/** Once per fixed step, AFTER world.step(): resets the per-step fracture budget then drains
 * world.hitEvents() for crate impacts (see stepCrateFractures() above). */
export function stepDestructibleCrates(destructible: DestructibleWorld): void {
	resetFractureBudget(destructible.crateFracture.budget);
	stepCrateFractures(destructible.world, destructible.crateByEntityId, destructible.crateFracture, destructible.massRegistry);
}

function buildRamps(world: World): RampBody[] {
	const out: RampBody[] = [];
	for (const cfg of RAMP_CONFIGS) {
		const backSlopeLength = cfg.backSlopeLength ?? 0;
		const points = wedgeHullPoints(cfg.width, cfg.length, cfg.height, backSlopeLength);
		const position: V3 = { x: cfg.centerX, y: 0, z: cfg.backZ };
		const body = world.createBody({ type: BodyType.Static, position, rotation: IDENTITY_Q });
		const shape = body.createHullShape(points, { density: 1, friction: RAMP_FRICTION });
		out.push({ id: cfg.id, body, shape, angleDeg: cfg.angleDeg, width: cfg.width, length: cfg.length, height: cfg.height, position, backSlopeLength });
	}
	return out;
}

/**
 * Builds the full destructible world: 3 stacked-block walls, a crate tower, a barrel bowling
 * triangle, 5 tippable poles (all dynamic, spawned ASLEEP -- see this module's doc comment), and 2
 * static ramps (kicker + wide). Total dynamic body count is logged by the caller (main.ts/perf-
 * bench.mjs) for the "~110-160 dynamic destructible bodies" spec target.
 */
export function createDestructibleWorld(world: World, massRegistry: Map<number, number> | null = null): DestructibleWorld {
	const bodies: DestructibleBody[] = [];
	for (const wall of WALL_CONFIGS) bodies.push(...buildWall(world, wall));
	const crateResult = buildCrateTower(world);
	bodies.push(...crateResult.bodies);
	const barrelStartIndex = bodies.length;
	bodies.push(...buildBarrelTriangle(world));
	const poleResult = buildPoles(world);
	bodies.push(...poleResult.bodies);

	// FRACTURE SPEC §E (docs/loom/d1-fracture-material-spec.md): tag every still-untagged destructible
	// (only wall blocks now -- barrels/crates/poles are all pre-tagged at build time above, each with
	// its own entity-id range, P009/P011 fix) with a deterministic entity id so main.ts can register
	// its real mass into the damage system's foreign-mass registry (setForeignMass), giving light
	// debris mass-attenuated car damage instead of wall-strength damage. Creation-order indexing keeps
	// ids byte-stable across runs (warning #3).
	for (let i = 0; i < bodies.length; i++) {
		if (bodies[i].body.getUserData() === 0) bodies[i].body.setUserData(LEGACY_DESTRUCTIBLE_ENTITY_ID_BASE + i);
	}

	// Spawn asleep: every dynamic body above is fresh (b3DefaultBodyDef() starts awake), so put it to
	// sleep now, before the world has ever stepped -- observably identical to "spawned asleep" (zero
	// solver cost until something wakes it, e.g. the car driving into it or a neighboring body waking
	// it via contact).
	for (const b of bodies) b.body.setAwake(false);

	const ramps = buildRamps(world);
	const explodingBarrels = createExplodingBarrelsState(bodies, barrelStartIndex);

	const crateByEntityId = new Map<number, CrateProp>(crateResult.crates.map((c) => [c.entityId, c]));
	// Fragment id ranges: disjoint from world/features/trees/index.ts's own allocator (FRACTURE_
	// FRAGMENT_ENTITY_ID_BASE+0) and buildings/index.ts's (+500,000) -- see tuning.ts's CRATE_ENTITY_ID_
	// BASE/POLE_ENTITY_ID_BASE doc comment for the full range map.
	const poleFracture: PropFractureContext = { world, budget: createFractureBudget(1), idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE + 900_000) };
	const crateFracture: PropFractureContext = { world, budget: createFractureBudget(1), idAllocator: createFractureIdAllocator(FRACTURE_FRAGMENT_ENTITY_ID_BASE + 950_000) };

	if (massRegistry) {
		for (const p of poleResult.poles) massRegistry.set(p.entityId, POLE_MASS_KG);
		for (const c of crateResult.crates) massRegistry.set(c.entityId, CRATE_MASS_KG);
	}

	return { bodies, ramps, explodingBarrels, poles: poleResult.poles, crates: crateResult.crates, crateByEntityId, poleFracture, crateFracture, world, massRegistry };
}

/** Teleports every dynamic destructible body back to its spawn pose, zeroes velocity, and re-sleeps
 * it (Shift+R's "world reset" -- see main.ts) -- the spec's "teleport+sleep" alternative to a full
 * destroy+rebuild, chosen here since these bodies never get destroyed/mutated by any other system
 * (unlike the car's panels/wheels), so an in-place teleport is exactly equivalent and far cheaper for
 * ~130+ bodies. Also resets the exploding-barrels feature's exploded/fuse/RNG state (see
 * ExplodingBarrelsState) -- same call site, no extra reset hook needed by main.ts.
 *
 * Poles (P009) and crates (P011) are skipped by the generic teleport loop and handled by their own
 * resetPole()/resetCrateProp() instead: a FRACTURED pole/crate has no single intact body left to
 * teleport (its mirrored bodies[] entry aliases a fragment, see DestructibleBody's doc comment) and
 * needs a full rebuild, exactly like trees/bodies.ts's resetMid()/resetSapling() already do for their
 * own fracturable members. */
export function resetDestructibleWorld(destructible: DestructibleWorld): void {
	for (const b of destructible.bodies) {
		if (b.kind === 'pole' || b.kind === 'crate') continue;
		b.body.setTransform(b.spawnPos, b.spawnRot);
		b.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		b.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		b.body.setAwake(false);
		// A barrel that exploded may have picked up setBullet(true) (see triggerBarrelExplosion()) --
		// harmless on a re-slept body, but cleared here for cleanliness/symmetry with everything else
		// this loop resets.
		if (b.kind === 'barrel') b.body.setBullet(false);
	}
	for (const p of destructible.poles) resetPole(destructible.world, p, destructible.massRegistry);
	for (const c of destructible.crates) resetCrateProp(destructible.world, c, destructible.massRegistry);
	resetExplodingBarrelsState(destructible.explodingBarrels);
}

/** Full teardown (shapes then bodies, mirroring vehicle.ts's destroyVehicle() ordering so every
 * native handle is explicitly unregistered from the box3d-js live-handle registry -- see
 * ../../../src/ts/registry.ts). Not on the normal Shift+R path (which teleports+sleeps instead, see
 * resetDestructibleWorld()) but kept available for completeness/tests. Poles/crates (each of which may
 * own EXTRA native handles -- an anchor + a live joint, or splinter fragments -- beyond the single
 * body/shape pair the generic loop below assumes) are torn down via their own destroyPole()/
 * destroyCrateProp() instead. */
export function destroyDestructibleWorld(destructible: DestructibleWorld): void {
	for (const b of destructible.bodies) {
		if (b.kind === 'pole' || b.kind === 'crate') continue;
		for (const s of b.shapes) s.destroy(false);
		b.body.destroy();
	}
	for (const p of destructible.poles) destroyPole(p, destructible.massRegistry);
	for (const c of destructible.crates) destroyCrateProp(c, destructible.massRegistry);
	for (const r of destructible.ramps) {
		r.shape.destroy(false);
		r.body.destroy();
	}
}

// =================================================================================================
// EXPLODING BARRELS -- world.explode() chain-reaction feature.
//
// A hard enough hit on a barrel (car at speed, flying debris, or a neighboring barrel's own blast --
// stepExplodingBarrels() doesn't care which) detonates it: a radial b3World_Explode impulse scatters
// nearby bricks/crates/barrels and shoves the car, a strong direct upward+outward impulse rockets the
// barrel itself, and every other un-exploded barrel within BARREL_CHAIN_RADIUS_M gets a short,
// deterministic random fuse -- so one hit can cascade through the whole triangle. See tuning.ts's
// "Exploding barrels" section for every tuned constant's derivation.
//
// WIRING (renderer-free, no main.ts touch from this module -- see the G4-run dispatch brief's STRICT
// OWNERSHIP): stepExplodingBarrels(world, destructibleWorld, dt) must be called once per fixed step,
// alongside world.step() (AFTER it, so this step's hit events are already populated -- same ordering
// as main.ts's existing stepDamageSystem() call). It returns this call's ExplosionEvent[] (empty most
// steps) -- feed those into world/visuals.ts's spawnExplosionEffects() for the fireball/smoke burst.
// Reset is already covered: resetDestructibleWorld() (already wired into main.ts's Shift+R path)
// clears this feature's state too.
// =================================================================================================

/** One barrel's explosion, this step -- consumed by world/visuals.ts's spawnExplosionEffects() to
 * spawn the fireball/smoke burst. `radius`/`falloff` are echoed from tuning.ts so the visual burst
 * can size itself to match the actual physics blast without importing tuning.ts separately. */
export interface ExplosionEvent {
	readonly position: V3;
	readonly barrelIndex: number;
	readonly radius: number;
	readonly falloff: number;
}

interface BarrelFuse {
	barrelIndex: number;
	remainingS: number;
}

/** Exploding-barrels bookkeeping, embedded in DestructibleWorld (see its doc comment) -- one instance
 * per createDestructibleWorld() call, reset in place (not recreated) by resetExplodingBarrelsState(). */
export interface ExplodingBarrelsState {
	/** Indices into DestructibleWorld.bodies of every barrel, in triangle order (0 = apex). */
	readonly barrelIndices: readonly number[];
	/** Entity id (BARREL_ENTITY_ID_BASE + triangle index) -> index into DestructibleWorld.bodies. */
	readonly entityIdToBodyIndex: ReadonlyMap<number, number>;
	/** Indexed like `bodies` (not `barrelIndices`) -- exploded[bodyIndex] is true once that barrel has
	 * detonated since the last reset. Sized to the full bodies array (not just barrels) so callers can
	 * index it directly with a DestructibleBody index without an extra lookup. */
	exploded: boolean[];
	/** Barrels with a chain-reaction fuse counting down, not yet detonated. */
	fuses: BarrelFuse[];
	/** mulberry32-style RNG state (see nextRandom()) -- mutated on every draw, reset to
	 * BARREL_EXPLOSION_SEED by resetExplodingBarrelsState() for deterministic replay. */
	rngState: number;
	/** This step's explosions, returned fresh by every stepExplodingBarrels() call (see its doc
	 * comment) -- NOT accumulated across steps. */
	pendingEvents: ExplosionEvent[];
	/** Diagnostic counter (this-run total, survives resets only because tests read it before calling
	 * reset) -- how many hit events stepExplodingBarrels() has ever attributed to a barrel. Not used by
	 * gameplay logic, only by game/sim/exploding-barrels.test.mjs to confirm hit events actually fired. */
	hitEventsSeen: number;
}

/** @internal pure mulberry32 step: given the current state word, returns [value in [0,1), nextState].
 * Same core mixing as world/materials.ts's mulberry32() (kept as an independent copy -- that module is
 * three.js-dependent and this one deliberately isn't, same rationale as this file's own doc comment on
 * why it shares no code with visuals.ts). Restructured as a pure function (rather than materials.ts's
 * closure-over-a-mutable-variable style) so ExplodingBarrelsState's rngState can be a plain, trivially
 * resettable number field instead of a closure. */
function nextRandom(state: number): [number, number] {
	let a = (state + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	return [value, a];
}

function createExplodingBarrelsState(bodies: DestructibleBody[], barrelStartIndex: number): ExplodingBarrelsState {
	const barrelIndices: number[] = [];
	const entityIdToBodyIndex = new Map<number, number>();
	let triangleIndex = 0;
	for (let i = barrelStartIndex; i < bodies.length; i++) {
		if (bodies[i].kind !== 'barrel') continue;
		barrelIndices.push(i);
		entityIdToBodyIndex.set(BARREL_ENTITY_ID_BASE + triangleIndex, i);
		triangleIndex++;
	}
	return {
		barrelIndices,
		entityIdToBodyIndex,
		exploded: new Array(bodies.length).fill(false),
		fuses: [],
		rngState: BARREL_EXPLOSION_SEED >>> 0,
		pendingEvents: [],
		hitEventsSeen: 0,
	};
}

function resetExplodingBarrelsState(state: ExplodingBarrelsState): void {
	state.exploded.fill(false);
	state.fuses = [];
	state.pendingEvents = [];
	state.rngState = BARREL_EXPLOSION_SEED >>> 0;
	state.hitEventsSeen = 0;
}

function isFused(state: ExplodingBarrelsState, bodyIndex: number): boolean {
	return state.fuses.some((f) => f.barrelIndex === bodyIndex);
}

/** Detonates the barrel at `bodyIndex` (no-op if it already has): world.explode() at its current
 * position (scatters neighbors + shoves the car via real physics, tuning.ts's BARREL_EXPLOSION_*
 * constants), a direct rocket impulse on the barrel itself (see tuning.ts's BARREL_ROCKET_* doc
 * comment on why world.explode() alone can't give a satisfying launch), and a short deterministic
 * fuse on every other un-exploded/un-fused barrel within BARREL_CHAIN_RADIUS_M. Records an
 * ExplosionEvent on `state.pendingEvents` for the visuals layer. */
function triggerBarrelExplosion(world: World, destructible: DestructibleWorld, state: ExplodingBarrelsState, bodyIndex: number): void {
	if (state.exploded[bodyIndex]) return;
	state.exploded[bodyIndex] = true;
	state.fuses = state.fuses.filter((f) => f.barrelIndex !== bodyIndex);

	const body = destructible.bodies[bodyIndex].body;
	const position = body.getPosition();

	world.explode({
		position,
		radius: BARREL_EXPLOSION_RADIUS_M,
		falloff: BARREL_EXPLOSION_FALLOFF_M,
		impulsePerArea: BARREL_EXPLOSION_IMPULSE_PER_AREA,
	});

	// "They famously rocket": a direct impulse on the exploding barrel itself (see tuning.ts's
	// BARREL_ROCKET_* doc comment on why world.explode()'s own self-effect isn't enough). Also flip on
	// CCD (setBullet) -- a barrel launching at ~18 m/s straight up is exactly the kind of fast-moving
	// runtime-spawned-velocity body box3d.h's b3Body_SetBullet doc comment calls out as needing it,
	// since its creation-time isBullet (always false for destructibles) can't cover a velocity applied
	// well after spawn.
	const [angleRand, rngAfterAngle] = nextRandom(state.rngState);
	state.rngState = rngAfterAngle;
	const angle = angleRand * Math.PI * 2;
	body.setBullet(true);
	// P010 FIX: impulse = target SPEED * this barrel's OWN real mass (not a flat kg*m/s magnitude -- see
	// tuning.ts's BARREL_ROCKET_UPWARD_SPEED_MS doc comment) so every barrel launches at the SAME ~18m/s
	// regardless of its full/empty variant mass.
	const rocketMassKg = body.getMass();
	body.applyLinearImpulseToCenter({
		x: Math.cos(angle) * BARREL_ROCKET_JITTER_SPEED_MS * rocketMassKg,
		y: BARREL_ROCKET_UPWARD_SPEED_MS * rocketMassKg,
		z: Math.sin(angle) * BARREL_ROCKET_JITTER_SPEED_MS * rocketMassKg,
	});

	state.pendingEvents.push({ position, barrelIndex: bodyIndex, radius: BARREL_EXPLOSION_RADIUS_M, falloff: BARREL_EXPLOSION_FALLOFF_M });

	// Chain reaction: every other un-exploded, not-already-fused barrel within BARREL_CHAIN_RADIUS_M of
	// THIS blast gets a short deterministic fuse (tuning.ts's BARREL_CHAIN_FUSE_MIN_S/MAX_S).
	for (const otherIndex of state.barrelIndices) {
		if (otherIndex === bodyIndex || state.exploded[otherIndex] || isFused(state, otherIndex)) continue;
		const otherPos = destructible.bodies[otherIndex].body.getPosition();
		const dx = otherPos.x - position.x;
		const dy = otherPos.y - position.y;
		const dz = otherPos.z - position.z;
		const dist = Math.hypot(dx, dy, dz);
		if (dist > BARREL_CHAIN_RADIUS_M) continue;
		const [fuseRand, rngAfterFuse] = nextRandom(state.rngState);
		state.rngState = rngAfterFuse;
		const fuseS = BARREL_CHAIN_FUSE_MIN_S + fuseRand * (BARREL_CHAIN_FUSE_MAX_S - BARREL_CHAIN_FUSE_MIN_S);
		state.fuses.push({ barrelIndex: otherIndex, remainingS: fuseS });
	}
}

function checkHitEntityForBarrelTrigger(
	world: World,
	destructible: DestructibleWorld,
	state: ExplodingBarrelsState,
	entityId: number,
	approachSpeed: number,
): void {
	if (entityId === 0) return;
	const bodyIndex = state.entityIdToBodyIndex.get(entityId);
	if (bodyIndex === undefined) return;
	state.hitEventsSeen++;
	if (state.exploded[bodyIndex]) return;

	// approachSpeed * a FIXED reference mass -- see tuning.ts's BARREL_EXPLOSION_TRIGGER_IMPULSE_KGMS doc
	// comment for why this proxy is the right one. Deliberately BARREL_MASS_KG (the pre-P010-fix flat
	// 25kg every barrel used to weigh), NOT the struck barrel's own REAL live mass: P010 gave full/empty
	// barrels genuinely different masses (BARREL_MASS_KG_BY_MATERIAL, ~200kg/~20kg) for realistic car-vs-
	// barrel collision physics, but this exploding-barrels feature's trigger/chain calibration (this
	// whole section's tuned constants) predates that split and was validated against a uniform 25kg --
	// a fixed reference here keeps that calibration exactly as tested (sim/exploding-barrels.test.mjs)
	// regardless of which real-mass variant got hit, rather than making "how easily a barrel detonates"
	// swing 8x by paint color as an unintended side effect of an unrelated fix.
	const impulseLike = approachSpeed * BARREL_MASS_KG;
	if (impulseLike >= BARREL_EXPLOSION_TRIGGER_IMPULSE_KGMS) {
		triggerBarrelExplosion(world, destructible, state, bodyIndex);
	}
}

/**
 * Call once per fixed step, AFTER world.step() (so this step's hit events are populated) -- see this
 * section's WIRING doc comment above. Drains world.hitEvents() for barrel impacts hard enough to
 * detonate (tuning.ts's BARREL_EXPLOSION_TRIGGER_IMPULSE_KGMS), then ticks every pending chain-reaction
 * fuse by `dt`, detonating any that reach zero (which may itself schedule further fuses -- a real
 * cascade). Returns this call's fresh ExplosionEvent[] (usually empty) for the visuals layer.
 */
export function stepExplodingBarrels(world: World, destructible: DestructibleWorld, dt: number): ExplosionEvent[] {
	const state = destructible.explodingBarrels;
	state.pendingEvents = [];

	const hits = world.hitEvents();
	for (let i = 0; i < hits.count; i++) {
		const ev = hits.at(i);
		checkHitEntityForBarrelTrigger(world, destructible, state, ev.userDataA, ev.approachSpeed);
		checkHitEntityForBarrelTrigger(world, destructible, state, ev.userDataB, ev.approachSpeed);
	}

	if (state.fuses.length > 0) {
		const stillPending: BarrelFuse[] = [];
		for (const fuse of state.fuses) {
			fuse.remainingS -= dt;
			if (state.exploded[fuse.barrelIndex]) continue; // exploded via some other path already
			if (fuse.remainingS <= 0) {
				triggerBarrelExplosion(world, destructible, state, fuse.barrelIndex);
			} else {
				stillPending.push(fuse);
			}
		}
		state.fuses = stillPending;
	}

	return state.pendingEvents;
}
