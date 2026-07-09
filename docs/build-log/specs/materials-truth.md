# Materials Truth Audit — destructibles vs. the real world

Status: **living spec** (destruction round 2). Written in response to a user playtest that flagged
specific unrealities in the crash sandbox's destructibles. This is the reference table the user asked
for directly: every destructible item, its real-world dimensions/mass/failure mode, what the game
currently models, and the fix (or the reason a deviation is kept).

Scope of ownership for this pass: the `buildings` feature
(`game/src/world/features/buildings/**`) and the legacy destructibles' physics assembly
(`game/src/world/bodies.ts`, `world/visuals.ts`). The legacy destructibles' size/mass **constants**
live in `game/src/world/tuning.ts`, which is owned by a concurrent worker this wave — items sourced
from there are marked **[tuning.ts — flag]** and are proposed, not yet applied, from this file's
author.

Densities used (kiln-dried unless noted): common fired clay brick ~1900–2100 kg/m³; softwood
(pine/spruce, kiln-dried) ~450–550 kg/m³, pressure-treated/green ~700–900 kg/m³; gypsum wallboard
~650 kg/m³ (→ ~8–9 kg/m² at 12.7 mm); mild steel 7850 kg/m³ (drums are a thin shell, so drum mass is
computed from shell volume, not solid).

---

## 1. Brick (free-standing wall + legacy `wall-left`)

| Property | Real world | Was (game) | Now (game) |
|---|---|---|---|
| Dimensions | 194 × 92 × 57 mm (UK/metric modular; US 194×92×57 similar) | **400 × 200 × 200 mm** | 194 × 92 × 57 mm |
| Mass | 2.4–2.9 kg (dense/engineering ~2.7 kg) | 2.6 kg | 2.7 kg |
| Implied density | ~1900–2650 kg/m³ | **162 kg/m³ (!! styrofoam)** | ~2655 kg/m³ |
| Failure | mortar joints crack crisply; bricks shed singly or in clumps | one soft weld lattice → **whole wall wobbles as a jelly blob** | mortar welds **break-only** (rigid until they crack); clumps of still-welded bricks tumble as chunks |

The single largest deviation in the whole sandbox: the old "brick" was a 0.4 m block at 1/12th of
brick density — a giant foam cube. Fixed to real brick geometry **and** real density (mass follows
from `density = mass / boxVolume`, so inertia is now honest too).

**Wall size trade-off (documented, deliberate):** a real 6 m × 1.6 m wall of 194 mm bricks is
~850 bricks — far past this sandbox's physics/perf budget (the reset test caps total building pieces
at 260; `bench:full` gates < 8 ms). So the free-standing wall is modelled as a **low boundary wall**:
16 columns × 10 courses = 160 bricks, ≈ 3.1 m long × 0.57 m tall. Real per-brick truth is preserved;
only the wall's overall extent is scaled to fit the budget. (The legacy `wall-left` "brick" wall in
`world/tuning.ts` still uses the old oversized blocks — **[tuning.ts — flag]**, see §6.)

## 2. 2×4 stud & wall planks (shed + house-corner frames)

