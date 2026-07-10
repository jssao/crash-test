# Worker brief: crush architecture M1-M3 (continuation)

Repo: /Users/jesuscalderon/Documents/crash test — Box3D(wasm) + Three.js crash sandbox in game/.
HEAD a3023a0, ALL suites green (root 25 files/47 tests; game 77 files/209; bench ~0.115ms).
Predecessor landed M0a (vendor wheel-force patch, vendor/PATCHES.md, rebuilt wasm) and M0b
(b3Shape_SetHull/SetMesh wired — see its root tests for usage). M1 starts fresh.

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
