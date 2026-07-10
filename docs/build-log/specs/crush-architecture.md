# Crush architecture — real deformation on rigid bodies (Fable design, 2026-07-10)

User-approved direction: A (crush segments) + B (collision follows dents) in-game, C (upstream
track) parallel, the Crash Lab as the scoreboard against docs/build-log/specs/
crash-deformation-reference.md.

## A. Crush-segment front (and rear) structure

Replace the chassis's monolithic NOSE crush volume (one of the 12 cabin-tub shapes) with a chain of
REAL bodies joined by yield welds whose rest transforms shift under load — permanent shortening
that collision genuinely follows:

  bumperBeam ⇄ crushRailL/R (the crumple zone) ⇄ engineCradle ⇄ chassis(firewall face)

- 4-5 bodies front, 2-3 rear (trunk floor + rear rails). Masses real-ish (beam ~15kg, rails ~20kg
  ea, cradle ~40kg) DEDUCTED from the chassis via the existing setMassData parity capture so total
  mass/COM stay stable.
- YIELD MECHANIC (the core novelty): each weld carries plastic state. Per fixed step, if
  |constraintForce| > yieldThreshold: shift the weld's REST transform toward the loaded pose by
  plasticRate·overload (axial shortening, small pitch allowed), clamp at maxCrush per joint
  (~0.18m rail, ~0.10m beam). Result: overload → segment chain compresses and STAYS compressed;
  below yield → rigid. Above breakThreshold → weld destroyed (segment tears off — high speed only).
  Implementation: box3d welds define rest pose from frames at creation → shifting rest = destroy +
  recreate weld at new frames (cheap, rate-limit to ≤1 recreate/joint/step; despawn-safety rules
  apply — forgetHandle pattern where chassis-attached).
- STAGED RESISTANCE: thresholds tiered so beam yields first, rails progressively (front cell
  before rear cell — split each rail into 2 welds), cradle last. This reproduces the reference
  spec's crush-vs-speed curve MECHANICALLY (40 ≈ beam+front cells ~0.2-0.35m; 64 ≈ +rear cells
  ~0.45m; 80+ ≈ cradle motion toward firewall ~0.55m) instead of via tuned cosmetic constants.
- INTRUSION METRIC (interior consequence + lab scoreboard): firewall-face displacement toward the
  seats = real NHTSA-style intrusion. Lab reads it directly (chassis-local engineCradle/firewall
  delta). Occupant injury model gains an intrusion term (leg injury when > ~0.15m — matches
  FMVSS-208 spirit; document approximation).
- INTERACTIONS to manage: cardetail engine parts weld to the CRADLE now (they ride the crush,
  arriving at the firewall in big hits — drama for free); hood weld frames unchanged (chassis);
  crash-realism matrix RE-BASED: cosmetic crumple coefficients shrink because real geometry now
  carries most crush (cosmetic layer only skins the segments); the impulse-damage e-factor and
  hit routing must treat segment bodies as car entities (extend CAR_ENTITY_IDS).

## B. Collision follows the dents (panels + shell skin)

Revive RUN-1's rate-limited hull rebuild for what segments don't cover (doors/roof/quarter skin):
when a panel's accumulated crumple exceeds a threshold delta since last rebuild (~0.06m max-vertex
change), rebuild that panel body's collision box/hull from the deformed mesh AABB (existing
axis-remap machinery in panels.ts), rate-limited (≥30 steps apart, ≤1 panel/step). Chassis shell
skin stays cosmetic (segments own structural truth). If upstream someday ships runtime hull vertex
update (see C track), swap destroy/recreate for the API.

## Rollout (post Stage-2/lab landing; opus xhigh per ladder, escalate on failure)

1. Segment bodies + rigid welds, mass parity, all suites byte-stable (no yield yet) — pure
   structure swap gate.
2. Yield mechanic + staged thresholds; crash lab matrix RE-CALIBRATED against reference bands with
   crush now mechanical; cosmetic crumple re-based on top.
3. Panel collision-rebuild (B) + intrusion metric in lab + cardetail-on-cradle.
Each stage: full suite + lab protocol runs + eyes-on TOP/SIDE/3Q vs reference descriptions.

Risks: weld recreate churn perf (rate-limited; bench-gated), chaos sensitivity of drive tests to
front-mass distribution (mass parity + spot-number checks), depenetration pops when rails shorten
into cradle space (order shapes with clearance; yield rate small per step).
