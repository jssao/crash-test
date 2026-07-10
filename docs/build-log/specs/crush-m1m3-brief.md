# Worker brief: crush architecture M1-M3 (continuation)

Repo: /Users/jesuscalderon/Documents/crash test — Box3D(wasm) + Three.js crash sandbox in game/.
HEAD a3023a0, ALL suites green (root 25 files/47 tests; game 77 files/209; bench ~0.115ms).
Predecessors landed M0a (vendor wheel-force patch, vendor/PATCHES.md, rebuilt wasm), M0b
(b3Shape_SetHull/SetMesh wired — see its root tests), AND commit 635663b: the M1 mass-parity
mechanism is DONE — geometry.ts deductSegmentsFromParity() (+ helpers) computes the chassis
MassData to stamp so chassis-remainder + welded segments reproduce mass/COM/full-inertia exactly
(proven by sim/segment-mass-parity.test.mjs). ALSO MEASURED (risk retired): 4 symmetric welded
satellites (95kg, mass-deducted) perturb the drive suite ≤0.14% — no yaw runaway, no beaching.
HEAD is 635663b; suites root 25/47, game 78/213, bench 0.150ms. M1 remaining (predecessor's own
list): replace nose/tail cabin shapes with real colliding occupant-transparent segment BODIES
(CAR_GROUP + occupant NOSE_TAIL-equivalent filters), extend CAR_ENTITY_IDS/hitTouchesCar so
wall→bumper hits still route cosmetic crush to the chassis-front mesh, re-anchor cardetail engine
parts to the cradle, destroyVehicle cleanup, then recalibrate drifting crash tests (likely
damage-hard-frontal / structural-collapse / cardetail-containment — the wall now meets a
bumper+rail chain instead of a solid nose).

State you build on: chassis = 12-shape concave cabin tub + 2 destroyable glass panes
(game/src/vehicle/geometry.ts buildCabinShapes, vehicle.ts). Occupants collide with the interior
(Stage 2, commit 6d300ab; category registry in game/src/vehicle/tuning.ts — occupant NOSE_TAIL
exclusion). Crash Lab scoreboard: game/crash-lab.html + game/src/lab/** (7 protocols, crush
instrumentation, verify/crash-lab.mjs) with reference bands in
docs/build-log/specs/crash-deformation-reference.md.
DESIGN CONTRACT: docs/build-log/specs/crush-architecture.md — read first.
Browser: CDP/Brave headless (game/verify/shoot.mjs pattern). Sole worker; you own
game/src/vehicle/**, game/src/damage/**, game/src/world/features/cardetail/** (weld re-anchoring
only), game/src/lab/** calibration constants only, and their tests/verifies. Rebuild dist
(npx vite build in game/) at the end.

MILESTONES (commit each separately, ALL suites green at each; commit messages end with:
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>)

M1 — SEGMENT STRUCTURE (spec §A step 1): split the NOSE cabin shape into segment BODIES —
bumperBeam ⇄ crushRailL/R (each rail = 2 weld cells) ⇄ engineCradle ⇄ chassis firewall face; rear:
trunk floor + 2 rear rail bodies. Masses per spec, deducted via the existing setMassData parity
capture (total mass/COM stable). RIGID welds only. Segments join the CAR entity/filter families.
Gate: full suite green with crash/drive numbers within noise (spot-check printed values), bench
green, cardetail engine parts re-anchored to the CRADLE.

M2 — YIELD MECHANIC (spec §A step 2): plastic rest-transform shift on overload (destroy+recreate
weld at shifted frames, rate-limited ≤1 recreate/joint/step, despawn-safe/forgetHandle rules —
see the chassis-attached-joint hazard docs in occupants/physics.ts + cardetail). Staged thresholds
(beam → front cells → rear cells → cradle), maxCrush clamps. Re-base cosmetic crumple coefficients
down (real geometry now carries structural crush). Calibrate against the Crash Lab: NHTSA 56
full-frontal + IIHS 64 moderate-overlap crush depths in the reference bands, crush MECHANICAL
(segment displacement asserted in a new sim test), monotonic 40/64/80/120. crash-realism.test.mjs
re-based with justification. Intrusion metric: firewall/cradle displacement in telemetry + wired
to the lab readout.

M3 — COLLISION FOLLOWS DENTS (spec §B): panel collision refresh via setHull (M0b) when accumulated
crumple exceeds 0.06m max-vertex delta, rate-limited (≥30 steps apart, ≤1 panel/step); new sim
test asserting the deformed panel's hull mutated and contacts respect it.

GATES per milestone: full suites + bench + lab NHTSA-frontal run (verify/crash-lab.mjs) + EYES-ON
(open the pngs yourself): 64km/h offset TOP view (struck-side rail mechanically shortened vs
intact side); intrusion readout; a post-crash dent interaction.
HONESTY: never a broken tree; land the maximal green prefix; measurements behind every claim.
RETURN: plain text ~1k tokens — per-milestone status/numbers/commits/screens reviewed/residuals.
No JSON.
