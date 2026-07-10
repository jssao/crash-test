// SPDX-License-Identifier: MIT
//
// 'cardetail' WorldFeature: 39 weld-attached engine-bay/interior/underbody components (spec:
// docs/build-log/specs/engine-bay-spec.md), scattered on impact. This file holds the pure-data
// component table + tuning constants -- no `three`/box3d import, so it's trivially reusable by the
// headless sim test (game/sim/features-cardetail.test.mjs imports this feature module directly, per
// feature.ts's contract note).
//
// AXIS REMAP (the spec's own §0 flags this): the spec's authoring convention is +X=forward, +Y=up,
// +Z=right. This game's actual axis convention (game/src/assets/car-map.ts) is Y-up, X-right,
// Z-forward. mmToLocalCenter() below performs the remap once: game.x = spec.z, game.y = spec.y (minus
// CHASSIS_ORIGIN_HEIGHT_M, matching damage/panels.ts's mmToLocalCenter()), game.z = spec.x.
//
// MASS POLICY (orchestrator decision, overrides the spec's §6 "reconcile ballast" note): vehicle
// tuning/ballast is NOT touched. Instead every component's spec mass is scaled down uniformly so the
// 39-part total is exactly 40kg (spec total ~506kg -> MASS_SCALE = 40/506 ~= 0.0791), keeping the
// composite chassis+welded-parts inertia shift small relative to CHASSIS_MASS_KG=1279 (~3%, safely
// inside the margin the existing 71kg of panel mass already consumes) and comfortably inside every
// existing vehicle/sim test's tolerance. Lighter parts also fly further/faster on detach, which reads
// as MORE dramatic on scatter, not less -- a happy side effect of the budget constraint.
//
// ATTACHMENT SIMPLIFICATION: the spec's per-component "attaches to" column describes a few multi-hop
// chains (e.g. alternator -> engine bracket -> chassis, hose -> radiator + engine). Every component
// here is instead welded DIRECTLY to the chassis (one weld each, mirroring damage/panels.ts's existing
// 5-panel pattern exactly) -- this keeps 39 components tractable as flat data + a single break-
// detection path, at the cost of not modeling those specific multi-hop drag-along chains (e.g. the
// spec's "block drags its still-mounted alternator with it" beat). Documented as a deliberate scope
// cut, not an oversight.
//
// BREAK MECHANISM (chosen over the polled-getConstraintForce() approach damage/welds.ts uses for
// panels): the NEW joint force/torque-threshold binding (Joint.setForceThreshold/setTorqueThreshold +
// World.jointEvents(), see tests/joint-break-events.test.ts) -- box3d's own solver-side break-event
// report, read once per fixed step in index.ts's afterFixedStep(). Per feature.ts/the task brief's
// GOTCHA, this only reports events for AWAKE joints -- fine here (same as the car's existing panels):
// every cardetail body is welded rigidly to the chassis and awake/moving with it from spawn, exactly
// like damage/panels.ts's panels, so it is always awake whenever the chassis is.
//
// THRESHOLD CALIBRATION: damage/damage-tuning.ts's own comment (PANEL_BREAK_FORCE_MULT) reports
// measured single-step constraint-force spikes in the ~1e5-1e6 N range for ANY real chassis-panel
// contact from ~30 km/h upward. The absolute Newton thresholds below are picked relative to that same
// observed range (not a mass-relative multiplier of each component's own weight, which would swing
// wildly across this table's ~0.02-3kg post-scale mass range in ways unrelated to the spec's intended
// strength tiering): 'breaksEasily' sits well below that range (fires on essentially any qualifying
// hit), 'firm' sits mid-range (needs a genuinely hard hit), 'rigid' never sets a threshold at all
// (stays at upstream's FLT_MAX default -- "omit break entirely", one of the spec's two allowed rigid
// behaviors). Verified empirically against game/sim/features-cardetail.test.mjs's 90 km/h crash.

import { CHASSIS_ORIGIN_HEIGHT_M } from '../../../vehicle/tuning';
import type { V3 } from '../../../vehicle/mathUtil';

export type Strength = 'rigid' | 'firm' | 'breaksEasily' | 'collapsible';
export type PhysShape = 'box' | 'capsuleZ' | 'capsuleX';

