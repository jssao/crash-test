# Stream C / slice C1 — door SPRUNG state

## Design locked (after empirical check)
- New RevoluteJoint (src/ts/joint.ts) hinges the door at its LEADING edge (local +Z edge, both front
  and rear doors — car-map.ts convention: +Z = nose), axis remapped Z->Y (car-local vertical) via
  DOOR_HINGE_AXIS_ROTATION = quatFromAxisAngle({x:1,y:0,z:0}, -PI/2), same technique as
  occupants/physics.ts's buildHingeFrames (frameA on chassis = DOOR_HINGE_AXIS_ROTATION directly since
  chassis's "own offset" is identity; frameB on door = conjugate(nodeWorldQuat)*DOOR_HINGE_AXIS_ROTATION,
  reduces to the same quat since every door's nodeWorldQuat is IDENTITY).
- Swing limit enableLimit [0,75deg] via RevoluteJointOptions — a REAL joint-limit field exists (no
  SphericalJoint fallback needed). Sign: doorL/doorRL (+X, left) open through NEGATIVE angles
  (lowerAngle=-75deg,upper=0); doorR/doorRR (-X, right) open through POSITIVE angles (lower=0,
  upper=+75deg) — derived from rotateVector's convention, TO BE CONFIRMED against eyes-on screenshots.
- Filter: sprung door KEEPS CAR_GROUP_INDEX (same as attached) — no shape rebuild at all. World
  collision unaffected (groupIndex only vetoes same-group pairs); avoids self-colliding with
  chassis/fender (the joint LIMIT is what stops fender clipping, not collision response).
