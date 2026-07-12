// SPDX-License-Identifier: MIT
//
// 'cardetail' WorldFeature: weld-attached engine-bay/interior/underbody components (spec:
// docs/build-log/specs/engine-bay-spec.md), scattered on impact. This file holds the pure-data
// component table + tuning constants -- no `three`/box3d import, so it's trivially reusable by the
// headless sim test (game/sim/features-cardetail.test.mjs imports this feature module directly, per
// feature.ts's contract note).
//
// TIER-3 STAGE 3 (open engine bay, docs/build-log/specs/compound-hull-design.md): retires the
// blanket "every attached part is a sensor" rule -- see ATTACHED_SENSOR_OVERRIDE_IDS below (the 3
// parts, of 27, that measurably still need it) and index.ts's createShapeFor()/breakComponent() doc
// comments for the full mechanism + what's still gated on a chassis-side (not this file's) change.
//
// MUSTANG-65 MODEL-FIRST CULL (orchestrator directive, "i want the model's models to be the ones
// that are used"): the spec below was originally written for a generic modern turbocharged sports
// coupe (Khronos CarConcept.glb) and ported wholesale onto the Mustang-65 hero asset, which already
// models most engine-bay/interior internals itself (see split-mustang.py's EngineBlock/Drivetrain
// sub-split -- verified by rendering those nodes in isolation: a carbureted V8 with a round air-
// cleaner lid, valve covers, distributor + plug wires, exhaust headers feeding dual pipes, a
// driveshaft with U-joint yokes, and a rear diff/axle -- and by the "seat_rubber" material name found
// on the single 'body' vertex group, i.e. the seats/dash/console/wheel are already molded into
// BodyShell). This produced two kinds of defect an in-game screenshot audit confirmed directly: (1)
// procedural grey interior boxes (dashboard/steering column/console/pedal cluster/seats) visible
// THROUGH the glass, duplicating/occluding the model's own molded cabin, and (2) a period-wrong
// forced-induction subsystem (turbo + intercooler + charge-piping intake) and a catalytic converter
// on a 1965 car -- catalytic converters were not mandated/fitted on ANY US car until the 1975 model
// year, 10 years after this car. The full cull:
//   REMOVED entirely (physics body + weld + mesh -- the whole interior set the model already renders,
//   plus every period-wrong/duplicated item):
//     driverSeat, passengerSeat, rearBench, dashboard, steeringColumn, centerConsole, pedalCluster,
//     rearviewMirror (interior -- model already has all of these, see 'seat_rubber' material above)
//     turboDownpipe, intercooler, intakeAssembly (forced-induction plumbing a carbureted '65 V8 never
//       had -- the model's real air-cleaner-on-a-carburetor is what actually sits there)
//     catConverter (anachronistic -- didn't exist yet in 1965)
//   KEPT but reclassified as MODELED_PROXY (mesh invisible while attached -- the model already shows
//   this component, so the grey box only earns its keep as the flying-debris MASS once detached, same
//   established pattern as 'engineBlock'): driveshaft, mufflerTailpipe (both plainly visible in the
//   split-out Drivetrain node's own geometry -- no new GLB re-export needed, the node already exists).
//   Everything else (radiator+fan, hoses, battery, brake booster, strut brace, alternator, coolant
//   reservoir, fuse box, fuel tank, subframes, control arms, bumper beams, lights, mirrors) is
//   UNCHANGED: the model does not render these distinctly (or, for battery, deliberately duplicates
//   nothing so its mass survives for scatter -- see MODELED_PROXY_IDS's doc comment), so a procedural
//   proxy is still the right call.
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

