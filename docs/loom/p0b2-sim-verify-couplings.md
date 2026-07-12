# P0-B2 — Mustang couplings in sim/ + verify/ (contributed by a parallel session's audit)

Source: fork-session audit received 2026-07-11. Complements p0b-mustang-coupling.md (game/src slice).
Scope: every sim/*.test.mjs (top-level + sim/diag/) grepped for Mustang literals (wheelbase 2743,
track 1619/1620, dims 4591/1936/1309, wheel radius 310mm, half-width 0.968, 2.35m nose, panel names,
CHASSIS_MASS_KG); files with hits opened. One-off sim/diag probes + some verify scripts grep-only.

## TIGHT — will break or silently mismeasure on the S90 (fix during P2/P3)
- sim/ride-height.test.mjs:44-45 — FRONT_FENDER_LOCAL_Y_M=0.8024, FRONT_TIRE_VISUAL_RADIUS_M=0.384;
  hand-measured against the Mustang fender-arch GLB (via verify/ride-height.mjs). Re-measure on S90.
- verify/playtest/battery.mjs:200 — restY=0.39 duplicated literal (~CHASSIS_ORIGIN_HEIGHT_M).
- verify/panel-pose/attached-pose.mjs:8 — hand-duplicated CHASSIS_ORIGIN_HEIGHT_M=0.39; desyncs.
- sim/structural-crush-visual.test.mjs:50 — `bz > 2.35` nose-row cutoff (Mustang shell length).
- sim/hull-cabin-tub.test.mjs:50 — cabin hull shape count toBe(10).
- sim/segment-structure.test.mjs:32-41 — segment count 9 pinned (x4 assertions).
- sim/segment-mass-parity.test.mjs:60,105 — segment mass sums 95 / 135 kg absolute.
- sim/cardetail-containment.test.mjs (~150) + sim/features-cardetail.test.mjs:90,95,180,211 —
  CAR_DETAIL_SPECS/bodyCount pinned to 27 (10 engine-bay / 0 interior / 17 underbody — Mustang cull).
  HIGH RISK: 4-door S90 cabin changes this; also S90 has NO modeled engine (see P0-A) so the
  engine-bay cardetail cluster likely changes shape entirely.
- sim/cardetail-ground-contact.test.mjs:134,138 — ATTACHED_SENSOR_OVERRIDE_IDS.size pinned to 3.
- sim/ride-height.test.mjs:34-38 — LADEN_FEATURE_BALLAST seat/cluster mm offsets, literal; review
  against S90 cabin (wider/longer; rear seat positions differ).

## LOOSE — CAR_MAP/tuning-derived at runtime; expected to survive
- containment/cardetail ENVELOPE/NOSE_AABB/CABIN_X (CAR_MAP-derived); diag instruments importing
  WHEEL_RADIUS_*/CHASSIS_MASS_KG; suspension/terrain synthetic geometry; verify/shoot*.mjs (no car
  literals); compound-world setFixedAngle(2.35) is a CAMERA radian value, not the nose dimension.

## Gaps (not fully verified by the contributing session)
- sim/diag one-off .mjs probes (non-vitest) not read line-by-line.
- verify/crash-realism/shoot-matrix.mjs, verify/panel-pose/shoot.mjs, verify/playtest-r3/diag-*.mjs
  grep-only (no wheelbase/track/dims hits, but unread).
→ P3 must re-grep these after the swap using the S90's OWN new numbers (old-literal grep can't catch
  couplings expressed as derived values).