export interface BoxDims {
	readonly hx: number;
	readonly hy: number;
	readonly hz: number;
}
export interface CapsuleDims {
	readonly length: number;
	readonly radius: number;
}

export interface CarDetailSpec {
	readonly id: string;
	readonly label: string;
	readonly strength: Strength;
	readonly phys: PhysShape;
	readonly dims: BoxDims | CapsuleDims;
	/** Chassis-local center (meters, CHASSIS_ORIGIN_HEIGHT_M already applied), identity local rotation. */
	readonly localCenter: V3;
	readonly massKgSpec: number;
	readonly matKey: string;
	/** Hidden while the hood panel is `attached` (spec: "occluded until the hood loosens/breaks"). */
	readonly engineBay: boolean;
}

/** Spec (docX=forward, docY=up, docZ=right) -> game (Y-up, X-right, Z-forward) mm remap, matching
 * damage/panels.ts's mmToLocalCenter() convention exactly (Y offset by the chassis origin height). */
function mm(specForwardMm: number, specUpMm: number, specRightMm: number): V3 {
	return { x: specRightMm / 1000, y: specUpMm / 1000 - CHASSIS_ORIGIN_HEIGHT_M, z: specForwardMm / 1000 };
}

/** Box half-extents (meters) from (forward-depth, lateral-width, up-height) millimeters -- the spec
 * table's own "L x W x H" column ordering is followed where physically sensible, but a handful of
 * elongated/lateral-spanning parts (bench seat, dashboard, console, control arms) are re-ordered here
 * from the spec's literal column order to their obviously-intended physical axis (documented per
 * component below) -- e.g. a "1200mm long" rear bench is clearly 1200mm WIDE (lateral), not 1200mm
 * front-to-back, which would not fit in the ~1.85m cabin. */
function box(depthMm: number, lateralMm: number, upMm: number): BoxDims {
	return { hx: lateralMm / 2000, hy: upMm / 2000, hz: depthMm / 2000 };
}

function capZ(lengthMm: number, radiusMm: number): CapsuleDims {
	return { length: lengthMm / 1000, radius: radiusMm / 1000 };
}
function capX(lengthMm: number, radiusMm: number): CapsuleDims {
	return { length: lengthMm / 1000, radius: radiusMm / 1000 };
}