// VOLVO S90 SWAP RE-DERIVATION (2026-07-11): every position below rescaled from the Mustang-tuned
// values. LENGTH_SCALE = S90/Mustang overall length (5002/4591 = 1.0895) applied to every
// specForwardMm (Z position, this file's mm()'s 1st arg). WIDTH_SCALE = S90/Mustang overall body
// width (2011/1936 = 1.0389) applied to every specRightMm (X/lateral position, mm()'s 3rd arg) EXCEPT
// the 4 control arms, which use the much smaller TRACK-width ratio (S90/Mustang front track
// 1629/1619 = 1.0062 -- barely changed) since their lateral position is tied to the wheel/suspension
// track, not the overall body width (the body-width ratio would have pushed their outboard tip past
// the S90's own tire's outer face). specUpMm (height, mm()'s 2nd arg) is left UNCHANGED -- component
// mounting heights are not meaningfully car-length/width-dependent, and (per the interior-culled note
// below) Y already runs through the auto-updating CHASSIS_ORIGIN_HEIGHT_M subtraction. Two positions
// needed a small manual nudge past the scale to stay inside the S90's measured envelope
// (headlightL/R, see that entry's comment) -- every other scaled position was checked to still land
// inside the S90's measured whole-body/panel envelopes (car-map.ts) with the same ~30-40mm margin
// convention the original Mustang refit used.
export const CAR_DETAIL_SPECS: readonly CarDetailSpec[] = [
	// ---- Engine bay (§1, priority 1) ----
	{ id: 'engineBlock', label: 'Engine block + head', strength: 'firm', phys: 'box', dims: box(550, 480, 620), localCenter: mm(1721, 560, 0), massKgSpec: 145, matKey: 'engineMetal', engineBay: true },
	// turboDownpipe/intercooler/intakeAssembly (forced-induction subsystem) CULLED here -- period-wrong
	// for a 1965 Mustang (naturally-aspirated, carbureted V8); see this file's top doc comment.
	{ id: 'radiatorFan', label: 'Radiator + cooling fan', strength: 'breaksEasily', phys: 'box', dims: box(180, 700, 480), localCenter: mm(2146, 480, 0), massKgSpec: 9, matKey: 'radiatorFin', engineBay: true },
	{ id: 'upperHose', label: 'Upper radiator hose', strength: 'breaksEasily', phys: 'capsuleZ', dims: capZ(350, 19), localCenter: mm(1983, 620, -125), massKgSpec: 0.6, matKey: 'rubberBlack', engineBay: true },
	{ id: 'lowerHose', label: 'Lower radiator hose', strength: 'breaksEasily', phys: 'capsuleZ', dims: capZ(380, 21), localCenter: mm(1994, 360, -104), massKgSpec: 0.7, matKey: 'rubberBlack', engineBay: true },
	{ id: 'battery', label: 'Battery', strength: 'breaksEasily', phys: 'box', dims: box(260, 175, 200), localCenter: mm(1547, 650, -810), massKgSpec: 15, matKey: 'plasticBlackGloss', engineBay: true },
	{ id: 'brakeBoosterMC', label: 'Brake master cylinder + booster', strength: 'firm', phys: 'box', dims: box(350, 220, 260), localCenter: mm(1286, 600, -395), massKgSpec: 9, matKey: 'castAluminum', engineBay: true },
	// Strut brace (10): spec dim order is "(span)xdepthxheight" -- span is the LATERAL lower_control-arm-
	// style long axis (bolts to both strut towers), modeled as a capsule along local X (lateral).
	{ id: 'strutBrace', label: 'Strut brace', strength: 'breaksEasily', phys: 'capsuleX', dims: capX(900, 35), localCenter: mm(1416, 780, 0), massKgSpec: 2.5, matKey: 'steelBrushed', engineBay: true },
	{ id: 'alternator', label: 'Alternator', strength: 'firm', phys: 'box', dims: box(150, 140, 160), localCenter: mm(1612, 480, -104), massKgSpec: 5, matKey: 'castAluminum', engineBay: true },
	{ id: 'coolantReservoir', label: 'Coolant + washer reservoir', strength: 'breaksEasily', phys: 'box', dims: box(300, 150, 220), localCenter: mm(1362, 700, 540), massKgSpec: 2, matKey: 'plasticTranslucentWhite', engineBay: true },
	{ id: 'fuseBox', label: 'Fuse box', strength: 'breaksEasily', phys: 'box', dims: box(220, 160, 90), localCenter: mm(1307, 680, -644), massKgSpec: 1.5, matKey: 'plasticBlackMatte', engineBay: true },

	// ---- Interior (§2, priority 2) ----
	// ALL 8 interior components (driverSeat, passengerSeat, rearBench, dashboard, steeringColumn,
	// centerConsole, pedalCluster, rearviewMirror) CULLED here (orchestrator directive) -- the Mustang
	// model's single 'body' vertex group already carries a 'seat_rubber' material and molds in the
	// dash/console/wheel/pedals, so these procedural boxes were pure grey-box duplicates visible
	// through the glass (screenshot-confirmed: game/verify/audit-cardetail/interior-through-side-
	// glass.png before this cull showed grey dashboard/steering-column/console shapes floating inside
	// the model's own molded cabin). See this file's top doc comment. STAYS CULLED for the S90 swap --
	// the S90 GLB molds its own Dashboard/CenterConsole/SteeringWheel/Driver+Passenger+Rear Seats
	// meshes (see export-validation.json), same "model's models" rationale.

	// ---- Underbody / extremities (§3, priority 3) ----
	// catConverter CULLED here -- catalytic converters did not exist on any 1965 car (first mandated
	// for the 1975 US model year); see this file's top doc comment.
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
	// S90 SWAP: the mufflerTailpipe proxy stays MODELED_PROXY (hidden while attached) -- the S90 GLB
	// has a real "Exhaust System" mesh node (measured world z -2.42..-1.81, x +-0.78) roughly matching
	// this proxy's rear-underbody position, unlike engineBlock/driveshaft below (see MODELED_PROXY_IDS).
	{ id: 'mufflerTailpipe', label: 'Muffler + tailpipe', strength: 'firm', phys: 'box', dims: box(700, 200, 180), localCenter: mm(-1689, 260, 208), massKgSpec: 12, matKey: 'stainlessBrushed', engineBay: false },
	{ id: 'fuelTank', label: 'Fuel tank', strength: 'rigid', phys: 'box', dims: box(900, 500, 250), localCenter: mm(-1253, 280, 0), massKgSpec: 40, matKey: 'steelMattePowder', engineBay: false },
	{ id: 'frontSubframe', label: 'Front subframe', strength: 'rigid', phys: 'box', dims: box(1000, 900, 200), localCenter: mm(1580, 280, 0), massKgSpec: 35, matKey: 'steelMattePowder', engineBay: false },
	{ id: 'rearSubframe', label: 'Rear subframe', strength: 'rigid', phys: 'box', dims: box(950, 900, 200), localCenter: mm(-1580, 280, 0), massKgSpec: 30, matKey: 'steelMattePowder', engineBay: false },
	// S90 SWAP: driveshaft is NO LONGER a MODELED_PROXY (the S90 GLB has no modeled drivetrain/
	// driveshaft node, unlike the Mustang's split-mustang.py Drivetrain sub-split) -- its procedural box
	// is now VISIBLE while attached (see MODELED_PROXY_IDS below).
	{ id: 'driveshaft', label: 'Driveshaft', strength: 'firm', phys: 'capsuleZ', dims: capZ(1400, 35), localCenter: mm(-163, 260, 0), massKgSpec: 9, matKey: 'steelBrushed', engineBay: false },
	// Control arms (28-31): re-ordered -- the spec's first dim (450/420mm) is the arm's LENGTH, which
	// spans mostly LATERALLY (inner bushing near the centerline to the outer ball joint at the hub), not
	// front-to-back.
	// MUSTANG-65 REFIT: lateral centre pulled 850 -> 720mm so the arm's 450mm span (half 225mm) stays
	// inside the narrower Mustang body (car-map half-width ~968mm vs the concept car's ~1271mm).
	// S90 SWAP: lateral centre kept at 720mm (the S90/Mustang front TRACK ratio is 1629/1619 = 1.0062,
	// negligible) -- using the overall body-width ratio instead would have pushed the arm's outboard
	// tip (720+225=945mm) past the S90 front wheel's own outer tire face (~939mm), a visible overshoot.
	{ id: 'flControlArm', label: 'Front-left lower control arm', strength: 'firm', phys: 'box', dims: box(100, 450, 80), localCenter: mm(1471, 320, -720), massKgSpec: 5, matKey: 'steelBrushed', engineBay: false },
	{ id: 'frControlArm', label: 'Front-right lower control arm', strength: 'firm', phys: 'box', dims: box(100, 450, 80), localCenter: mm(1471, 320, 720), massKgSpec: 5, matKey: 'steelBrushed', engineBay: false },
	{ id: 'rlControlArm', label: 'Rear-left lower control arm', strength: 'firm', phys: 'box', dims: box(100, 420, 80), localCenter: mm(-1471, 320, -720), massKgSpec: 6, matKey: 'steelBrushed', engineBay: false },
	{ id: 'rrControlArm', label: 'Rear-right lower control arm', strength: 'firm', phys: 'box', dims: box(100, 420, 80), localCenter: mm(-1471, 320, 720), massKgSpec: 6, matKey: 'steelBrushed', engineBay: false },
	// Bumper beams (32-33): "span" bars, modeled as a lateral (local X) capsule, same rationale as the
	// strut brace above.
	{ id: 'frontBumperBeam', label: 'Front bumper beam', strength: 'firm', phys: 'capsuleX', dims: capX(1300, 55), localCenter: mm(2430, 430, 0), massKgSpec: 8, matKey: 'steelMattePowder', engineBay: false },
	// Rear-overhang correction (see mufflerTailpipe's comment above) -- moved forward from the spec's
	// literal -2150mm so the beam's box sits inside the real rear envelope instead of poking through.
	{ id: 'rearBumperBeam', label: 'Rear bumper beam', strength: 'firm', phys: 'capsuleX', dims: capX(1250, 55), localCenter: mm(-2016, 430, 0), massKgSpec: 9, matKey: 'steelMattePowder', engineBay: false },
	// Headlights (36-37): tiny (~9mm) front-overhang overshoot from the same spec/real-asset mismatch
	// (see mufflerTailpipe's comment) -- nudged back 30mm to clear the real front envelope.
	// MUSTANG-65 REFIT: lateral centre 850 -> 760mm (headlight/taillight 350/300mm width inside the
	// narrower body) and headlight forward-Z 2170 -> 2120mm so its 450mm-deep box stays inside the
	// measured front envelope (car-map whole-body zMax ~2.36m).
	// S90 SWAP: the length-scaled forward position (2120*1.0895=2310mm) would put this box's front face
	// (2310+225=2535mm) 18mm PAST the S90's measured whole-body zMax (2517mm, car-map.ts
	// overallCenterMm.z/1000 + CAR_LENGTH_M/2) -- manually nudged back to 2250mm instead (front face
	// 2475mm, ~40mm clearance, matching this file's established margin convention). Lateral scaled by
	// the body-width ratio (1.0389): 760 -> 790mm.
	{ id: 'headlightL', label: 'Headlight L', strength: 'breaksEasily', phys: 'box', dims: box(450, 350, 250), localCenter: mm(2250, 620, -790), massKgSpec: 3.5, matKey: 'lensClear', engineBay: false },
	{ id: 'headlightR', label: 'Headlight R', strength: 'breaksEasily', phys: 'box', dims: box(450, 350, 250), localCenter: mm(2250, 620, 790), massKgSpec: 3.5, matKey: 'lensClear', engineBay: false },
	// Rear-overhang correction (see mufflerTailpipe's comment above).
	{ id: 'taillightL', label: 'Taillight L', strength: 'breaksEasily', phys: 'box', dims: box(400, 300, 200), localCenter: mm(-1852, 620, -790), massKgSpec: 1.8, matKey: 'lensRed', engineBay: false },
	{ id: 'taillightR', label: 'Taillight R', strength: 'breaksEasily', phys: 'box', dims: box(400, 300, 200), localCenter: mm(-1852, 620, 790), massKgSpec: 1.8, matKey: 'lensRed', engineBay: false },
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
	// S90 SWAP: forward/lateral scaled by the length/width ratios (550->599mm, 840->873mm).
	{ id: 'mirrorL', label: 'Side mirror L', strength: 'breaksEasily', phys: 'box', dims: box(150, 200, 180), localCenter: mm(599, 950, -873), massKgSpec: 0.9, matKey: 'paintGeneric', engineBay: false },
	{ id: 'mirrorR', label: 'Side mirror R', strength: 'breaksEasily', phys: 'box', dims: box(150, 200, 180), localCenter: mm(599, 950, 873), massKgSpec: 0.9, matKey: 'paintGeneric', engineBay: false },
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
/**
 * Parts whose VISUAL is now provided by a modeled GLB mesh, so their procedural collision proxy stays
 * INVISIBLE while attached and only appears as flying debris once it detaches -- same visibility policy
 * as EXTERIOR_PROXY_IDS. MUSTANG-65 SWAP (orchestrator directive: "modeled EngineBlock replaces the
 * procedural block as the heavy detachable"): the split-out EngineBlock node renders the REAL modeled
 * engine in the bay (scene/carDeformables), so the procedural 'engineBlock' box no longer needs to
 * render a grey slab on top of it -- it remains the heavy detachable MASS that flies out on a hard
 * frontal, just with no visible proxy while it is still bolted in.
 *
 * MODEL-FIRST CULL ADDITIONS (driveshaft, mufflerTailpipe): isolated + rendered the split-out
 * Drivetrain node alone (Blender, `EngineBlock`'s sibling) and found it already models a driveshaft
 * with U-joint yokes running to a rear diff/axle, AND a dual exhaust pipe run ending in a Y-split
 * tailpipe tip -- i.e. the exact geometry these two procedural boxes were standing in for. No new GLB
 * re-export was needed (Drivetrain already exists, split-mustang.py's original EngineBlock/Drivetrain
 * divide already isolates it) -- same "hide the box, let the model be the crash's normal visual, box
 * only earns its keep as the flying-debris MASS" treatment as engineBlock above.
 *
 * VOLVO S90 SWAP (2026-07-11), REVERSED for engineBlock/driveshaft: unlike the Mustang, the S90 GLB
 * has NO modeled engine -- its own "EngineBlock" node is a 72-vertex/36-face FILLER box (an empty bay
 * under the hood, per the swap-plan's P0-A blend inventory), and there is no Drivetrain/driveshaft
 * node at all. Hiding the procedural engineBlock/driveshaft proxies here would leave both spaces
 * genuinely EMPTY (worse than a grey box) -- so both are REMOVED from this set, making their proxies
 * VISIBLE while attached again (the "grey box IS the crash's normal visual" fallback, same as any
 * other non-modeled underbody part in this table). mufflerTailpipe STAYS modeled-proxy: the S90 GLB
 * does have a real "Exhaust System" mesh node (measured world z -2.42..-1.81, x +-0.78, roughly
 * matching this proxy's rear-underbody position), so hiding the grey box behind it is still correct.
 */
export const MODELED_PROXY_IDS: ReadonlySet<string> = new Set(['mufflerTailpipe']);

/**
 * TIER-3 STAGE 3 (open engine bay, docs/build-log/specs/compound-hull-design.md): parts in this set
 * stay SENSORS while `attached` (index.ts's createShapeFor()) -- every OTHER component is now SOLID
 * while attached (real collision with world/debris, the whole point of this stage), see that file's
 * doc comment for the mechanism. This is the "keep sensors for the specific offending parts only"
 * fallback the stage explicitly allows, applied per-part rather than repo-wide.
 *
 * MEASURED (not assumed): a dedicated ground-clearance probe (transforms each spec's own box/capsule
 * geometry through its live body pose every fixed step, no solver dependency -- a sensor's kinematics
 * while rigidly welded are identical to a solid shape's UNLESS/UNTIL real penetration would occur, so
 * this measures the would-be solid outcome using the pre-Stage-3 sensor codebase) run across 3
 * benign-driving scenarios (240-step full-throttle, straight-line 5s, launch+brake+swerve) found
 * exactly 3 of the 27 post-cull components genuinely cross below world Y=0 (the ground plane) during
 * ordinary driving, all rear-mounted underbody parts sagging under sustained rear-biased load: fuelTank
 * (worst -0.045m @5s straight-line), mufflerTailpipe (-0.034m), rearSubframe (-0.025m). Every other
 * component (including the other 14 underbody/extremity parts -- front subframe, both control-arm
 * pairs, driveshaft, both bumper beams -- and all 10 engine-bay parts) stayed comfortably positive
 * (>=0.017m clearance) across all 3 scenarios. This is a MUCH smaller-scope problem than the ORIGINAL
 * sensor-while-attached finding this stage retires (createShapeFor()'s doc comment: 39 parts including
 * several LOW interior components -- seats/bench/pedal-cluster, all culled since, see this file's top
 * doc comment -- stalled the whole driveline from 34km/h to <1km/h): only 3 parts, all shallow (<5cm)
 * penetration, and the interior parts that caused the severe stall no longer exist in this table at
 * all. Stage 1's cabin-tub floorpan/sills genuinely fixed the problem for the OTHER 24 parts; these 3
 * sit further aft/lower than the floorpan's own Z/Y coverage (mm() locations pre-date Stage 1 and were
 * never re-validated against it) and were not.
 *
 * DYNAMIC CONFIRMATION (not just the geometric probe above): re-ran a 5s full-throttle launch with
 * these 3 parts' sensor override ACTUALLY REMOVED (all 27 solid) and compared against the as-shipped
 * (3 overridden) run -- speed-at-5s dropped 90.8 -> 73.9 km/h (~19% down) and distance covered 63.9 ->
 * 56.3m (~12% down), a real, repeatable drivetrain drag from their ground contact, confirming the
 * geometric prediction with an actual dynamics measurement (not a catastrophic near-total stall like
 * the original 39-part interior bug, but a clearly measurable regression this stage's own "if
 * solid-while-attached genuinely regresses driving after honest effort (measure!), keep sensors for
 * the specific offending parts only" clause exists for). Confirms the override choice; not a
 * permanently closed question -- worth re-measuring if these 3 parts' mount points or the chassis's
 * own underbody/floor geometry change.
 */
export const ATTACHED_SENSOR_OVERRIDE_IDS: ReadonlySet<string> = new Set(['fuelTank', 'mufflerTailpipe', 'rearSubframe']);

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
