// SPDX-License-Identifier: MIT
//
// Damage-system panel bodies (G3 spec): 5 thin box hulls (car-map.ts panel bboxes, forced to a 5cm
// thickness on their "thin" axis -- see damage-tuning.ts's PANEL_THICKNESS_AXIS doc comment), each
// welded RIGIDLY to the chassis. Renderer-free (no three/DOM import) -- called from vehicle.ts's
// createVehicle() so panels are part of the core vehicle assembly shared by the browser game and the
// headless sim harness alike (game/sim/harness.mjs), same as chassis/wheels.

import { Body, BodyType, Shape, World, WeldJoint, RevoluteJoint } from '../../../src/ts/index.js';
import { add, IDENTITY_Q, multiplyQuat, quatFromAxisAngle, rotateVector, type Q4, type V3 } from '../vehicle/mathUtil';
import { CAR_GROUP_INDEX, CHASSIS_ORIGIN_HEIGHT_M, EJECTED_ONLY_OCCUPANT_CATEGORY_BITS } from '../vehicle/tuning';
import { HULL_BOTTOM_Y_M } from '../vehicle/geometry';
import { CAR_MAP, type Vec3Mm, type Vec4 } from '../assets/car-map';
import { DOOR_SWING_MAX_RAD, PANEL_FRICTION, PANEL_HALF_THICKNESS_M, PANEL_MASS_KG, PANEL_THICKNESS_AXIS } from './damage-tuning';

/** car-map.ts records [x,y,z,w]; box3d's Q4 is {x,y,z,w} -- same numbers, different shape. */
function q4FromVec4(v: Vec4): Q4 {
	return { x: v[0], y: v[1], z: v[2], w: v[3] };
}

// Volvo S90 is a 4-door sedan (swapped 2026-07-11 from the Mustang-65 2-door fastback): 6 damage
// panels (hood, 4 doors, trunk lid) -- still NO roof panel (the S90's roof is molded into BodyShell,
// same as the Mustang's shell). 'trunk' replaces the concept car's rear 'hatch' semantics. Rear doors
// (doorRL/doorRR) are full detachable panels, same vulnerability shape as the front doors (see
// damage-tuning.ts's PANEL_BREAK_S2_MULT/PANEL_VULNERABILITY/PANEL_THICKNESS_AXIS entries).
export type PanelKey = 'hood' | 'doorL' | 'doorR' | 'doorRL' | 'doorRR' | 'trunk';

export const PANEL_KEYS: readonly PanelKey[] = ['hood', 'doorL', 'doorR', 'doorRL', 'doorRR', 'trunk'];

/** The 4 panels eligible for the SPRUNG state (Stream C slice C1) -- hood/trunk keep their existing
 * loosen/break-only escalation (a hood "springs" differently -- the tent/buckle behavior already
 * handles it -- see welds.ts's escalatePanel()). */
export const DOOR_PANEL_KEY_SET: ReadonlySet<PanelKey> = new Set<PanelKey>(['doorL', 'doorR', 'doorRL', 'doorRR']);

/** car-map.ts node name for each panel (see car-map.ts's `panels` record). */
export const PANEL_NODE_NAMES: Record<PanelKey, string> = {
	hood: 'Hood',
	doorL: 'DoorL',
	doorR: 'DoorR',
	doorRL: 'DoorRL',
	doorRR: 'DoorRR',
	trunk: 'Trunk',
};

/**
 * Entity ids tagged on panel bodies/shapes (Body/Shape userData), read back via hit events'
 * userDataA/userDataB (src/ts/events.ts's HitEventCursor). Deliberately NOT imported from vehicle.ts
 * (that would create a vehicle.ts <-> panels.ts import cycle, since vehicle.ts's createVehicle()
 * calls createPanels() below) -- kept in a disjoint numeric range (6-11) by convention; vehicle.ts's
 * CAR_ENTITY_ID doc comment cross-references this range (1 = chassis, 2-5 = wheels).
 *
 * RENUMBERED 2026-07-11 (S90 swap, rear-door panels added): the old range (hood=6..trunk=9, 1 free
 * slot) didn't have room for 2 more panels before colliding with vehicle.ts's GLASS_ENTITY_ID (11-12)
 * -- glass shifted to 12-13 and segments.ts's segment range shifted +1 (14-22) to make room. See
 * docs/loom/p0b-mustang-coupling.md section 5 for the collision analysis that drove this.
 */