export const CAR_DETAIL_SPECS: readonly CarDetailSpec[] = [
	// ---- Engine bay (§1, priority 1) ----
	{ id: 'engineBlock', label: 'Engine block + head', strength: 'firm', phys: 'box', dims: box(550, 480, 620), localCenter: mm(1580, 560, 0), massKgSpec: 145, matKey: 'engineMetal', engineBay: true },
	{ id: 'turboDownpipe', label: 'Turbocharger + downpipe', strength: 'breaksEasily', phys: 'capsuleZ', dims: capZ(400, 140), localCenter: mm(1520, 430, 280), massKgSpec: 18, matKey: 'castIronHot', engineBay: true },
	{ id: 'intercooler', label: 'Intercooler', strength: 'breaksEasily', phys: 'box', dims: box(90, 650, 180), localCenter: mm(2080, 420, 0), massKgSpec: 8, matKey: 'castAluminum', engineBay: true },
	{ id: 'radiatorFan', label: 'Radiator + cooling fan', strength: 'breaksEasily', phys: 'box', dims: box(180, 700, 480), localCenter: mm(1970, 480, 0), massKgSpec: 9, matKey: 'radiatorFin', engineBay: true },
	{ id: 'upperHose', label: 'Upper radiator hose', strength: 'breaksEasily', phys: 'capsuleZ', dims: capZ(350, 19), localCenter: mm(1820, 620, -120), massKgSpec: 0.6, matKey: 'rubberBlack', engineBay: true },
	{ id: 'lowerHose', label: 'Lower radiator hose', strength: 'breaksEasily', phys: 'capsuleZ', dims: capZ(380, 21), localCenter: mm(1830, 360, -100), massKgSpec: 0.7, matKey: 'rubberBlack', engineBay: true },
	{ id: 'intakeAssembly', label: 'Intake assembly', strength: 'breaksEasily', phys: 'box', dims: box(500, 300, 350), localCenter: mm(1650, 620, -350), massKgSpec: 7, matKey: 'plasticBlackMatte', engineBay: true },
	{ id: 'battery', label: 'Battery', strength: 'breaksEasily', phys: 'box', dims: box(260, 175, 200), localCenter: mm(1420, 650, -780), massKgSpec: 15, matKey: 'plasticBlackGloss', engineBay: true },
	{ id: 'brakeBoosterMC', label: 'Brake master cylinder + booster', strength: 'firm', phys: 'box', dims: box(350, 220, 260), localCenter: mm(1180, 600, -380), massKgSpec: 9, matKey: 'castAluminum', engineBay: true },
	// Strut brace (10): spec dim order is "(span)xdepthxheight" -- span is the LATERAL lower_control-arm-
	// style long axis (bolts to both strut towers), modeled as a capsule along local X (lateral).
	{ id: 'strutBrace', label: 'Strut brace', strength: 'breaksEasily', phys: 'capsuleX', dims: capX(900, 35), localCenter: mm(1300, 780, 0), massKgSpec: 2.5, matKey: 'steelBrushed', engineBay: true },
	{ id: 'alternator', label: 'Alternator', strength: 'firm', phys: 'box', dims: box(150, 140, 160), localCenter: mm(1480, 480, -100), massKgSpec: 5, matKey: 'castAluminum', engineBay: true },
	{ id: 'coolantReservoir', label: 'Coolant + washer reservoir', strength: 'breaksEasily', phys: 'box', dims: box(300, 150, 220), localCenter: mm(1250, 700, 520), massKgSpec: 2, matKey: 'plasticTranslucentWhite', engineBay: true },
	{ id: 'fuseBox', label: 'Fuse box', strength: 'breaksEasily', phys: 'box', dims: box(220, 160, 90), localCenter: mm(1200, 680, -620), massKgSpec: 1.5, matKey: 'plasticBlackMatte', engineBay: true },

	// ---- Interior (§2, priority 2) ----
	// Driver/passenger seat (14-15): spec Y=300mm reads as the seat's H-point/floor-anchor reference,
	// not the geometric center of a 950mm-tall bounding box (centering a 950mm box AT 300mm would sink
	// its bottom 175mm below the floor). Bumped to 530mm here so the box's actual geometric center
	// clears the ground with a small margin -- caught empirically: a ground-penetrating box RIGIDLY
	// welded to the chassis fights the ground-contact solver every step (a large, contradictory
	// correction impulse against a 0-hertz "must move exactly with the chassis" constraint), which was
	// found to stall the whole car's driveline, not just visually clip -- see
	// game/sim/features-cardetail.test.mjs's drive-up-to-a-wall scenario, which caught this directly
	// (the car would not accelerate at all with any of these 4 components at their literal spec Y).
	{ id: 'driverSeat', label: 'Driver seat', strength: 'firm', phys: 'box', dims: box(500, 550, 950), localCenter: mm(700, 530, -380), massKgSpec: 18, matKey: 'clothBlack', engineBay: false },
	{ id: 'passengerSeat', label: 'Passenger seat', strength: 'firm', phys: 'box', dims: box(500, 550, 950), localCenter: mm(700, 530, 380), massKgSpec: 18, matKey: 'clothBlack', engineBay: false },
	// Rear bench (16): re-ordered from spec's literal "1200x500x800" -- 1200mm is clearly the LATERAL
	// width (spans both rear seats), not a front-to-back depth (the whole cabin is only ~1.85m deep).
	// Y bumped 280->460mm for the same ground-clearance reason as the front seats above.
	{ id: 'rearBench', label: 'Rear bench', strength: 'firm', phys: 'box', dims: box(500, 1200, 800), localCenter: mm(-500, 460, 0), massKgSpec: 22, matKey: 'clothBlack', engineBay: false },
	// Dashboard (17): re-ordered -- 1400mm is the lateral span (A-pillar to A-pillar), 250mm the
	// front-back depth, 350mm the binnacle height. Nudged 20mm back (950->930) -- the audit found the
	// spec's literal value pokes ~4mm past the real InteriorCage node's forward Z bound (car-map.ts
	// chassis.InteriorCage), which read as the box clipping into the windshield/hood boundary.
	{ id: 'dashboard', label: 'Dashboard', strength: 'firm', phys: 'box', dims: box(250, 1400, 350), localCenter: mm(930, 850, 0), massKgSpec: 20, matKey: 'plasticBlackMatte', engineBay: false },
	// Steering wheel + column (18): positioned at the midpoint of the spec's wheel-center and firewall-
	// mount points; COLLAPSIBLE (see index.ts's 2-stage weld handling: collapse then break).
	{
		id: 'steeringColumn',
		label: 'Steering wheel + column',
		strength: 'collapsible',
		phys: 'capsuleZ',
		dims: capZ(550, 22.5),
		localCenter: mm((900 + 1150) / 2, (620 + 600) / 2, -380),
		massKgSpec: 7,
		matKey: 'clothBlack',
		engineBay: false,
	},
	// Center console (19): re-ordered -- 700mm is the front-back span (dash to between the seats), 350mm
	// the lateral width (narrow, fits between the two seats), 250mm the height.
	{ id: 'centerConsole', label: 'Center console + shifter', strength: 'firm', phys: 'box', dims: box(700, 350, 250), localCenter: mm(550, 400, 0), massKgSpec: 9, matKey: 'plasticBlackGloss', engineBay: false },
	// Y bumped 150->230mm for the same ground-clearance reason as the seats above.
	{ id: 'pedalCluster', label: 'Pedal cluster', strength: 'firm', phys: 'box', dims: box(300, 250, 350), localCenter: mm(750, 230, -400), massKgSpec: 4, matKey: 'steelBrushed', engineBay: false },
	{ id: 'rearviewMirror', label: 'Rearview mirror', strength: 'breaksEasily', phys: 'box', dims: box(60, 250, 80), localCenter: mm(780, 1080, 0), massKgSpec: 0.3, matKey: 'plasticBlackMatte', engineBay: false },

	// ---- Underbody / extremities (§3, priority 3) ----
	{ id: 'catConverter', label: 'Catalytic converter', strength: 'firm', phys: 'capsuleZ', dims: capZ(300, 90), localCenter: mm(700, 280, 150), massKgSpec: 7, matKey: 'stainlessBrushed', engineBay: false },
	// REAR-OVERHANG CORRECTION (found by the numeric audit, game/sim/cardetail-containment.test.mjs):
	// the spec's own §0 assumes a 4600mm-overall/~850mm-rear-overhang car and flags this explicitly
	// ("treat the extra ~240mm as slack... or scale every X position"). The REAL asset (car-map.ts
	// overallDimsMm) is 4357mm overall, and nearly ALL of that ~243mm shortfall sits in the REAR
	// overhang specifically (measured real rear overhang, rear-axle-Z to rear-most-body-Z, is only
	// ~626mm vs the spec's assumed 850mm -- the FRONT overhang matches the real asset almost exactly,
	// ~931mm vs assumed 950mm). Taking the spec's rear-mounted X values literally therefore pokes
	// mufflerTailpipe/rearBumperBeam/taillightL/R 265-380mm out the back of the real body envelope.
	// Repositioned (Z only, forward toward the axle) so each sits fully inside the measured envelope
	// with a small (~30-40mm) clearance margin instead of clipping through the rear bumper skin.
	{ id: 'mufflerTailpipe', label: 'Muffler + tailpipe', strength: 'firm', phys: 'box', dims: box(700, 200, 180), localCenter: mm(-1550, 260, 200), massKgSpec: 12, matKey: 'stainlessBrushed', engineBay: false },
	{ id: 'fuelTank', label: 'Fuel tank', strength: 'rigid', phys: 'box', dims: box(900, 500, 250), localCenter: mm(-1150, 280, 0), massKgSpec: 40, matKey: 'steelMattePowder', engineBay: false },
	{ id: 'frontSubframe', label: 'Front subframe', strength: 'rigid', phys: 'box', dims: box(1000, 900, 200), localCenter: mm(1450, 280, 0), massKgSpec: 35, matKey: 'steelMattePowder', engineBay: false },
	{ id: 'rearSubframe', label: 'Rear subframe', strength: 'rigid', phys: 'box', dims: box(950, 900, 200), localCenter: mm(-1450, 280, 0), massKgSpec: 30, matKey: 'steelMattePowder', engineBay: false },
	{ id: 'driveshaft', label: 'Driveshaft', strength: 'firm', phys: 'capsuleZ', dims: capZ(1400, 35), localCenter: mm(-150, 260, 0), massKgSpec: 9, matKey: 'steelBrushed', engineBay: false },
	// Control arms (28-31): re-ordered -- the spec's first dim (450/420mm) is the arm's LENGTH, which
	// spans mostly LATERALLY (inner bushing near the centerline to the outer ball joint at the hub), not
	// front-to-back.
	// MUSTANG-65 REFIT: lateral centre pulled 850 -> 720mm so the arm's 450mm span (half 225mm) stays
	// inside the narrower Mustang body (car-map half-width ~968mm vs the concept car's ~1271mm).
	{ id: 'flControlArm', label: 'Front-left lower control arm', strength: 'firm', phys: 'box', dims: box(100, 450, 80), localCenter: mm(1350, 320, -720), massKgSpec: 5, matKey: 'steelBrushed', engineBay: false },
	{ id: 'frControlArm', label: 'Front-right lower control arm', strength: 'firm', phys: 'box', dims: box(100, 450, 80), localCenter: mm(1350, 320, 720), massKgSpec: 5, matKey: 'steelBrushed', engineBay: false },
	{ id: 'rlControlArm', label: 'Rear-left lower control arm', strength: 'firm', phys: 'box', dims: box(100, 420, 80), localCenter: mm(-1350, 320, -720), massKgSpec: 6, matKey: 'steelBrushed', engineBay: false },
	{ id: 'rrControlArm', label: 'Rear-right lower control arm', strength: 'firm', phys: 'box', dims: box(100, 420, 80), localCenter: mm(-1350, 320, 720), massKgSpec: 6, matKey: 'steelBrushed', engineBay: false },
	// Bumper beams (32-33): "span" bars, modeled as a lateral (local X) capsule, same rationale as the
	// strut brace above.
	{ id: 'frontBumperBeam', label: 'Front bumper beam', strength: 'firm', phys: 'capsuleX', dims: capX(1300, 55), localCenter: mm(2230, 430, 0), massKgSpec: 8, matKey: 'steelMattePowder', engineBay: false },
	// Rear-overhang correction (see mufflerTailpipe's comment above) -- moved forward from the spec's
	// literal -2150mm so the beam's box sits inside the real rear envelope instead of poking through.
	{ id: 'rearBumperBeam', label: 'Rear bumper beam', strength: 'firm', phys: 'capsuleX', dims: capX(1250, 55), localCenter: mm(-1850, 430, 0), massKgSpec: 9, matKey: 'steelMattePowder', engineBay: false },
	// Headlights (36-37): tiny (~9mm) front-overhang overshoot from the same spec/real-asset mismatch
	// (see mufflerTailpipe's comment) -- nudged back 30mm to clear the real front envelope.
	// MUSTANG-65 REFIT: lateral centre 850 -> 760mm (headlight/taillight 350/300mm width inside the
	// narrower body) and headlight forward-Z 2170 -> 2120mm so its 450mm-deep box stays inside the
	// measured front envelope (car-map whole-body zMax ~2.36m).
	{ id: 'headlightL', label: 'Headlight L', strength: 'breaksEasily', phys: 'box', dims: box(450, 350, 250), localCenter: mm(2120, 620, -760), massKgSpec: 3.5, matKey: 'lensClear', engineBay: false },
	{ id: 'headlightR', label: 'Headlight R', strength: 'breaksEasily', phys: 'box', dims: box(450, 350, 250), localCenter: mm(2120, 620, 760), massKgSpec: 3.5, matKey: 'lensClear', engineBay: false },
	// Rear-overhang correction (see mufflerTailpipe's comment above).
	{ id: 'taillightL', label: 'Taillight L', strength: 'breaksEasily', phys: 'box', dims: box(400, 300, 200), localCenter: mm(-1700, 620, -760), massKgSpec: 1.8, matKey: 'lensRed', engineBay: false },
	{ id: 'taillightR', label: 'Taillight R', strength: 'breaksEasily', phys: 'box', dims: box(400, 300, 200), localCenter: mm(-1700, 620, 760), massKgSpec: 1.8, matKey: 'lensRed', engineBay: false },
	// Side mirrors (38-39): "projects outboard" -- the spec's first dim (200mm) is explicitly the
	// outboard (lateral) projection, so lateral is re-ordered to the first column here. FOUND BY THE
	// AUDIT: the spec's literal specUp=1150mm (ground-referenced) sits almost exactly at the real
	// roofline (car-map.ts overallDimsMm.height=1149mm), so the mirror box's top face poked ~91mm
	// above the roof ("floating cubes at the A-pillars" the orchestrator's screenshot showed) --
	// dropped to 950mm (roughly beltline/greenhouse height, well clear of the roof). Also pulled the
	// lateral offset in from 1250mm to 1160mm so the box's outboard face stays inside the real overall
	// width envelope (car-map.ts overallDimsMm.width=2542mm, half=1271mm) while still projecting a
	// realistic ~90mm past the door's own outer surface (car-map.ts panels.BodyDoorLColor1, X up to
	// ~1169mm).
	// MUSTANG-65 REFIT: lateral centre 1160 -> 840mm -- the narrower Mustang body (car-map
	// overallDimsMm.width 1936mm, half 968mm) sits the mirror's outboard face at ~940mm, right at the
	// flank (was tuned to the concept car's 2542mm/half-1271mm body); still projects ~40mm past the
	// door's outer surface (car-map DoorL X up to ~905mm).
	{ id: 'mirrorL', label: 'Side mirror L', strength: 'breaksEasily', phys: 'box', dims: box(150, 200, 180), localCenter: mm(550, 950, -840), massKgSpec: 0.9, matKey: 'paintGeneric', engineBay: false },
	{ id: 'mirrorR', label: 'Side mirror R', strength: 'breaksEasily', phys: 'box', dims: box(150, 200, 180), localCenter: mm(550, 950, 840), massKgSpec: 0.9, matKey: 'paintGeneric', engineBay: false },
];