- Escalation is an OR of TWO independent triggers (measured empirically why one alone can't satisfy
  every required test — see damage-tuning.ts's new doc comments):
  1. STRESS path (unchanged mechanism): old S2*mult(=90) becomes the SPRUNG threshold for doors, 1.5x
     that (135) becomes BREAK. Fires for genuine heavy lateral hits (side-130 measures 261-596, way past
     135 -> still straight to 'broken', preserving that test byte-for-byte).
  2. SPEED path (NEW, doors only): peak forward speed (segments.ts yieldState.peakForwardSpeedMs, same
     rig-independent signal WHEEL_DETACH_EXTREME_GATE_MS already uses) > 40 m/s -> sprung-eligible, >
     60 m/s -> break-eligible (needs panel.stress > 1, i.e. "this door was actually near something").
     NEEDED because measured door stress in the plain sim harness at 161/193/322 km/h frontal is only
     ~9-42 (never near 90) — the task brief's premise ("doors currently break via S2 at 161-193") holds
     in the LAB rig (occupants + longer dwell -> 3x+ higher stress) but NOT the bare sim harness that
     extreme-tier.test.mjs actually runs against. Speed alone is rig-independent (same nominal km/h ==
     same peak m/s regardless of stress-model noise), sidestepping the divergence entirely — same fix
     shape as HOOD_BREAK_MIN_FRONT_CRUSH_M's crush gate.
  Side-130 is a pure LATERAL launch (peakForwardSpeedMs ~ 0) so it can ONLY go through the stress path —
  confirms the OR is necessary, not redundant.

## Verified via diagnostic run (temp test, since deleted) BEFORE implementing
- side-130: doors break via STRESS only (stress 261-596 >> 90), zero force-spike involvement.
- frontal 40/55/64/80/100/120 km/h: door stress never exceeds ~9.2 (100kmh peak), 120kmh actually LOWER
  (~8.2) than 100kmh — confirms speed (not stress) is the only clean discriminator for the 161+ tier.
- frontal 161/193/322 km/h: front-door stress maxes ~19/19/42.5 respectively — all doors comfortably
  clear a "touched" epsilon but never approach 90.

## DONE — all items landed, verified
- [x] damage-tuning.ts: DOOR_SPRUNG_GATE_MS=40, DOOR_BREAK_GATE_MS=60, DOOR_STRESS_TOUCH_MIN=1,
      DOOR_SPRUNG_TO_BREAK_STRESS_MULT=1.5, DOOR_SWING_MAX_RAD (75deg)
- [x] panels.ts: PanelState union +'sprung', PanelHandle.hingeJoint, sprungPanelWeld(), breakPanelWeld
      destroys hingeJoint too, DOOR_PANEL_KEY_SET export, DOOR_HINGE_AXIS_ROTATION/DOOR_OPEN_SIGN
- [x] welds.ts: escalatePanel gains world/chassis/shouldSprung, door OR-logic (stress path unchanged +
      new speed-gated path), WeldStepArgs.world, peakSpeedMs computed once (shared with wheel-detach)
- [x] events.ts: PanelSprungEvent added to DamageEvent union
- [x] system.ts: DamageTelemetry.panelStates union widened, world threaded into stepWeldsAndWheels
- [x] vehicle.ts: destroyVehicle() destroys panel.hingeJoint before the body (liveHandleCount confirmed
      stable across repeated crash+reset cycles — no leak)
- [x] main.ts + lab/main.ts: handleDamageEvent reparents visual on 'panelSprung' too
- [x] hud/hud.ts + lab/hud.ts: STATE_COLOR.sprung = '#ff9933' (orange, between yellow loosened / red broken)
- [x] lab/main.ts: added peakForwardSpeedMs() diagnostic hook to __LAB__ (mirrors chassisSpeedMs())
- [x] tests: extreme-tier.test.mjs extended (+4 tests: 161 sprung, 322 all-broken, <=80 attached,
      determinism) — 252/252 full suite green (was 248)
- [x] crash-lab.mjs: 21/21 PASS (re-verified against a FRESH build — first pass was accidentally against
      stale dist/, caught and corrected)
- [x] eyes-on: verify/door-sprung/shoot-door-sprung.mjs (161km/h free-config, barrier hidden, side+3q) —
      doors read as convincingly swung open on hinges, both sides, no fender clipping observed at any
      zoom level checked (top-down close-up was most legible)
- [x] repair/reset path verified live (both lab reset() and repeated crash+reset cycles): sprung doors
      -> attached after reset, liveHandleCount stable (no hingeJoint leak)

## Numeric summary (final)
- Hinge: RevoluteJoint, anchor = door's local +Z edge (leading edge, both front/rear doors), axis
  remapped Z->Y via quatFromAxisAngle({1,0,0}, -PI/2). Left doors (doorL/doorRL) lowerAngle=-75deg,
  upper=0; right doors (doorR/doorRR) lower=0, upper=+75deg. Filter unchanged (CAR_GROUP_INDEX) — no
  shape rebuild.
- Escalation (doors only) = OR of: (a) stress path — old S2 threshold (90) now means SPRUNG, 1.5x (135)
  means BREAK [handles side-130: stress 261-596, way past 135, straight to broken as before]; (b) speed
  path — peakForwardSpeedMs>40 m/s -> sprung-eligible, >60 -> break-eligible, both requiring
  panel.stress>1 [handles the extreme-tier frontal tests, where door stress never approaches 90 even at
  322km/h in the bare sim harness].

# Stream C / slice C3 -- LATERAL structural field + underside coherence

## Design implemented (src/scene/structuralCrush.ts)
- Gap: field only handled FRONT/REAR (segments.ts telemetry has no lateral channel). Side/small-overlap
  crashes read pristine in top view -- same class of bug as the original frontal finding.
- Driver: lateralInputsFromRegistry(meshes) -- pure fn, reads CHASSIS-kind mesh's crumple registry
  offsets (damage/crumple.ts's accumulated per-vertex `offsets`, already physics-truth). Per side
  (pos=+x, neg=-x): band = |bx| > 0.55*1.01m (FLANK_HALF_WIDTH_M, dup of lab/protocols.ts's
  CAR_HALF_WIDTH_M, not imported -- layering). Depth = mean of top 15% in-band touched vertices by
  inward-|x| (LATERAL_DEPTH_PERCENTILE=0.85, avoids single-spike or diluted-mean). centerZ = mag-
  weighted mean z; spanM = mag-weighted std z, floored 0.12m.
- StructuralCrushInputs.sidePos?/sideNeg? OPTIONAL (undefined -> ZERO_SIDE_STATS) -- every pre-existing
  call site/fixture keeps compiling+behaving byte-identically.
- buildChassisField: sidePosOn/sideNegOn gate independent of frontOn/rearOn/cabinT (pure side hit with
  zero mech front/rear crush still activates the field -- early-exit condition fixed to include these).
  Per-vertex lateral ADD-ON (not a 4th exclusive branch): dx toward centerline, slight roof-edge -y
  droop (LATERAL_ROOF_Y_FRAC=0.75, tighter than cabin's 0.55 -- just the rail over the strike), smooth
  Falloff(|bz-centerZ|/(spanM*1.6)), reuses the SAME coherentCreaseNoise jitter block.
- Door cave: buildDoorCaveField -- DOOR_FLANK_SIGN hardcoded map (doorL/doorRL=+1, doorR/doorRR=-1,
  mirrors panels.ts's own DOOR_OPEN_SIGN convention; panel worldQuat is identity for every panel on this
  car so no rotation needed). Depth = 0.85x chassis depth, capped 0.3m; bell-curve over the door's OWN
  local z-extent (f.zMin/zMax, generically cached for every handle already) -- no panels.ts import
  needed.
- UNDERSIDE COHERENCE: every chassis vertex's TOTAL x-displacement clamped to 0.85*|own base x| after
  frontal+lateral combine -- 0 exactly at centerline, scales outward; inert for pre-existing frontal
  bulge (never remotely approaches this fraction). New test proves finalX never crosses centerline sign.
- Small-overlap corner accent: WHEEL_ARCH_* constants, tightly gated on frontAsymmetric (deeperFront vs
  shallowerFront, >30% gap) + narrow t-band (0.1-0.4 of frontSpan) -- inert for symmetric full-frontal
  (nhtsa-56) and for the one pre-existing asymmetric unit-test fixture (samples nose row only, t~0.93,
  outside band). Pushes wheel-arch sheet metal in/back on the struck side only -- cannot move the actual
  wheel RIG body (not a carDeformables member).
- Call sites updated: src/main.ts + src/lab/main.ts now merge
  `{...structuralInputsFromTelemetry(seg), ...lateralInputsFromRegistry(damageSystem.registry.meshes)}`.

## Tests: game/sim/side-fidelity.test.mjs -- 9 new tests, all pass first run
  - struck flank nonzero depth near strike center; intact flank EXACTLY zero
  - narrow (pole-style) hit reads smaller spanM than broad (MDB-style) multi-point hit
  - buildChassisField+door cave: struck side caves inward, intact side identically 0 (chassis AND door)
  - underside coherence: combined lateral+asymmetric-frontal never crosses centerline sign, any vertex
  - deterministic (byte-identical across independent same-input builds)
  - hysteresis (sub-epsilon depthM drift: no rebuild, version stable)
  - pure side hit (zero frontal) still activates the field
  - front-field byte-identical whether sidePos/sideNeg omitted or explicit zero
  - HARNESS: real side-50 crash (crash-realism-harness.mjs's crashSideways+spawnSideWall, extra
    'chassis-flank' proxy registered since the default harness only proxies the front bumper) ->
    measured sidePos.depthM=0.381 (sane band), sideNeg.depthM=0 exactly.
- Full suite: 261/261 (252 pre-existing + 9 new), all green, first run. tsc --noEmit clean.

## NEXT: verify/crash-lab.mjs (21/21 regression), eyes-on battery (side-mdb-50, side-pole-32,
  iihs-small-64, nhtsa-56 regression, 161km/h free-config), measure iihs-small-64 wheel/door outcomes
  BEFORE any further tweak (PANEL_VULNERABILITY sharpness reduction ruled out: crash-realism.test.mjs
  pins doorR factor <0.05 at dir.x=0.3, requires sharpness>~2.49 -- already at 3, cannot lower without
  breaking that pinned test).

## FINAL measurements (fresh `npx vite build`, verified crash-lab.mjs re-run 21/21, no console errors)
- side-mdb-50: sidePos(struck,+x)={depthM:0.213,centerZ:0.70,spanM:0.61}, sideNeg(intact)=0 exactly.
  maxStructuralOffsetM=0.245. doorL/doorRL SPRUNG (swing open, masks the cave read in profile), doorR/
  doorRR loosened, hood loosened. registry crush: right(+x,struck)=0.265, left(intact)=0.
- side-pole-32: struct depth ~0.115. doorL/doorRL loosened (stay welded -- cave read NOT masked by
  swing), doorR/doorRR/hood/trunk ATTACHED (pristine). registry crush: right(struck)=0.160, left=0.
- iihs-small-64: struct total 0.437 (front+lateral combined), doors all ATTACHED (measured, see below),
  wheel fl (struck) ATTACHED, wheel rr (diagonal-opposite) DETACHED -- pre-existing dynamic effect, not
  from my lateral code (unrelated to any of my changes; wheel-detach thresholds untouched).
- nhtsa-56 + free-161 (regression): left/right crush both exactly 0 or ~0 (free-161 right=0.00075,
  floating noise), doors/hood states identical to pre-slice baseline -- lateral field provably inert
  when there's no side hit.
- GOTCHA CAUGHT (same class as a prior slice's note): verify/*.mjs use `vite preview`, which serves
  the STALE prebuilt dist/ -- first side-fidelity battery ran against pre-change dist (maxStructural
  OffsetM read 0 for side-mdb-50 despite registry crush 0.263). Always `npx vite build` before any
  verify run after a source edit. Re-ran after rebuild -- corrected numbers above.

## Small-overlap wheel/door: measured BEFORE any tweak, no PANEL_VULNERABILITY change made
- Door: front-door panelStress at iihs-small-64 ~5-8.6 (doorL 4.99, doorR 8.64, doorRL 2.64, doorRR
  4.29) vs STRESS_LOOSEN_S1=28 -- stays ATTACHED. Root cause: PANEL_VULNERABILITY door sharpness=3
  correctly suppresses a hit whose chassis-local direction is only ~0.3-0.4 lateral (small-overlap's
  corner hit is still mostly FRONTAL-direction). RULED OUT lowering sharpness: crash-realism.test.mjs
  pins panelDirectionalFactor(doorR, {x:0.3,y:0,z:0.95}) < 0.05, which REQUIRES sharpness > ~2.49 (0.3^
  2.49=0.05) -- already at 3, essentially no headroom to lower without breaking that pinned frontal-
  immunity test. Left PANEL_VULNERABILITY untouched; documenting this as an honest, structurally-forced
  gap rather than forcing a fix that breaks a pinned invariant.
- Wheel: struck front wheel (fl) stays ATTACHED at iihs-small-64 (measured both before AND after my
  lateral/wheel-arch code -- unaffected either way, confirming it's not something my changes touch).
  A DIFFERENT wheel (rr, diagonally opposite) detaches from rotational/yaw dynamics -- not the
  reference's claimed mechanism, and NOT retuned (wheel-detach thresholds are out of my boundary).
  Implemented the "prefer visual" lever instead: WHEEL_ARCH_* accent in buildChassisField, gated on
  frontAsymmetric (deeperFront vs shallowerFront >30% gap) + narrow t-band (0.1-0.4 of frontSpan),
  struck side only -- provably inert for symmetric full-frontal and for structural-crush-visual.test.
  mjs's one pre-existing asymmetric fixture (samples nose row only, t~0.93, outside the band). Eyes-on
  verdict: front corner reads as crushed/torn (hood torn, fender mangled) but the WHEEL itself does not
  read as visibly "torn/shoved back" -- it's a chassis/fender-only nudge, cannot move the wheel RIG body
  (not a carDeformables member). Honest limitation, documented in code + here.

## Underside coherence
- LATERAL_MAX_X_FRACTION_OF_BASE=0.85 clamp on total combined x-displacement per chassis vertex
  (frontal bulge + lateral cave), scaled by the vertex's own |base x| (0 at centerline). New unit test
  proves finalX never crosses centerline sign even under a worst-case stacked (asymmetric-frontal +
  lateral) input. Eyes-on low-angle shots at every protocol (incl. free-161 extreme tier) show no
  visible inverted/spiked geometry.

## Test/verify counts (final)
- Full suite: 261/261 (252 pre-existing + 9 new in sim/side-fidelity.test.mjs), tsc --noEmit clean.
- verify/crash-lab.mjs: 21/21, 0 console errors, 0 page exceptions (re-verified against fresh build).
- verify/side-fidelity/shoot-side-fidelity.mjs + shoot-closeup-top.mjs: 0 console errors, 0 exceptions.
  Screenshots in game/verify/side-fidelity/: {side-mdb-50,side-pole-32,iihs-small-64,nhtsa-56,free-161}
  -{top,struck-side,lowangle}.png + {side-mdb-50,side-pole-32,iihs-small-64,nhtsa-56}-closeup-top.png.

STATUS: DONE. No commits made (per discipline). Diagnostic-only probe scripts left in
scratchpad/phase-c/ (probe-small-overlap.mjs, probe-lateral.mjs) -- not part of the deliverable.

# Stream C / slice C3b -- direction-aware SPRUNG (jam-not-spring on a real side hit)

## Bug (C1 x C3 interaction)
A real side-struck door JAMS SHUT and caves; springing open (C1's SPRUNG hinge state) is a
FRONTAL/oblique phenomenon (longitudinal inertia overloads the latch while the hinge, mounted
perpendicular to that load, still holds). Pre-fix, side-mdb-50 in the real crash lab (600-step settle,
occupants+ragdolls) measured doorL/doorRL == 'sprung' at settle (verify/side-fidelity/side-fidelity-
measurements.json, pre-fix version) -- visibly swinging open, masking C3's cave-in silhouette. Confirmed
via the user's side-impact top-view reference: caved, CLOSED doors.

## Fix
- panels.ts: PanelHandle gains `lateralStressWeighted: number` (init 0, same lifecycle as `stress`) --
  running numerator of a stress-weighted average of |dirLocal.x| across every hit contributing to a
  door's stress.
- welds.ts: accumulation loop now also does
  `panel.lateralStressWeighted += stressIncrement * Math.abs(dirLocal.x)` for DOOR_PANEL_KEY_SET panels
  only (hood/trunk untouched, field stays 0 -- dead weight). New exported `doorLateralFraction(panel)` =
  lateralStressWeighted/stress (0 if stress ~0). Door escalation: `shouldSprung = rawShouldSprung &&
  doorLateralFraction(panel) <= DOOR_SPRUNG_LATERAL_FRACTION_MAX` -- shouldBreak UNTOUCHED (a T-bone can
  still tear a door off; it just skips the sprung tier on the way, per side-130's existing pin).
- damage-tuning.ts: new `DOOR_SPRUNG_LATERAL_FRACTION_MAX = 0.6`.

## MEASURED (sim harness, 300-step settle -- doorLateralFraction per scenario)
  side-mdb-50 proxy (spawnSideWall(1.05)+crashSideways(50)): doorL 0.798, doorR 0.794, doorRL 0.826,
    doorRR 0.821.
  side-pole-32 proxy (rigid capsule pole r=0.15 + crashSideways(32)): all 4 doors 0.997.
  frontal 161 km/h (extreme-tier.test.mjs scenario): doorL 0.323, doorR 0.334, doorRL 0.316, doorRR 0.334.
  frontal 193 km/h: doorL 0.292, doorR 0.281, doorRL 0.292, doorRR 0.277.
Clean wide separation (frontal max 0.334 vs side min 0.794) -- 0.6 sits near the midpoint (0.564), far
from either cluster. NOTE: all 4 doors read a near-identical fraction within one crash -- expected, since
PANEL_VULNERABILITY's directional gate/shape is identical across doors, so the ratio (not the absolute
stress magnitude, which DOES differ by distance-falloff) is ~invariant to which door is "struck" vs
"intact" for a given hit population. Confirms the single global threshold applies uniformly.

## GOTCHA (same class as prior slices): plain `node` can't resolve the .ts imports outside vitest --
  measurement used a throwaway sim/_probe-lateral-fraction.test.mjs (`npx vitest run` target), deleted
  after measuring. A readable (non-runnable) copy of its logic is kept at
  scratchpad/phase-c/probe-lateral-fraction.mjs for the record.

## VERIFIED (real crash lab, fresh `npx vite build`)
- side-mdb-50 (NEW): panelStates all 4 doors == 'loosened' (no door 'sprung') -- exactly the fix.
  hood/trunk also 'loosened'. Compare pre-fix: doorL/doorRL == 'sprung'.
- side-pole-32: unaffected (doorL/doorRL 'loosened', doorR/doorRR/hood/trunk 'attached' -- same as pre-fix,
  it never reached sprung there either).
- free-161 (regression): all 4 doors still 'sprung' -- extreme-tier.test.mjs's frontal pin intact.
- nhtsa-56, iihs-small-64: unaffected (doors never touched in either).
- verify/crash-lab.mjs: 21/21, 0 console errors, 0 page exceptions.
- verify/side-fidelity/shoot-side-fidelity.mjs: 0 console errors, 0 page exceptions; full battery
  re-shot (side-mdb-50, side-pole-32, iihs-small-64, nhtsa-56, free-161) -- top/struck-side/lowangle,
  barrier hidden, overwriting the prior set. side-mdb-50-top.png read: right flank (struck side) shows a
  clear caved-in kink in the top-down silhouette, doors flush/closed (no wing-like sprung flaps) -- the
  cave-in read is no longer masked. side-mdb-50-struck-side.png: visible flank crumple, doors shut.
  free-161-top.png: doors visibly swung open (orange 'sprung' badges) -- correctly unaffected (frontal).

## HONEST SIDE-EFFECT NOTED (not fixed, out of C3b's boundary)
side-mdb-50's wheelStates changed from all-'attached' (pre-fix) to 3 detached (fl/fr/rl) post-fix. Root
cause (plausible, not chased further): a door that now stays jammed/welded-soft in place -- rather than
swinging away on a free hinge -- keeps taking the MDB trolley's continued push directly into the chassis/
suspension for longer, transmitting more reaction force into the wheel joints (WHEEL_DETACH_FORCE_MULT
etc. UNTOUCHED by this slice). Arguably a physically coherent secondary consequence (a jammed door
transmits more crash energy into the body structure than one that pops open and sheds some), not a
regression against any pinned test (full suite 261->263 green throughout; no test pins side-mdb-50 wheel
states). Flagged here for whoever picks up wheel-detach tuning next, not chased inside this slice's
welds.ts/panels.ts/damage-tuning.ts boundary.

## Tests
- sim/crash-realism.test.mjs: +2 tests -- doorLateralFraction unit test (pure, no physics) + a new
  side-mdb-50-style (50km/h) harness test asserting NO door ever reads 'sprung' and >=1 door shows real
  damage. Existing side-130 test (>=1 broken) and extreme-tier.test.mjs's 161km/h-sprung/322km/h-broken
  pins both still pass unmodified.
- Full suite: 263/263 (261 pre-existing + 2 new), tsc --noEmit clean.

STATUS: DONE. No commits made (per discipline). Boundary held to welds.ts/panels.ts/damage-tuning.ts +
tests + the re-shots.

# Stream C / slice C3c -- wheel-detach regression from C3b's jam fix

## Bug
C3b (above) correctly made a squarely-struck door JAM instead of springing open. Side effect (flagged,
not chased, in C3b's own notes): side-mdb-50 went from 0/4 wheels detached (pre-C3b) to 3/4 (fl/fr/rl,
post-C3b) in the REAL crash lab -- a real 50 km/h side-MDB test never sheds a wheel.

## MEASURED (throwaway sim/_probe-c3c-wheel-force.test.mjs, headless replica of the real guided-trolley/
pole rigs -- exact geometry/mass/speed from lab/protocols.ts + lab/barriers.ts; deleted after use, a
non-runnable copy of the reasoning lives here):
- side-mdb-50 (replica): all 4 wheels ATTACHED, but fl/rl/rr each reach 2 CONSECUTIVE steps over the
  base 4x threshold (fl peak 100.9kN=25.4x share, rl 68.5kN=17.3x, rr 22.8kN=5.7x, fr 17.4kN=4.4x/1
  consec) -- one step short of WHEEL_DETACH_DEBOUNCE_STEPS=3. Doors: doorL/doorR/doorRL 'loosened'
  (jammed), doorRR 'attached'. The real full lab (occupants/cardetail ballast + crush-M3's rate-limited
  panel-collision setHull refresh, neither present in this replica) evidently tips this over 3 for 3 of
  the 4 wheels -- consistent with a genuine near-miss, not a wildly-wrong proxy.
- side-pole-32 (replica): consec tops at 1 (fl) / 1 (rl over bypass too) -- comfortable margin either way.
- side-130 (existing sim-harness proxy, spawnSideWall(1.1)+crashSideways(130)): fl/rl detach at EXACTLY
  consec=3 over BOTH the base(4x) and bypass(6x) thresholds (fl 96.6kN=24.4x, rl 261.8kN=66x). TIMELINE
  probe: doorRL/doorR already 'broken' at step 0 (torn off within the first contact step at this
  severity), wheels fl/rl don't detach until step 2-3 -- the jammed-transmission window is already over
  by the time wheel forces ramp up.
- frontal 161/193/322 (extreme-tier.test.mjs's own harness): confirmed 2/2/4 wheels detach exactly
  matching that file's pins; doors read 'sprung' (never 'loosened') at all three speeds -- the
  frontal/oblique swing-away path, not the lateral jam path.
- Reverse plateau (~4.0x, ~80 steps, damage-tuning.ts's own doc) and the ~38kN 1-step handbrake spike:
  untouched by inspection -- reverse never gets impact context (base path unreachable regardless of
  debounce) and stays under the 6x bypass; the handbrake spike is a single step, filtered by ANY
  debounce >=1 regardless of which debounce constant applies. Not independently re-measured (no code
  path change reaches them).

## Lever chosen: (a) direction/state-aware debounce, NOT a global raise
Ruled out (b) (raise WHEEL_DETACH_FORCE_MULT globally): side-mdb-50's shortfall is DURATION (2 vs 3
consecutive steps), not magnitude (peaks are already 5-25x share, comfortably over 4x) -- raising the
magnitude bar doesn't fix a duration-based near-miss, and would need re-validating against every other
pinned scenario for no clear benefit. Ruled out a flat global WHEEL_DETACH_DEBOUNCE_STEPS raise: side-130
detaches at EXACTLY consec=3 today (measured above) -- any uniform raise flips its pinned 2-wheel loss to
0, violating "side-130 unchanged behavior". (c) (trolley buffer trim) not touched -- the shortfall isn't
about the guide over-pushing (TROLLEY_GUIDE_IMPACT_BUFFER_S=0.05s is already just 3 fixed steps), it's
about what happens to chassis/suspension dynamics AFTER the guide releases, per C3b's own hypothesis.

Implemented: `WHEEL_DETACH_JAMMED_DOOR_DEBOUNCE_STEPS = 6` (damage-tuning.ts) -- 2x the base debounce
(3->6). welds.ts part 3's wheelDebounceSteps selection becomes: EXTREME_GATE (peakSpeedMs>40, checked
first, always wins) > anyDoorJammed (any DOOR_PANEL_KEY_SET panel currently 'loosened', checked using
this step's already-escalated panel states) > base WHEEL_DETACH_DEBOUNCE_STEPS. Gate keys specifically on
'loosened' (jam), not 'sprung' (frontal swing-away, provably inert for extreme-tier) or 'broken' (severed
transmission path, provably inert for side-130 by the TIMELINE measurement above -- doors break before
the wheel plateau even starts).

## VERIFIED
- Full suite: 263/263 (unchanged from baseline -- no pin needed updating), tsc --noEmit clean.
- verify/crash-lab.mjs: 21/21 (unchanged file, per discipline).
- verify/reverse-check.mjs: fresh-spawn/after-sleep/forward-stop-reverse all PASS, wheel integrity all
  attached in every reverse case -- confirms the reverse-plateau margin is untouched.
- verify/side-fidelity/shoot-side-fidelity.mjs (fresh `npx vite build` first, per the standing gotcha):
  REAL LAB (guided trolley/pole rigs, not the sim proxy) readouts --
  side-mdb-50: wheelStates all 'attached' (was fl/fr/rl 'detached' pre-fix) -- REGRESSION FIXED. Doors
    hood/doorL/doorR/doorRL/doorRR 'loosened', trunk 'attached' (jam read preserved from C3b).
  side-pole-32: wheelStates all 'attached'. doorL/doorRL 'loosened', doorR/doorRR/hood/trunk 'attached'.
  iihs-small-64: fl/fr/rl 'attached', rr 'detached' -- unchanged (pre-existing dynamic effect, not from
    this fix, per C3's own notes).
  nhtsa-56, free-161: all wheels 'attached', doors 'sprung' at free-161 -- both regressions clean.
  Added 2 PINNED assertions to this script (side-mdb-50 + side-pole-32 all-4-wheels-attached) --
  2/2 passed. 0 console errors, 0 page exceptions.
- EYES-ON: re-shot side-mdb-50-top.png (game/verify/side-fidelity/, overwritten) and READ it directly --
  WHEELS panel shows FL/FR/RL/RR all green (attached); PANELS shows hood/doorL/doorR/rearDoorL/rearDoorR
  orange (loosened) and trunk green; top-down silhouette shows a visible inward kink on the struck
  (right) flank with doors flush/closed (no sprung wing flaps). Right crush 0.265m. Matches the target
  read (wheels present, cave + jammed doors intact). SwiftShader speckle ignored per instructions.

STATUS: DONE. No commits made (per discipline). Boundary held to damage-tuning.ts (new constant) +
welds.ts part 3 (debounce selection) + verify/side-fidelity/shoot-side-fidelity.mjs (2 new pinned
assertions + re-shot). Door/sprung escalation logic, crush tiers, and structural fields untouched.
Throwaway probe (sim/_probe-c3c-wheel-force.test.mjs) deleted after measuring.