export const PANEL_ENTITY_ID: Record<PanelKey, number> = {
	hood: 6,
	doorL: 7,
	doorR: 8,
	doorRL: 9,
	doorRR: 10,
	trunk: 11,
};

/** Same mm->local-meters conversion as vehicle.ts's (private) mmToLocalMount() -- kept as an
 * independent copy rather than importing vehicle.ts's version, to avoid a vehicle.ts <-> panels.ts
 * import cycle (vehicle.ts's createVehicle() calls createPanels() below). */
function mmToLocalCenter(centerMm: Vec3Mm): V3 {
	return {
		x: centerMm[0] / 1000,
		y: centerMm[1] / 1000 - CHASSIS_ORIGIN_HEIGHT_M,
		z: centerMm[2] / 1000,
	};
}

/** Footprint from the measured bbox, with the panel's "thin" axis forced to PANEL_HALF_THICKNESS_M
 * (damage-tuning.ts's PANEL_THICKNESS_AXIS doc comment explains why the raw measured value on that
 * axis is not used directly). Expressed in the CHASSIS/car-root reference frame (same convention as
 * car-map.ts's sizeMm and PANEL_THICKNESS_AXIS's 'x'/'y' names -- e.g. "thin along y" means thin
 * vertically).
 *
 * GROUND-CLEARANCE FIX (vehicle deep-pass residual 1, "friction deficit root-cause"): also clamps
 * the reference-frame VERTICAL (y) half-extent so this panel's bottom edge (localCenterY - half.y)
 * never sits below the chassis hull's own tuned ground-clearance line (tuning.ts's GROUND_CLEARANCE_M
 * / geometry.ts's HULL_BOTTOM_Y_M). ROOT CAUSE (confirmed via game/sim/diag/friction-instrument*.
 * test.mjs, run against this unmodified model): doorL/doorR's PANEL_THICKNESS_AXIS is 'x' (thin
 * laterally, per real doors being near-vertical panels), which leaves their raw measured sizeMm.y
 * (959mm, centered at ~635mm) UNCLAMPED -- same "raw bbox bundles child-node detail" issue
 * PANEL_THICKNESS_AXIS's own doc comment already flags for the thickness axis (car-map.ts's
 * BodyDoorLColor1/BodyDoorRColor1 bundle mirror/handle/window-frame childNodes into the same
 * parent bbox), just on the OTHER axis here -- puts the door's bottom edge ~8.5cm BELOW the hull's
 * own carefully-tuned clearance line, i.e. LOWER than the hull itself, silently reinstating the
 * exact "shape drags along the ground, its friction anchors the chassis independent of the wheels"
 * bug GROUND_CLEARANCE_M's doc comment describes fixing for the hull -- confirmed directly: the
 * doors dip to within ~9mm of the ground under hard-launch weight transfer (well inside box3d's
 * contact-generation margin), and a clean single-variable isolation (Shape.setFilter() excluding
 * ONLY door<->ground collision, weld/mass/position otherwise untouched) recovers real straight-line
 * acceleration (measured +5.1km/h / +5.5% @ 5s full throttle, same run otherwise). This ONLY trims
 * the collision-proxy box (symmetric about the body origin, since box3d-js box shapes have no
 * off-origin center field, per tuning.ts's COM_LOWER_OFFSET_M doc comment) -- it does not move
 * localCenter (the weld anchor / visual-alignment pivot, untouched) and does not affect the
 * RENDERED mesh (panelVisuals.ts tracks the body's transform, not this proxy's exact extents, so
 * the foundation gate's visual-alignment requirement is unaffected). Never GROWS a panel (hood/roof/
 * hatch's already-thin post-override y half-extent sits far inside this floor and is untouched).
 */