| Property | Real world | Was | Now |
|---|---|---|---|
| 2×4 nominal cross-section | 38 × 89 mm (1.5″ × 3.5″ actual) | 80 × 80 mm square | 58 × 58 mm square (**equal cross-sectional area** to a 38×89, 3382 mm²) |
| Stud mass (2.2 m shed stud) | ~4 kg kiln-dried (~11 kg if green/treated at the user's 1.6 kg/300 mm) | 3 kg | 3.5 kg (≈ 470 kg/m³ kiln-dried at the new 58 mm section) |
| Plank (bay board) | ~19 mm boards | 40 mm | 19 mm |
| Failure | snaps **mid-span** into two ragged halves under a hard hit | detaches whole from its end weld only | end-weld ductile lean/break (mid-span pre-split splinter = **residual**, see §7) |

Modelling the 2×4 as an equal-**area** square (58 mm) rather than a true 38×89 rectangle avoids a
rectangular-stud refactor of `buildWallRun`/`buildCornerSegment` (both assume a single square
half-cross that also drives plank offsets and weld anchors); the square keeps mass-per-length and
bending presence honest, and studs are mostly hidden behind planks/drywall so the section shape is not
visible. The user's "1.6 kg/300 mm" corresponds to wet/pressure-treated stock (≈ 1580 kg/m³-effective);
kiln-dried framing is ~1/3 of that. We use kiln-dried and note the treated figure here.

## 3. Drywall / gypsum wallboard (house-corner faces)

| Property | Real world | Was | Now |
|---|---|---|---|
| Thickness | 12.7 mm (½″) | **24 mm** (half-thickness 0.012) | 12.7 mm (half-thickness 0.00635) |
| Mass per sheet | ~26 kg (9 kg/m² × ~2.9 m²) | 7 kg | 12 kg (deliberately gameplay-light — see below) |
| Failure | brittle; punches through / fractures into a few chunks | one flying sheet per bay | still per-bay welds; multi-chunk pre-split = **residual**, see §7 |

Thickness is now the real 12.7 mm (was twice that). Mass is raised toward truth (7 → 12 kg) but kept
**below** the real ~26 kg on purpose — the same documented gameplay call as the legacy wall blocks:
"the car punches through easily" is the drive-through signature the design wants, and a true 26 kg
panel makes the car stall on the wall. The weld-break thresholds were nudged up with the heavier panel
so panels still detach cleanly on a real hit.

## 4. Pipe (galvanized, house-corner cavity)

| Property | Real world | Game | Note |
|---|---|---|---|
| ~1.1 m of ¾″–1″ galvanized pipe | Ø ~27–34 mm, ~1.3–2 kg/m | Ø 100 mm capsule, 4 kg, 1.1 m | kept chunky for visibility; **capsule → gets true `rollingResistance` 0.35** so it rings and rolls a little, then stops (spheres/capsules are the only shapes box3d rolling-resistance supports). |

## 5. Steel drum / 55-gal barrel (legacy bowling triangle) **[tuning.ts — flag]**

| Property | Real world | Was | Proposed |
|---|---|---|---|
| Dimensions | Ø 572 mm × 880 mm tall | Ø 600 mm × 900 mm (12-gon) | ~ok, keep |
| Mass (EMPTY) | ~18–20 kg (thin ~1.2 mm steel shell) | 25 kg | 20 kg |
| Failure | dents/crumples on impact; body stays a rough cylinder | rigid, no deformation | crumple **visual** dent (mesh-only; physics body stays rigid — honest note) = **residual**, see §7 |

Drum dimensions are already close to truth. Two gaps: (a) mass should be ~20 kg empty-shell not 25 kg
solid-ish — this constant is `BARREL_MASS_KG` in `world/tuning.ts` (**flag** for that file's owner);
(b) the mesh should dent on impact — a visuals-layer change (§7).

## 6. Legacy stacked-block walls / crates / poles **[tuning.ts — flag]**

- Wall blocks: 0.5 × 0.35 × 0.35 m at 8–30 kg → density ~490–1840 kg/m³, already documented in
  `world/tuning.ts` as a deliberate "lighter than solid so a whole wall stays scatterable" gameplay
  choice. Left as-is (it is a labelled gameplay call, not an accidental error like the brick was).
- Crate: 0.6 m cube, 15 kg → ~69 kg/m³. A real full crate is heavier; an empty shipping crate is
  light. Acceptable, flagged for the owner if truth is wanted.
- Pole: 0.15 × 2.5 m, 40 kg → ~890 kg/m³ (a heavy timber/utility pole). Reasonable.

These all live in `world/tuning.ts`; this pass only applies **settle damping** to their bodies (in
`world/bodies.ts`, which this pass owns) — see the damping table below.

## 7. Debris settle damping (playtest issue #1 — applied this pass)

box3d's per-shape `rollingResistance` is spheres/capsules-only (`types.h:407`), so box/hull debris is
settled with a body-level `angularDamping` at spawn instead. Linear damping stays tiny so debris still
flies on a hard hit; only the eternal *spin* is killed.

| Material | angularDamping | linearDamping | rollingResistance |
|---|---|---|---|
| Brick | 1.7 | 0.15 | — (box) |
| Wood (studs/planks/roof) | 1.3 | 0.08 | — |
| Drywall | 1.1 | 0.10 | — |
| Pipe (capsule) | 0.5 | 0.05 | **0.35** |
| Fence post/rail | 1.2 | 0.08 | — |
| Legacy wall block | 1.6 | 0.15 | — |
| Legacy crate | 1.3 | 0.08 | — |
| Legacy barrel (hull) | 0.7 | 0.08 | — |
| Legacy pole | 1.2 | 0.08 | — |

Validated by `tests/rolling-resistance.test.ts` (a rolling capsule and a spinning body both come to
rest) and `game/sim/materials-truth.test.mjs` (freed debris in a real structure settles).

## 8. Residuals (deferred, with the deliberate reason)

These are confirmed playtest items that this pass intentionally did **not** land, to keep the physics
retuning coherent and the suite green rather than shipping half-finished new subsystems:

- **Wood mid-span splinter** (issue #4): pre-splitting each stud into two half-bodies joined by a
  strong mid weld + kerf splinter geometry is a new geometry subsystem; deferred. Studs currently
  break at their end welds (ductile lean-then-snap).
- **Drywall multi-chunk fracture** (issue #4): pre-splitting panels into 2–4 chunk bodies with weak
  inter-chunk welds; deferred (panels break whole per bay).
- **Barrel crumple dent** (issue #5): a lightweight local mesh-dent for the barrel meshes in
  `world/visuals.ts` (physics body stays a rigid cylinder); deferred.
- **Barrel empty-shell mass 25 → 20 kg** (issue #2/#5): constant `BARREL_MASS_KG` lives in
  `world/tuning.ts` (owned by a concurrent worker) — flagged for that owner.
