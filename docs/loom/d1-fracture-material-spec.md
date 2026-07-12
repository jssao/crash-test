# D1 — Fracture Material Spec (design only, no implementation)

Builds on `docs/loom/p0d-destructibles-inventory.md` (engine capability + current break behavior).
This is a spec: concrete numbers + mechanics for a future fracture pass. No engine primitive exists
today that splits one body into fragments (inventory F3) — every number below assumes the
destroy-intact-body + spawn-N-fragment-bodies pattern the inventory recommends (mirrors the
tree/panel destroy-and-rebuild precedent already proven in production).

---

## A. Material table

MOR = modulus of rupture (flexural/bending strength at failure), MPa. Ratio normalizes to pine 2x4
= 1.0. Uncertain values are flagged; confident values cite a real reference class.

| Material (in-game member) | MOR (MPa) | Stiffness class | Failure mode | Ratio (pine 2x4=1.0) |
|---|---|---|---|---|
| Green softwood trunk (sapling) | ~35 **[uncertain — juvenile/high-MC wood, estimated 40-50% of seasoned clear-wood]** | low-moderate (green wood is markedly less stiff than dry) | ductile hinge-bend-then-snap (most ductile of the wood family — visibly whips before failing) | 0.875 |
| Seasoned mid trunk | ~55 **[uncertain — assumed mid-maturity standing tree w/ natural defects, between green (35) and clear seasoned (75-90)]** | moderate | ductile hinge-bend-then-snap (less whippy than sapling, still leans before felling — matches `MID_WELD_ANGULAR_HERTZ` compliance) | 1.375 |
| Large oak trunk (static, never breaks) | ~100 (confident — FPL Wood Handbook clear-wood MOR: red oak 99.2 MPa, white oak 104.4 MPa @ 12% MC) | high, stiff | brittle-ish snap (oak fails with less visible bend than pine) — moot, trunk is a static immovable body by design | 2.5 |
| Large oak branch (dynamic, welds off trunk) | ~70 **[uncertain — derated from clear-wood 100 for branch-collar knot defects]** | high | semi-brittle snap, short droop first (matches `LARGE_WELD_ANGULAR_HERTZ` compliance) | 1.75 |
| 2x4 pine rail (fence) | ~40 **[uncertain — representative graded-construction-lumber ultimate MOR; real range ~30-70 MPa by grade/species]** | moderate | ductile hinge-bend-then-snap | 1.0 (anchor material for ratio normalization) |
| 4x4 post (fence) | ~40 (same species/grade assumption as the 2x4) | moderate | ductile hinge-bend-then-snap | 1.0 |
| Plywood/OSB sheet (shed cladding) | ~25 **[uncertain — structural plywood ~30-40 MPa parallel-to-face; OSB lower ~20-25; picked a low-end blended estimate since game doesn't distinguish]** | low (thin sheet), anisotropic | splinter/delaminate (not a clean two-piece snap — cracks along grain/glue lines) | 0.625 |
| Drywall (gypsum board) | ~3 **[uncertain — gypsum wallboard MOR typically cited 2-5 MPa perpendicular to face]** | very low | brittle snap/crumble, near-zero yield | 0.075 |
| Clay brick (flexural, not compressive) | ~5 **[uncertain — brick MOR/transverse breaking strength is rarely spec'd and highly variable, ~3-10 MPa cited in masonry references; brick is normally rated by COMPRESSIVE strength (~20-40 MPa), not flexure]** | high in compression, very low in flexure | brittle; **in this game the unit itself never fractures** — only inter-brick mortar joints break (`BRICK_PROFILE.breakOnly=true`), so this row is informational only, no fracture work needed | 0.125 |
| Steel barrel / pole | n/a — ductile metal, not a brittle-MOR failure | very high (steel) | **non-fracturing**: dents/crushes plastically, never snaps in this game; no MOR-based threshold applies | n/a |

---

## B. Unit mapping (anchor → formula → numbers table)

### Anchor
**Mid tree trunk weld break**, `game/src/world/features/trees/tuning.ts:196-197`:
`MID_FORCE_THRESHOLD_N = 550_000`, `MID_TORQUE_THRESHOLD_NM = 140_000` — play-validated
(`game/sim/features-trees.test.mjs`). Member: seasoned mid trunk, solid circular cross-section,
radius `MID_TRUNK_RADIUS_M = 0.35` (`tuning.ts:175`). Section modulus (solid circle, `S = πr³/4`):
**S_anchor = π·0.35³/4 = 0.03367 m³**. Assigned MOR_anchor = 55 MPa (table above).

### Formula
```
ratio(member) = (MOR_member / MOR_anchor) × (S_member / S_anchor)
BreakForce_member  = MID_FORCE_THRESHOLD_N  × ratio(member)
BreakTorque_member = MID_TORQUE_THRESHOLD_NM × ratio(member)
```
Force is scaled by the SAME combined ratio as torque (not independently derived) — an approximation,
flagged: strict beam theory relates MOR/S only to bending MOMENT (torque), not force directly; this
codebase's existing calibrated pairs (sapling/mid/large-branch, buildings) already co-vary force and
torque roughly proportionally per material family, so applying one ratio to both preserves that
existing relationship rather than inventing a second, unvalidated force-scaling law.

**Section modulus per member** (solid circular `S=πr³/4`; solid/rect `S=b·h²/6` with h = the
dimension in the load/deflection direction, b = the perpendicular dimension — see per-row note for
which axis is "h"; sheet members use a per-bay-width slab approximation `S=b·t²/6`, t=thickness,
b=effective span width, since sheets fail by local punch-through, not whole-bay beam bending):

| Member | Geometry source (file:line) | Dimensions used | S (m³) |
|---|---|---|---|
| Sapling trunk (base) | `trees/tuning.ts:151` `SAPLING_TRUNK_RADIUS_M=0.07` | r=0.07 circular | 0.0002694 |
| Mid trunk (anchor) | `trees/tuning.ts:175` `MID_TRUNK_RADIUS_M=0.35` | r=0.35 circular | 0.03367 |
| Large branch (base) | `trees/tuning.ts:212` `LARGE_BRANCH_RADIUS_M=0.12` | r=0.12 circular | 0.0013572 |
| Large trunk (informational — static, never breaks) | `trees/tuning.ts:208` `LARGE_TRUNK_RADIUS_M=0.6` | r=0.6 circular | 0.16965 |
| Fence rail (single-end weld — see §C) | `buildings/tuning.ts:288-289` half-height 0.04/half-depth 0.03 → full 0.08×0.06 | h(depth,load-dir)=0.06, b(height)=0.08 | 4.80e-5 |
| Fence post (base) | `buildings/tuning.ts:287` `FENCE_POST_HALF_CROSS_M=0.05` → full 0.10 sq | b=h=0.10 | 1.667e-4 |
| Shed/corner stud (base) | `buildings/tuning.ts:224,239` `*_STUD_HALF_CROSS_M=0.029` → full 0.058 sq | b=h=0.058 | 3.251e-5 |
| Shed plank/cladding (per bay) | `buildings/tuning.ts:223,225` thickness full 0.019, bay ≈ `SHED_STUD_SPACING_M`(0.9) − 2×stud half-cross ≈ 0.84m | t=0.019, b(effective width)=0.84 | 5.05e-5 |
| Drywall sheet (per bay) | `buildings/tuning.ts:240-241` thickness full 0.0127, sheet width 1.2 | t=0.0127, b=1.2 | 3.23e-5 |

**Result — new MEMBER-FRACTURE thresholds** (distinct from, and layered on top of, the EXISTING
weld/joint-pop thresholds — see §C for why fracture and weld-pop are checked as parallel, not
sequential, conditions):

| Member | ratio to anchor | Fracture BreakForce (N) | Fracture BreakTorque (N·m) | Existing weld-pop threshold (N / N·m) | Which fails first |
|---|---|---|---|---|---|
| Sapling trunk | 0.00509 | 2,800 | 713 | 6,000 / 2,500 (`tuning.ts:164-165`, different joint type — spherical cone+spring, not weld) | validation only, see note |
| Mid trunk (= anchor) | 1.0 | 550,000 | 140,000 | — (is the anchor) | — |
| Large branch | 0.05129 | 28,211 | 7,181 | 30,000 / 12,000 (`tuning.ts:242-243`) | validation only, see note |
| Fence rail | 0.001037 | 571 | 145 | 700 / 350 (`buildings/tuning.ts:110-111`) | **fracture first** (571<700) |
| Fence post | 0.003601 | 1,981 | 504 | 700 / 350 | weld-pop first (1981>700) |
| Shed/corner stud | 0.000702 | 386 | 98 | 3,500 / 1,800 (`buildings/tuning.ts:67-68`) | **fracture first** (386≪3500) |
| Shed plank/cladding | 0.000682 | 375 | 95 | 3,500 / 1,800 (shares stud's constants today) | **fracture first**, by a wide margin |
| Drywall | 0.0000523 | 29 | 7.3 | 1,100 / 520 (`buildings/tuning.ts:78-79`) | **fracture first**, overwhelmingly |

**Validation note (sapling/large-branch rows above are NOT new thresholds — they're a sanity check
against already-calibrated numbers)**: the formula predicts the large-branch threshold within 6%
of its actual play-validated value (28.2kN predicted vs 30kN actual) — strong agreement, since both
anchor and branch are the same mechanism (cantilevered weld, base = max-moment point). The sapling
prediction undershoots the actual calibrated value by 2.1-3.5x, attributable to the sapling using a
compliant spherical cone+spring joint (not a rigid weld) — a genuinely different load path, so the
formula's beam-theory assumption applies less cleanly there. Net: the model is credible for
weld-anchored cantilevers, weaker (but same order of magnitude) for spring-jointed members.

**Reading the "which fails first" column**: thin/long members (rail, stud, plank, drywall) are
predicted to snap in bending well before their own weld connection pops loose — real carpentry
intuition (a thin board snaps before nails pull), and it matches the wood-family's existing ductile
"lean-then-break" yield profiles already in `buildings/tuning.ts`. Stout short members (fence post)
are predicted to pop their base weld first, matching the existing behavior unchanged. **Design
implication**: fracture-checking must run as an independent, parallel check alongside (not after)
today's yield→weld-break state machine, because for several members it now wins the race.

---

## C. Fracture mechanics per member

**Break-plane location** — depends on support condition, confirmed from the actual weld topology in
`buildings/structures.ts`:
- **Cantilevered from a fixed base** (mid/large trunk at root anchor; large branch at trunk; fence
  post at footing; shed/corner stud at footing): break plane at the **base** — max-bending-moment
  point for a cantilever, which is exactly where the existing joint-force poll already reads.
- **Fence rail**: confirmed from `structures.ts:538-548` — a rail welds to only ONE post (`post =
  postBodies[i]`, the near post), not both span ends. It is mechanically a single-end cantilever, not
  a simply-supported beam, so its max-moment point is ALSO at its one weld (not midspan) — the
  existing weld-force reading is a valid proxy here too, no new signal needed.
- **Sheet spanning between two supports hit broadside** (shed plank bay panel, drywall sheet):
  max-moment point is at the **impact location**, which generally is NOT the panel's one stud weld.
  This is a genuinely new signal requirement: the existing per-weld force poll is a poor proxy for
  mid-panel bending failure. Needs the contact/hit event's world-space position (available per the
  inventory's engine-capability notes — hit events carry contact info) rather than joint force alone.

**Fragments spawned**:
- Trunk (sapling/mid): 2 capsule fragments at the break height — a short base "stump" (~30% of
  trunk length) + the longer toppling piece (~70%), split point offset by a small deterministic
  jitter (not an exact round number) so the cut doesn't read as machine-clean. Stump may remain
  welded to the original anchor (reads as "car snapped it off at the base").
- Large branch: recommend **no new fracture behavior** — keep today's single-piece whole-branch
  detach (already dramatic at 1.6m length); a 2-fragment split adds body count for a component this
  short/cheap without a clear payoff.
- 2x4 fence rail / 4x4 post: 2 box fragments, split ~45/55 (not 50/50) with a small deterministic
  length-offset jitter, each keeping the parent's full cross-section.
- Shed/corner stud: 2 box fragments (short base stub anchored near the footing + longer flying
  piece) — per §B this is now the PRIMARY new visible behavior for studs, since fracture wins before
  weld-pop.
- Plywood/OSB cladding panel: 2-4 irregular quadrilateral shards (jagged, not a clean rectangle
  cut) — matches the "splinter/delaminate" failure mode.
- Drywall: 2-3 large flat quad fragments — kept coarse (drywall's real crumble/dust behavior is out
  of scope; a few big chunks reads fine and stays cheap).
- Brick: **no change** — stays whole, as today (`BRICK_PROFILE.breakOnly=true`).
- Steel barrel/pole: **no change** — no fracture; if visual denting is ever wanted it is a separate,
  smaller feature (cosmetic hull tweak akin to the car panel's `Shape.setHull()` dent-following),
  out of scope here.

**Fragment velocity seeding** (NO `Math.random`, per the codebase's hash-based-determinism
convention already used by `trees/tuning.ts`'s `mulberry32`/`scatterRng` and
`world/tuning.ts`'s `BARREL_EXPLOSION_SEED`-driven fuse jitter):
1. Each fragment **inherits** the parent member's linear + angular velocity at the break instant
   (same principle as `clampDebrisVelocity()`'s impulse-proportional release, `structures.ts:161-174`).
2. Add a small **deterministic** separation kick: hash a stable key — e.g. `(memberEntityId,
   breakEventOrdinal, fragmentIndex)` — through the same mulberry32 algorithm already duplicated
   across the codebase (one more small local copy is the established convention, not a shared
   import) to get a repeatable pseudo-random unit vector along the local break-plane normal.
   Magnitude ~0.3-0.8 m/s, split oppositely between the two fragments, scaled by how far the
   triggering force exceeded the break threshold (clamped) — same philosophy as the existing
   `breakSpeedCapMs`/`breakSpinCapRad` caps.
3. Small opposite angular-velocity nudge per fragment (deterministic sign by fragment index) so the
   two halves visibly tumble differently.
4. Same crash replayed twice (same scenario/seed) must produce bit-identical (or tolerance-close)
   fragment kinematics — this is the determinism contract, and should be a headless test (§F).

**Per-material yield stage** (extends, doesn't replace, the existing `YieldProfile` state machine in
`buildings/tuning.ts:134-213`):
- Green sapling / seasoned mid trunk / pine 2x4/4x4 (rail, post, stud): **yes**, hinge-bend first —
  ductile, matches existing compliant welds (`MID_WELD_ANGULAR_HERTZ`, `WOOD_STUD_PROFILE`).
- Large oak branch: short droop first (already modeled via `LARGE_WELD_ANGULAR_HERTZ=40`), less
  pronounced than pine.
- Plywood/OSB: minimal yield — recommend a new, more-brittle sheet profile (lower `yieldForceFrac`
  ~0.3, `ductileBreakMult` ~1.1) distinct from the stud profile it currently borrows.
- Drywall: none/negligible in absolute terms — its threshold is so low relative to any real hit that
  the yield window is not perceptible.
- Brick: none (`breakOnly`, unchanged).

---

## D. Budget discipline

- Baseline world body count is measured at ≈520-524 (inventory F4), with ~14x perf headroom
  (0.58ms avg vs the 8ms `perf-bench.mjs:12` gate) — real room, but that measurement was taken AT
  ~520 bodies, not higher; fracture must not be assumed free just because of the current margin.
- **Global fragment cap**: recommend capping simultaneously-live fracture fragments at roughly
  40-60 extra bodies beyond baseline (a handful of concurrent member-snaps in one crash), and
  re-running `perf-bench.mjs`/`perf-bench-full.mjs` at that inflated count before accepting it —
  don't assume the existing 14x margin survives untested.
- **Rate limit**: at most 1 new fracture event (destroy-intact-body + create-N-fragment-bodies) per
  fixed step, mirroring `damage/system.ts`'s `refreshPanelHulls()` explicit "≤1 panel/step" rule
  (`damage-tuning.ts:421-429`) and its own stated rationale — proven cheap per-crash-event, not
  proven safe per-frame. Queue extra same-step triggers for the next step(s).
- **Buildings CI band `[200,260]`** (`feature-buildings.mjs:331-332`, `materials-truth.mjs:219`,
  `totalPieceCount()`): keep fracture fragments in a **separate array/counter**, not folded into
  `structure.pieces` — this keeps `totalPieceCount()`'s contract exactly as today (spawn-time piece
  count) regardless of runtime fracture events, avoiding any need to touch that CI assertion.
- **Despawn**: reuse the car-panel despawn pattern verbatim — `PANEL_DESPAWN_AFTER_S=25` /
  `PANEL_DESPAWN_DISTANCE_M=100` (`damage-tuning.ts:330-333`) — for fracture fragments too, so a long
  soak session (the existing 10-minute soak test) doesn't leak bodies.
- **No re-fracturing**: only the FIRST fracture of a given member fragments finely (2-4 pieces); a
  fragment that's already the product of one break should not itself re-split on a later hit — it
  behaves like today's whole-piece debris from then on. Bounds worst-case fragment count and avoids
  runaway cascades (this matches the inventory's own F4 suggestion).

---

## E. Debris-mass bug fix

**One-liner**: `setForeignMass(system, entityId, massKg)` — `game/src/damage/system.ts:121-124`.
Call once per spawned dynamic body (tag the body/shape `userData` with a matching `entityId` first,
same pattern `world/bodies.ts:254` already uses for barrels via `BARREL_ENTITY_ID_BASE=44_000_000`,
`world/tuning.ts:104-110`). Propose a new disjoint id range for fracture fragments, e.g.
`FRACTURE_FRAGMENT_ENTITY_ID_BASE = 45_000_000` (clear of chassis=1, wheels=2-5, panels=6-10,
occupants=1000-1399, cardetail=88,100,000+, barrels=44,000,000+).

**Spawn sites currently missing it** (confirmed: grep for `setForeignMass(` finds it called ONLY from
test-lab code — `src/lab/barriers.ts`'s doc comment explicitly opts OUT, `damage/scenario.ts`'s
`spawnFenceLine()` tags entity ids but the actual registration call is left to its caller — no real
world feature calls it):
1. `trees/bodies.ts` — `buildSapling()`/`buildMid()`/`buildBranchBody()` (masses 9/320/15 kg) and
   their reset-rebuild paths (`resetSapling`/`resetMid`/`resetLarge` create fresh bodies needing
   re-registration).
2. `buildings/structures.ts` — `addBoxPiece()`/`addCapsulePiece()` (studs 3.5kg, planks 5kg, roof
   3kg, drywall 12kg, bricks 2.7kg, pipes 4kg, posts 2.5kg, rails 1.5kg). Needs both a NEW
   entity-id field added to the `Piece` interface (none exists today) AND the registration call.
3. `world/bodies.ts` (legacy destructibles) — wall blocks (8-30kg), crates (15kg), poles (40kg) are
   untagged and unregistered; barrels (25kg) ARE already tagged (`BARREL_ENTITY_ID_BASE+i`) but the
   registration call itself is still missing — just needs `setForeignMass()` added using that
   existing id.
4. Every NEW fracture-fragment spawn point this spec introduces — each fragment is a fresh body with
   its OWN (smaller, post-split) mass; it must register itself, not inherit the parent's registration.

**Concrete bug today**: `welds.ts:116-119`'s mass-aware damage factor `e = m_other/(m_other+m_car)`
silently defaults to "unregistered ⇒ wall-like ⇒ factor 1" — so a 9kg sapling or a 2.5kg fence rail
hitting the ~1438kg car currently deals full wall-equivalent damage instead of its true ≈0.6-1.7%
fraction.

---

## F. Verification plan

**Existing tests that must stay green** (regression gate):
`game/sim/features-trees.test.mjs`, `game/sim/features-trees-bend.test.mjs`,
`game/sim/features-buildings.test.mjs` (incl. its `totalPieceCount()` [200,260] check),
`game/sim/buildings-reset-integrity.test.mjs`, `game/sim/destruction-feel.test.mjs`,
`game/sim/materials-truth.test.mjs`, `game/sim/perf-bench.mjs` / `perf-bench-full.mjs` (avg<8ms/step),
`game/verify/perf-headed.mjs` (≥55fps), and the existing long-session soak battery
(`game/verify/playtest-final/soak.mjs`).

**New headless assertions (8)**:
1. A fence rail hit at ~40 km/h (well past the derived 571N/145N·m fracture line) splits into exactly
   2 box fragments; the same rail at ~8 km/h does neither (no fracture, no weld-pop).
2. A shed stud fractures (386N/98N·m) into 2 fragments strictly BEFORE its weld ever reaches the
   existing 3500N/1800N·m weld-pop threshold, for an escalating-force test sweep.
3. Mid trunk below its 550kN/140kN·m fell threshold leans/topples but never snaps mid-span (confirm
   trunk fracture is explicitly out of scope, or gated at a distinctly higher secondary threshold if
   later added) — regression guard on today's already-validated feel.
4. Plywood/OSB cladding fractures into 2-4 shards at its derived ~375N/95N·m threshold, well before
   its shared stud-style weld threshold (3500N/1800N·m) would pop — asserts shard fragmentation
   dominates for cladding.
5. Drywall fractures on essentially any real car-speed contact (>~29N/7.3N·m) — never survives an
   impact intact.
6. Brick wall: no brick ever spawns fragments post-fracture-feature (regression guard that
   `breakOnly` masonry stays wired out of the new path).
7. Body-count/perf budget: a "max chaos" scenario with several simultaneous member fractures keeps
   live body count under baseline+cap (~520+60) and step time under the 8ms perf gate.
8. Determinism + debris-mass regression combined: replay one fracture-triggering crash twice with the
   same seed and assert fragment kinematics match run-to-run (no `Math.random` leakage); separately,
   assert a light (1-2kg) fragment hitting the car produces small, mass-weighted car damage, not
   wall-equivalent damage (directly exercises the §E fix).