function panelHalfExtentsRef(key: PanelKey, sizeMm: Vec3Mm, localCenterY: number): V3 {
	const half: V3 = { x: sizeMm[0] / 2000, y: sizeMm[1] / 2000, z: sizeMm[2] / 2000 };
	half[PANEL_THICKNESS_AXIS[key]] = PANEL_HALF_THICKNESS_M;
	const maxHalfY = Math.max(0, localCenterY - HULL_BOTTOM_Y_M);
	if (half.y > maxHalfY) half.y = maxHalfY;
	return half;
}

/**
 * Remaps a box's half-extents from the chassis/car-root reference frame into the panel BODY's own
 * local frame, given the body's rotation RELATIVE to that reference frame (`nodeWorldQuat` --
 * car-map.ts's PanelNode.worldQuat). Needed because the panel body is no longer spawned at the bare
 * chassis rotation (createPanels()'s doc comment): its box shape's halfExtents are always local to
 * the body, so if the body is rotated relative to the reference frame the raw sizeMm-derived
 * half-extents (computed in and for that reference frame) would describe the WRONG box in world
 * space -- e.g. the hood's true 5cm vertical thinness would instead land front-to-back.
 *
 * Exact ONLY when `nodeWorldQuat` is an axis-permutation rotation (a multiple of 90deg about a
 * principal axis) -- confirmed true here (measured exactly -90deg about X for every panel, see
 * car-map.ts's PanelNode.worldQuat doc comment): rotating each body-local basis axis by the
 * quaternion yields another axis-aligned (|component|==1 on exactly one axis) unit vector, so
 * dotting its absolute components against `refHalf` picks out exactly the one reference-frame
 * half-extent that ends up along that body-local axis once rotated.
 */
function remapHalfExtentsToBodyLocal(nodeWorldQuat: Q4, refHalf: V3): V3 {
	const pick = (axis: V3): number => {
		const e = rotateVector(nodeWorldQuat, axis);
		return Math.abs(e.x) * refHalf.x + Math.abs(e.y) * refHalf.y + Math.abs(e.z) * refHalf.z;
	};
	return {
		x: pick({ x: 1, y: 0, z: 0 }),
		y: pick({ x: 0, y: 1, z: 0 }),
		z: pick({ x: 0, y: 0, z: 1 }),
	};
}

export interface PanelHandle {
	readonly key: PanelKey;
	body: Body;
	shape: Shape;
	/** Non-null while attached/loosened; null once sprung or broken (weld destroyed) -- LOOSEN itself
	 * keeps the same joint object (softened in place via the runtime hertz/damping setters), see
	 * loosenPanelWeld(). */
	weldJoint: WeldJoint | null;
	/** Non-null while sprung (DOORS ONLY -- see sprungPanelWeld()); null otherwise. Destroyed (like
	 * weldJoint) before the panel body dies, either on a further escalation to broken (breakPanelWeld())
	 * or a full car teardown (vehicle.ts's destroyVehicle()). */
	hingeJoint: RevoluteJoint | null;
	/** Chassis-local mount point (== this panel body's local offset from the chassis origin at spawn). */
	readonly localCenter: V3;
	/** This panel's GLB node world rotation (car-map.ts's PanelNode.worldQuat, as a Q4) -- the rigid
	 * chassis-local ORIENTATION offset between the chassis frame and how the panel mesh is actually
	 * authored/rendered (see createPanels()'s doc comment). Needed again by resetAttachedPanels() to
	 * restore the same rest rotation after a reset. */
	readonly nodeWorldQuat: Q4;
	readonly halfExtents: V3;
	readonly massKg: number;
	readonly density: number;
	state: 'attached' | 'loosened' | 'sprung' | 'broken';
	/** Accumulated event-driven stress (game/src/damage/welds.ts). */
	stress: number;
	/**
	 * DOORS ONLY (harmless/always-0 dead weight on hood/trunk): running numerator of a stress-WEIGHTED
	 * average of |dirLocal.x| (chassis-local lateral alignment) across every hit that has contributed to
	 * `stress` -- i.e. sum(stressIncrement * |dirLocal.x|) for each qualifying hit, same accumulation
	 * lifecycle as `stress` itself (monotonic, never reset mid-life). Divide by `stress` to get the
	 * fraction in [0,1] (see welds.ts's doorLateralFraction()) -- a value near 1 means this door's stress
	 * came almost entirely from squarely-lateral hits (a real side/T-bone impact); a value well below
	 * that means the stress came from hits with a real forward/oblique component even though each one
	 * still had *some* lateral alignment (PANEL_VULNERABILITY's floor=0 already requires nonzero
	 * |dirLocal.x| for a hit to contribute anything at all -- this statistic distinguishes "mostly
	 * sideways" from "glancing/oblique" within that already-lateral-gated population). Drives the C3b
	 * direction-aware sprung/jam split -- see damage-tuning.ts's DOOR_SPRUNG_LATERAL_FRACTION_MAX.
	 */
	lateralStressWeighted: number;
	/** Sim-time (seconds) this panel broke, or null if still attached/loosened. */
	breakTimeSec: number | null;
	hitEventsDisabled: boolean;
	despawned: boolean;
}