/**
 * Exterior proxy parts (headlights, taillights, mirrors, bumper beams) -- the GLB body already
 * renders painted lights/mirrors/bumper covers at these locations, so a grey collision-proxy box
 * glued on top of that pretty bodywork reads as a visible defect ("protruding grey boxes") even when
 * its AABB is geometrically contained. VISIBILITY POLICY (orchestrator directive): these stay
 * INVISIBLE while `attached` (index.ts's applyVisuals()) -- flying debris on detach sells the crash,
 * a grey box glued to intact paint does not. Interior/underbody/engine-bay parts are unaffected by
 * this set (engine-bay keeps its own separate hood-gated visibility; interior/underbody stay visible
 * throughout, per the spec's "seen through glass" / "seen from below" intent).
 */
export const EXTERIOR_PROXY_IDS: ReadonlySet<string> = new Set([
	'frontBumperBeam',
	'rearBumperBeam',
	'headlightL',
	'headlightR',
	'taillightL',
	'taillightR',
	'mirrorL',
	'mirrorR',
]);

/** Sum of every component's UNSCALED spec mass -- exists only so MASS_SCALE's derivation below is
 * self-checking (rather than a hand-copied "506" that could drift from the table above). */
const SPEC_MASS_TOTAL_KG = CAR_DETAIL_SPECS.reduce((sum, s) => sum + s.massKgSpec, 0);