/**
 * Creates the 5 damage-system panel bodies, each welded RIGIDLY to the chassis (weld hertz 0 ==
 * "maximum stiffness" -- confirmed in vendor/box3d/include/box3d/box3d.h's b3WeldJoint_SetLinearHertz
 * doc comment: "0 is rigid" -- NOT a degenerate/disabled spring). Called from vehicle.ts's
 * createVehicle(): panels are part of the core vehicle assembly (not a separate opt-in step) because
 * the spec requires total car mass to stay ~unchanged with panels included, which only holds if every
 * vehicle -- including the 5 pre-existing headless drive tests -- gets panels too (see tuning.ts's
 * CHASSIS_MASS_KG doc comment for the mass-conservation arithmetic).
 *
 * ROTATION: each panel body is spawned at chassisRotation * node.worldQuat and the weld's frameA
 * carries node.worldQuat as its rotation (frameB stays identity), so the rigid constraint holds the
 * body at exactly the mesh's authored world orientation forever while attached. For the Mustang split
 * every panel's worldQuat is IDENTITY (poses baked into vertices, no shared rotated ancestor), so this
 * composition reduces to the bare chassis rotation -- but the general form is kept because it is what
 * makes the panel body's pose match the mesh's rendered pose exactly for ANY authored orientation
 * (the legacy CarConcept rig parented panels under a -90deg-about-X 'BodyUnderside', where the naive
 * bare-chassis spawn left the freed hood rendering ~3.1m below its physics body after a hard crash).
 */
export function createPanels(world: World, chassis: Body, spawnPosition: V3, spawnRotation: Q4): Record<PanelKey, PanelHandle> {
	const result = {} as Record<PanelKey, PanelHandle>;
	for (const key of PANEL_KEYS) {
		const node = CAR_MAP.panels[PANEL_NODE_NAMES[key]];
		const localCenter = mmToLocalCenter(node.centerMm);
		const nodeWorldQuat = q4FromVec4(node.worldQuat);
		const halfExtents = remapHalfExtentsToBodyLocal(nodeWorldQuat, panelHalfExtentsRef(key, node.sizeMm, localCenter.y));
		const massKg = PANEL_MASS_KG[key];
		const volume = 8 * halfExtents.x * halfExtents.y * halfExtents.z;
		const density = massKg / volume;

		const worldPos = add(spawnPosition, rotateVector(spawnRotation, localCenter));
		const bodyRotation = multiplyQuat(spawnRotation, nodeWorldQuat);
		const body = world.createBody({
			type: BodyType.Dynamic,
			position: worldPos,
			rotation: bodyRotation,
			userData: PANEL_ENTITY_ID[key],
		});
		const shape = body.createBoxShape({
			halfExtents,
			density,
			friction: PANEL_FRICTION,
			enableHitEvents: true,
			groupIndex: CAR_GROUP_INDEX,
			// Tier-3 STAGE 2: ejected-only occupant collision -- a flying/resting body lands ON the
			// hood/doors from outside, but a SEATED occupant never fights the hood's cowl edge or the
			// door boxes' window band from inside the cabin (measured intrusions -- see vehicle/
			// tuning.ts's OCCUPANT_EJECTED_COLLIDABLE_BIT doc comment). World/car interactions are
			// unchanged (masks stay default; only occupant masks key on the cleared bits).
			categoryBits: EJECTED_ONLY_OCCUPANT_CATEGORY_BITS,
			userData: PANEL_ENTITY_ID[key],
		});

		const weldJoint = world.createWeldJoint(chassis, body, {
			frameA: { position: localCenter, rotation: nodeWorldQuat },
			frameB: { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_Q },
			collideConnected: false,
			linearHertz: 0,
			angularHertz: 0,
			linearDampingRatio: 1,
			angularDampingRatio: 1,
		});

		result[key] = {
			key,
			body,
			shape,
			weldJoint,
			hingeJoint: null,
			localCenter,
			nodeWorldQuat,
			halfExtents,
			massKg,
			density,
			state: 'attached',
			stress: 0,
			lateralStressWeighted: 0,
			breakTimeSec: null,
			hitEventsDisabled: false,
			despawned: false,
		};
	}
	return result;
}

/** Conjugate (inverse) of a unit quaternion -- kept as a local copy (same convention as welds.ts's/
 * system.ts's own private copies of this and rotate()) rather than adding a new shared mathUtil.ts
 * export just for this one use. */
function conjugateQuat(q: Q4): Q4 {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/**
 * SPRUNG hinge axis remap: maps a joint frame's own local Z axis (box3d's revolute joint "allows
 * relative rotation about the z-axis" -- src/ts/joint.ts's RevoluteJoint doc comment) onto the CHASSIS's
 * own local +Y (vertical) axis -- a -90deg rotation about X. Exactly the same "rotate the joint's Z axis
 * onto the real swing axis" technique world/features/occupants/physics.ts's HINGE_AXIS_ROTATION uses for
 * elbow/knee hinges (which target the lateral X axis instead) -- see sprungPanelWeld()'s doc comment for
 * the full frameA/frameB derivation.
 */
const DOOR_HINGE_AXIS_ROTATION: Q4 = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 2);

/**
 * Which sense of the revolute's angle opens each door OUTWARD (away from the car's centerline), given
 * DOOR_HINGE_AXIS_ROTATION's fixed Z->Y mapping and this engine's standard right-hand quaternion
 * convention (rotateVector()/multiplyQuat()): a vector pointing from the hinge toward the door's
 * trailing (rear) edge rotates toward -X under a POSITIVE angle about +Y -- so a LEFT-side door
 * (+X local, doorL/doorRL) must open through NEGATIVE angles (its trailing edge needs to swing toward
 * +X, further left) and a RIGHT-side door (-X local, doorR/doorRR) opens through POSITIVE angles.
 * Derived on paper; confirmed against the eyes-on screenshots (game/verify/door-sprung/) -- flip this
 * if a future car's door layout reads backwards.
 */
const DOOR_OPEN_SIGN: Record<'doorL' | 'doorR' | 'doorRL' | 'doorRR', 1 | -1> = {
	doorL: -1,
	doorRL: -1,
	doorR: 1,
	doorRR: 1,
};