/** Target total attached mass (kg), per the orchestrator's mass policy (see this file's top comment). */
export const TARGET_TOTAL_MASS_KG = 40;

export const MASS_SCALE = TARGET_TOTAL_MASS_KG / SPEC_MASS_TOTAL_KG;

/** Floor so the lightest parts (rearview mirror: 0.3kg spec -> ~0.024kg scaled) still get a sane,
 * numerically stable density/mass rather than a near-zero value. */
export const MASS_FLOOR_KG = 0.05;

export function scaledMassKg(spec: CarDetailSpec): number {
	return Math.max(MASS_FLOOR_KG, spec.massKgSpec * MASS_SCALE);
}

// ---------------------------------------------------------------------------------------------
// Break thresholds (Joint.setForceThreshold/setTorqueThreshold -- see this file's top comment).
// ---------------------------------------------------------------------------------------------

// TUNING DELTA (measured directly, both scenarios via game/sim/features-cardetail.test.mjs and its
// calibration runs): a direct chassis weld (not at the impact contact itself, unlike damage/panels.ts's
// panels, whose OWN shape touches the wall) sees the CHASSIS's inertial reaction transmitted through
// the weld, not the huge contact-resolution spike a panel-at-the-contact-point sees -- measured peak
// Joint.getConstraintForce() for a 90 km/h wall crash's non-impact-adjacent breaksEasily parts lands in
// the tens-to-low-thousands-of-newtons range (fuseBox ~101N, coolantReservoir ~125N, strutBrace ~161N,
// intakeAssembly ~460N, intercooler ~514N, battery ~1009N, radiatorFan ~1593N, headlights ~18-19kN), a
// full 2-3 orders of magnitude below damage-tuning.ts's panel-calibrated 1e5-1e6N range -- so these
// thresholds are picked against THIS measured range, not damage-tuning.ts's. Also measured a clean 4s
// full-throttle-then-hard-brake-and-swerve BENIGN drive (no crash) to make sure ordinary aggressive
// driving alone doesn't false-trigger a break: the same breaksEasily parts peak at just 3-75N during
// that benign run (worst case turboDownpipe ~75N; torques peak ~13Nm, on a 'firm' part) -- comfortably
// (~15-40x) below every one of the crash values above. BREAKS_EASILY_FORCE_N=90 sits in the ~15N gap
// between the benign peak (75) and the tightest crash value (fuseBox 101), which held up across
// repeated runs despite ~1% run-to-run float-sum jitter.
// Raised from an initial 90 -- found (game/sim/features-cardetail.test.mjs's benign-driving check)
// that breaking ONE part shifts the chassis-welded system's dynamics enough to occasionally push a
// SECOND, otherwise-comfortably-under-threshold part's peak force up past a threshold sitting close
// to its own clean (no-cascade) benign-driving peak. 200 keeps a much larger margin above every
// breaksEasily part's clean benign peak (turboDownpipe ~75N, battery ~65N, all others lower) while
// still well below the crash values that matter (intercooler ~514N, radiatorFan ~1593N, intakeAssembly
// ~460N, battery ~1009N, turboDownpipe breaks readily at actual impact) -- comfortably >=5 engine-bay
// parts still detach in the 90 km/h crash scenario.
export const BREAKS_EASILY_FORCE_N = 200;
export const BREAKS_EASILY_TORQUE_NM = 500;