/**
 * SPRUNG (DOORS ONLY, Stream C slice C1): the latch fails but the hinge holds -- destroy the intact
 * weld (rigid or already-loosened) and replace it with a RevoluteJoint anchored at the door's LEADING
 * edge: front doors hinge at their front edge, rear doors at their OWN front edge too (adjacent to the
 * B-pillar) -- both are simply this panel's local +Z edge (car-map.ts convention: +Z = the car's nose;
 * every door's node.worldQuat is IDENTITY, so "leading edge" is always the +Z edge in the panel's own
 * body-local frame regardless of front/rear -- see createPanels()'s doc comment).
 *
 * FRAME DERIVATION (mirrors world/features/occupants/physics.ts's buildHingeFrames(), generalized: for
 * a body X whose world rotation is chassisRotation * offsetX, a joint frame LOCAL TO X whose EFFECTIVE
 * WORLD Z-axis must equal a FIXED chassis-local target axis needs frameX.rotation =
 * conjugate(offsetX) * TARGET_ROTATION, where TARGET_ROTATION maps Z onto that target axis directly).
 * Body A here is the CHASSIS itself, whose "offset from itself" is IDENTITY, so frameA.rotation is just
 * DOOR_HINGE_AXIS_ROTATION unmodified; body B is this panel, whose offset is its own nodeWorldQuat, so
 * frameB.rotation = conjugate(nodeWorldQuat) * DOOR_HINGE_AXIS_ROTATION (every door's nodeWorldQuat is
 * IDENTITY in practice, so this reduces to the same quaternion as frameA -- but the general form is kept
 * for the same reason createPanels()'s own doc comment gives: correct for ANY authored panel orientation).
 *
 * SWING LIMIT: [0, DOOR_SWING_MAX_RAD] outward via RevoluteJointOptions.enableLimit/lowerAngle/
 * upperAngle -- box3d's b3RevoluteJointDef has a real joint-limit field (unlike SphericalJoint's cone,
 * which has no directional "one-sided" limit), so no fallback approximation was needed here. Sign per
 * side: see DOOR_OPEN_SIGN.
 *
 * FILTER: deliberately UNCHANGED (still CAR_GROUP_INDEX, still EJECTED_ONLY_OCCUPANT_CATEGORY_BITS) --
 * unlike breakPanelWeld()'s neutral-groupIndex reshape. A sprung door is still swinging on a real hinge
 * millimeters from the chassis/fender/B-pillar; sharing CAR_GROUP_INDEX with the rest of the car (as it
 * always did while attached/loosened) keeps it from violently self-colliding with them -- the revolute's
 * own swing LIMIT is what stops it from clipping the fender, not a collision response. groupIndex only
 * vetoes SAME-group pairs, so normal world/ground/obstacle collision (default groupIndex 0) is completely
 * unaffected -- a sprung door swinging into a wall or tree at speed still registers real hits. This is
 * also why sprungPanelWeld(), unlike breakPanelWeld(), never touches panel.shape at all.
 */
export function sprungPanelWeld(world: World, chassis: Body, panel: PanelHandle): void {
	if (panel.weldJoint) {
		panel.weldJoint.destroy();
		panel.weldJoint = null;
	}
	const edgeBodyLocal: V3 = { x: 0, y: 0, z: panel.halfExtents.z };
	const chassisLocalAnchor = add(panel.localCenter, rotateVector(panel.nodeWorldQuat, edgeBodyLocal));
	const frameBRotation = multiplyQuat(conjugateQuat(panel.nodeWorldQuat), DOOR_HINGE_AXIS_ROTATION);
	const sign = DOOR_OPEN_SIGN[panel.key as 'doorL' | 'doorR' | 'doorRL' | 'doorRR'] ?? 1;
	const lowerAngle = sign > 0 ? 0 : -DOOR_SWING_MAX_RAD;
	const upperAngle = sign > 0 ? DOOR_SWING_MAX_RAD : 0;
	const hingeJoint = world.createRevoluteJoint(chassis, panel.body, {
		frameA: { position: chassisLocalAnchor, rotation: DOOR_HINGE_AXIS_ROTATION },
		frameB: { position: edgeBodyLocal, rotation: frameBRotation },
		collideConnected: false,
		targetAngle: 0,
		enableLimit: true,
		lowerAngle,
		upperAngle,
	});
	panel.hingeJoint = hingeJoint;
	panel.state = 'sprung';
}

/** LOOSEN: soften the intact weld IN PLACE via the runtime hertz/damping-ratio setters (src/ts/
 * joint.ts's WeldJoint.setLinearHertz/setAngularHertz/setLinearDampingRatio/setAngularDampingRatio --
 * wired for this feature, see src/wasm-shim/binding.c) -- NOT destroy+recreate. */
export function loosenPanelWeld(panel: PanelHandle, hertz: number, dampingRatio: number): void {
	if (!panel.weldJoint) return;
	panel.weldJoint.setLinearHertz(hertz);
	panel.weldJoint.setAngularHertz(hertz);
	panel.weldJoint.setLinearDampingRatio(dampingRatio);
	panel.weldJoint.setAngularDampingRatio(dampingRatio);
	panel.state = 'loosened';
}

/** BREAK: destroy the weld outright, then destroy+recreate the panel's shape with a NEUTRAL filter
 * (groupIndex 0) so the now-free panel body can hit the car and the world (it was previously immune
 * to car-vs-car collision via CAR_GROUP_INDEX -- see tuning.ts's doc comment). The panel BODY persists
 * (free, simulated, per spec) -- only the shape is swapped, preserving the same box geometry/density
 * so mass is conserved (Body.createBoxShape() recomputes body mass from ALL current shapes each call --
 * see vehicle.ts's createVehicle() note on b3UpdateBodyMassData). */
export function breakPanelWeld(panel: PanelHandle): void {
	if (panel.weldJoint) {
		panel.weldJoint.destroy();
		panel.weldJoint = null;
	}
	// A door escalating sprung -> broken has a hinge, not a weld, to destroy first (see
	// sprungPanelWeld()'s doc comment; both cannot be non-null at once).
	if (panel.hingeJoint) {
		panel.hingeJoint.destroy();
		panel.hingeJoint = null;
	}
	panel.shape.destroy(false); // skip the pointless mass recompute with zero shapes momentarily
	panel.shape = panel.body.createBoxShape({
		halfExtents: panel.halfExtents,
		density: panel.density,
		friction: PANEL_FRICTION,
		enableHitEvents: true,
		groupIndex: 0, // neutral filter: can now hit the car + world
		// Same ejected-only occupant category as the attached shape (see createPanels()): a corpse
		// still rests on a BROKEN hood lying in the grass, a seated occupant still ignores it.
		categoryBits: EJECTED_ONLY_OCCUPANT_CATEGORY_BITS,
		userData: PANEL_ENTITY_ID[panel.key],
	});
	panel.state = 'broken';
}

export function totalPanelMassKg(panels: Record<PanelKey, PanelHandle>): number {
	let sum = 0;
	for (const key of PANEL_KEYS) sum += panels[key].body.getMass();
	return sum;
}

/** Repositions every still-`attached` panel back to its rigid mount point (mirrors vehicle.ts's
 * resetVehicle() doing the same for wheel bodies). Panels already `loosened`/`broken` are left alone
 * -- full damage repair-on-reset is a known scope cut (matching the equivalent decision for a
 * detached wheel joint in vehicle.ts's resetVehicle()). */
export function resetAttachedPanels(panels: Record<PanelKey, PanelHandle>, spawnPosition: V3, spawnRotation: Q4): void {
	for (const key of PANEL_KEYS) {
		const panel = panels[key];
		if (panel.state !== 'attached') continue;
		const worldPos = add(spawnPosition, rotateVector(spawnRotation, panel.localCenter));
		const bodyRotation = multiplyQuat(spawnRotation, panel.nodeWorldQuat);
		panel.body.setTransform(worldPos, bodyRotation);
		panel.body.setLinearVelocity({ x: 0, y: 0, z: 0 });
		panel.body.setAngularVelocity({ x: 0, y: 0, z: 0 });
		panel.body.setAwake(true);
	}
}