export const FIRM_FORCE_N = 200_000;
export const FIRM_TORQUE_NM = 150_000;

/** Collapsible steering column, stage 1 ("collapsed", spec §0's 4th strength class): softer/lower
 * than 'firm' -- a real column is meant to give way well before a firm-mounted bracket would. */
export const COLLAPSE_FORCE_N = 60_000;
export const COLLAPSE_TORQUE_NM = 40_000;
/** Stage 2 (full break, after collapse) -- a harder second hit finishes the job. */
export const COLUMN_BREAK_FORCE_N = 400_000;
export const COLUMN_BREAK_TORQUE_NM = 300_000;

/** Weld softening applied at the collapse stage (mirrors damage/panels.ts's loosenPanelWeld() runtime
 * hertz/damping softening -- kept as this feature's OWN constants, not an import from damage-tuning.ts,
 * per the WorldFeature contract's "self-contained folder" convention. */
export const COLLAPSE_HERTZ = 4;
export const COLLAPSE_DAMPING_RATIO = 0.15;

// ---------------------------------------------------------------------------------------------
// Entity/userData id ranges -- chosen large + distinctive to avoid colliding with any other joint's
// userData in the world (existing wheel/weld joints all default to 0; other parallel-worker features
// are unknown but conventionally use small integers, per vehicle.ts's CAR_ENTITY_ID/panels.ts's
// PANEL_ENTITY_ID doc comments) -- World.jointEvents() is a GLOBAL per-step buffer, so a numeric
// collision would misattribute another feature's joint-break event to one of these components.
// ---------------------------------------------------------------------------------------------

export const CARDETAIL_BODY_ID_BASE = 88_200_000;
export const CARDETAIL_JOINT_ID_BASE = 88_100_000;

export const OTHER_MISC = {
	friction: 0.7,
	restitution: 0.15,
};
