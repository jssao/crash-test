# Engine Bay / Interior / Underbody Component Spec — Destructible Detail Pass

Consultant deliverable for the 3D modeling agent building out procedural destructible detail on top
of the existing box3d-js crash sandbox car. This does **not** replace or restyle the car — it adds a
"hero shot" of mechanical detail that reads as credible when the hood/doors/panels come off, and
scatters believably when welds fail.

**Base vehicle:** mid-size front-engine turbocharged sports coupe (Khronos `CarConcept.glb`),
**RWD** (rear-wheel drive — matches the existing drivetrain in `game/src/vehicle/`), wheelbase
2800mm, track ~1960mm (measured asset: 1952mm front / 1969mm rear — this spec uses a flat 1960mm),
wheel radius ~390mm (measured: 390mm front / 384mm rear), overall length ~4600mm **assumed** per
brief (the actual `CarConcept.glb` measures 4357mm overall — treat the extra ~240mm as slack in the
crush-zone/overhang numbers below, or scale every X position by ×0.947 if binding tightly to the real
mesh), overall width ~2450mm assumed (informed by the real asset's measured 2542mm).

Engine choice: **turbocharged inline-4**, mounted longitudinally, canted ~12° toward the intake side.
An inline-4 is chosen over a V6/V8 specifically because it fits the low hood line — a V-configuration's
wider vee pushes the intake plumbing/plenum higher, while a canted inline block keeps its tallest
point (valve cover / turbo inlet) low enough to clear a low hoodline without a power bulge.

---

## 0. Conventions

**Origin (0,0,0):** center of wheelbase, on the ground plane, on the car's longitudinal centerline.
- **+X = forward** (toward the nose/front bumper). Front axle centerline: X = **+1400mm**. Rear axle
  centerline: X = **−1400mm**.
- **+Y = up.** Ground plane = Y = 0.
- **+Z = vehicle's right side** (passenger side for LHD markets). **−Z = left / driver side** (this
  spec assumes LHD — mirror every left/right call-out for a RHD build).

This is a documentation convention chosen for readability, **not** the game engine's internal axes —
`game/src/assets/car-map.ts` records the actual imported asset as Y-up, X-right, **Z-forward**
(root identity transform, wheel-bottoms ~Y=0). If importing these positions directly into that
pipeline, remap this doc's **X→game Z** (forward) and **Z→game X** (right).

Reference lines (derived from wheelbase 2800mm + assumed 4600mm overall length, ~950mm front overhang
/ ~850mm rear overhang, half-track ~980mm):
- Front bumper (cover) leading face: **X ≈ +2350mm**
- Rear bumper (cover) trailing face: **X ≈ −2250mm**
- Wheel/hub centerline height: **Y ≈ 390mm** (at rest, ignoring suspension travel)
- Half-track (wheel centerline): **Z ≈ ±980mm**

**Attachment strength classes** (mirrors this project's existing 3-state weld model —
`game/src/damage/panels.ts` / `welds.ts` — `attached → loosened → broken`):

| Class | Meaning | Roughly maps to existing weld tuning |
|---|---|---|
| **rigid** | Structural; should be near-unbreakable in normal gameplay crash range, or fails only in the single most extreme tier | very high break threshold, or omit break entirely |
| **firm** | Loosens then breaks under sustained/hard impact — mid-tier | similar force-multiplier band to the existing hood/door panel thresholds |
| **breaks-easily** | Breaks outright on the first moderate hit near it | low threshold, first-order impact response |
| **collapsible** *(steering column only)* | Special case: has its own intermediate "collapsed" state (telescopes/droops) below its break threshold, matching the attached→loosened→broken pattern exactly | loosen threshold reused for "collapsed" |

---

## 1. Engine Bay (priority 1 — the hero shot)

Front-to-back layout, confirmed mechanically sensible: **bumper beam → intercooler → radiator/fan →
engine block**, i.e. the intercooler sits *ahead of* the radiator (prioritizes charge-air cooling,
since boost-charge temps run hotter than coolant needs) with the radiator directly behind it and the
cooling fan pulling air through both back toward the engine. Turbo + downpipe sit on the **right
(+Z, "hot side")**; airbox + charge piping + battery sit on the **left (−Z, "cool/intake side")**,
away from exhaust heat. Brake master cylinder/booster and the steering column mount on the firewall's
driver (**left, −Z**) side, matching this spec's LHD assumption.

| # | Component | Dims mm (L×W×H unless noted) | Position X,Y,Z (mm) | Mass kg | Attaches to | Strength | Material / color | Crash behavior |
|---|---|---|---|---|---|---|---|---|
| 1 | Engine block + head (turbo inline-4, ~12° tilt) | 550×480×620 | +1580, 560, 0 | 145 | Front subframe engine mounts (2–3 rubber-isolated mounts) | firm | Cast aluminum block/head, dark gunmetal grey; crinkle-black cam cover | Mounts loosen on hard frontal hits; block pitches back/down into the firewall/transmission tunnel. **Last** engine-bay body to fully detach — drags its still-mounted alternator with it. |
| 2 | Turbocharger + downpipe (one rigid unit) | 320×260×300 housing, downpipe extends ~450mm down/back | +1520, 430, +280 | 18 | Exhaust manifold flange (studs) + downpipe hanger to subframe | breaks-easily | Cast-iron hot-side housing (heat-blued grey), cast-aluminum compressor housing (bare silver), heat-tinted stainless downpipe | Manifold studs/downpipe flex joint are the weak link on this side — tears free and tumbles clear on a moderate-hard side/frontal hit, well before the block itself lets go. |
| 3 | Intercooler (front-mount, ahead of radiator) | 650(W)×180(H)×90(thick) | +2080, 420, 0 | 8 | Front bumper beam / radiator-support crossmember (2 rubber mounts + 2 charge-pipe couplers) | breaks-easily | Bare polished aluminum bar-and-plate core, black plastic end tanks | **First** engine-bay part struck in a frontal crash (right behind the bumper beam) — crushes flat, then its mounts shear and it's driven straight back into the radiator/fan pack, folding both together. |
| 4 | Radiator + cooling fan (combined; fan is a visual-only sub-detail of this body) | 700(W)×480(H)×60(core, +120 fan shroud) | +1970, 480, 0 | 9 | Radiator-support crossmember (2 top rubber mounts, 1 lower locating pin) | breaks-easily | Aluminum core (silver), black plastic tanks/fan shroud, black fan blade | Punctures and folds rearward against the engine block once the intercooler is driven into it. No fluid sim — treat as instantly "dead" cosmetically (crushed core, bent fins) the moment its weld breaks. |
| 5 | Upper radiator hose (single bent-tube body, not a fluid hose) | ~350 length, 38 OD | +1820, 620, −120 | 0.6 | Radiator top tank ↔ engine thermostat housing (ball joint each end) | breaks-easily | Black reinforced silicone, silver wire-clamp bands | Whips free the instant either end (radiator or block) moves out of range or loses its own weld. |
| 6 | Lower radiator hose | ~380 length, 42 OD | +1830, 360, −100 | 0.7 | Radiator bottom tank ↔ engine water-pump inlet (ball joint each end) | breaks-easily | Same as upper hose | Same whip-free behavior; slightly later since mounted lower/behind the main crush zone. |
| 7 | Intake assembly: airbox + cold/hot charge piping + throttle body (one rigid unit) | 500×300×350 bounding | +1650, 620, −350 | 7 | Engine intake-manifold flange + fender-liner intake-scoop bracket | breaks-easily | Black textured plastic airbox, blue-anodized aluminum charge piping, black rubber couplers | Thin-wall plastic/aluminum with rubber couplers throughout — rips free as one piece rather than shattering; one of the first 3–4 parts gone in any hard front/left hit. |
| 8 | Battery | 260×175×200 | +1420, 650, −780 | 15 | Battery tray (bolted hold-down clamp) on front subframe/fender structure | breaks-easily | Black plastic case, yellow/red warning-label decal, silver terminals | Hold-down clamp is a single thin bracket — shears on a moderate hit. At 15kg it becomes its own small wrecking ball once loose; let it scatter early. |
| 9 | Brake master cylinder + booster (combined) | 350(depth)×220×260 | +1180, 600, −380 | 9 | Firewall bulkhead, 4 through-bolts (driver side) | firm | Matte black booster drum, cast-aluminum master cylinder, black reservoir cap | Safety-critical firewall mount holds through moderate hits; only tears loose in a severe frontal crash once the firewall is visibly caving — a "late-stage" detach cue. |
| 10 | Strut brace (front) | 900(span)×60×80 bar | +1300, 780, 0 | 2.5 | Both front strut-tower tops (2 bolted points) — towers themselves are fused to the chassis hull, **not** their own body | breaks-easily | Blue-anodized/brushed aluminum bar, black rubber isolator pucks | Bolt-on accessory brace — one of the easiest, earliest parts to pop off, even from a moderate hit or hard landing; sits right at the top of the bay for visibility. |
| 11 | Alternator | 150×140×160 | +1480, 480, −100 | 5 | Engine-block bracket (pivot + tension bolt) — belt is visual-only, no body | firm | Cast aluminum housing, natural silver/grey | Rides on the engine's own bracket — stays attached through most hits; only comes free once the engine block itself is torn loose (or a direct hit lands on it specifically). |
| 12 | Coolant + washer reservoir (combined twin-tank) | 300×150×220 | +1250, 700, +520 | 2 | Right strut-tower/fender bracket (2 plastic clips) | breaks-easily | Translucent natural-white plastic (coolant), translucent blue-tinted plastic (washer) | Clip mounts snap almost immediately on any hit reaching this far back — among the first things loose, alongside the strut brace and battery. |
| 13 | Fuse box | 220×160×90 | +1200, 680, −620 | 1.5 | Firewall bracket near the battery tray | breaks-easily | Black plastic, yellow warning-label decal, visible relay/fuse terminals | Light plastic box on a single bracket — pops free easily; a good small readable prop lying in wreckage next to the battery. |

**Visual-only, no dynamic body** (fused/welded to a parent, per the ≤40-body budget below):
- **Exhaust manifold** — bolted directly to the head, modeled as fused detail on the engine block body (#1); too small/tucked to justify its own body.
- **Strut towers** — part of the chassis unibody shell, not a separate body (the strut *brace*, #10, is).
- **Wiring harness** — cosmetic bundle draped along the bay perimeter.
- **Accessory belt** — thin cosmetic ribbon between alternator/crank pulleys.

---

## 2. Interior (priority 2)

Cabin runs roughly X+1150 (firewall) back to X−700 (rear seatback); front seat H-point ~X+700, rear
bench ~X−500. Driver side = **−Z** (LHD).

| # | Component | Dims mm | Position X,Y,Z (mm) | Mass kg | Attaches to | Strength | Material / color | Crash behavior |
|---|---|---|---|---|---|---|---|---|
| 14 | Driver seat (bucket) | 500×550×950 | +700, 300, −380 | 18 | Seat rail bolted to floor pan (4 bolts) | firm | Black cloth/leather, red contrast stitching, black plastic shell | Seat-rail bolts are strong by design (occupant safety) — anchored through most impacts; tears loose only in a severe rollover/side-impact tier, ejecting dramatically (belt still attached). |
| 15 | Passenger seat (bucket) — mirror of #14 | 500×550×950 | +700, 300, +380 | 18 | same | firm | same | same |
| 16 | Rear bench (2-person, one combined body) | 1200×500×800 | −500, 280, 0 | 22 | Rear floor-pan/seat-pan brackets | firm | Matching black cloth/leather, red stitching | Similar bolted-down resilience to the front seats; in a rear impact, one of the later interior parts to give way, after the fuel tank/rear subframe area ahead of it. |
| 17 | Dashboard (instrument binnacle molded in — not separate) | 1400×250×350 | +950, 850, 0 | 20 | Dash crossbeam to A-pillar/firewall (3–4 points) | firm | Molded charcoal soft-touch plastic, carbon-look trim ring around binnacle | Buckles/cracks visually under frontal impact well before detaching; fully breaks loose only in a severe frontal crash, dropping into the footwell — a strong cabin-intrusion beat. |
| 18 | Steering wheel + column (one combined body) | Wheel Ø380; column 550×45 | Wheel center +900, 620, −380; firewall mount +1150, 600, −380 | 7 | Firewall-mounted collapsible bracket | **collapsible** (see §0) | Black leather-wrapped wheel, silver spokes, matte black column shroud | Real columns are an intentional crumple/energy-absorption element: on hard frontal impact it should **loosen/"collapse" first** (column compresses ~150mm, wheel droops) well before any full break — reuse the existing attached→loosened→broken pattern rather than a straight snap. |
| 19 | Center console + shifter | 350×700×250 | +550, 400, 0 | 9 | Floor tunnel, bolted (2–3 points), between front seats | firm | Gloss-black plastic, brushed-aluminum shifter trim + knob | Reasonably protected between the seats — survives most impacts; a violent rollover or T-bone can pop it from its floor-tunnel bolts. |
| 20 | Pedal cluster (brake + clutch/throttle, one assembly) | 300×250×350 | +750, 150, −400 | 4 | Firewall/pedal-box bracket | firm | Brushed-aluminum pedal faces, matte black steel box/arms | Tucked low in the footwell, mostly protected; comes loose only alongside the severe frontal "firewall intrusion" beat, same tier as the master cylinder/booster. |
| 21 | Rearview mirror | 250×60×80 | +780, 1080, 0 | 0.3 | Windshield header (single ball-and-socket mount) | breaks-easily | Black plastic housing, silvered glass | The single easiest interior part to pop off in this whole spec — snaps from almost any meaningful jolt (frontal, rear, rollover); a cheap "first thing to fly off" cabin gag. |

**Visual-only, no dynamic body:**
- **Door cards** — geometry/material detail merged into the existing `doorL`/`doorR` panel bodies (`game/src/damage/panels.ts`); they follow whatever state (attached/loosened/broken) the parent door is in, no new body needed.
- **Instrument binnacle** — molded as part of the dashboard body (#17), not separate.

---

## 3. Underbody / Extremities (priority 3 — cheap, scatters well)

RWD confirmed: driveshaft runs front (transmission, behind the engine) to rear (differential, in the
rear subframe).

| # | Component | Dims mm | Position X,Y,Z (mm) | Mass kg | Attaches to | Strength | Material / color | Crash behavior |
|---|---|---|---|---|---|---|---|---|
| 22 | Catalytic converter | 300×Ø180 | +700, 280, +150 | 7 | Downpipe mid-pipe flange + one underbody hanger to floor pan | firm | Brushed stainless shell, light heat-straw/blue discoloration near welds | Underbody scrapes (curbs, ramps, hard landings) are the real threat here, not frontal hits directly — the hanger bracket is the weak point; a hard underbody strike shears it and the cat drags/tumbles free. |
| 23 | Muffler + tailpipe (mid-pipe merged in, one assembly) | 550×200×180, tip extends 150 past rear bumper line | −1900, 260, +200 | 12 | 2 rubber-isolated underbody hangers + cat mid-pipe flange | firm | Brushed stainless canister, polished chrome tip | Classic "dragging exhaust" gag on a hard rear impact or underbody strike — rubber hangers tear before the pipe bends much, so it skids/bounces along the ground trailing the car. |
| 24 | Fuel tank (rear saddle tank) | 900×500×250 | −1150, 280, 0 | 40 (shell + assumed partial fuel load as fixed rigid mass — no fluid sim) | 2 steel retaining straps to floor pan/rear subframe | **rigid** | Matte black-coated stamped steel (or HDPE) shell | Deliberately the toughest attachment underbody — real fuel tanks are engineered not to detach in ordinary crashes. Stays put through everything except the single most severe rear-impact tier; when it finally goes it's a big, heavy, late/rare detach, roughly paired with the rear subframe failing. |
| 25 | Front subframe | 1000×900×200 cradle | +1450, 280, 0 | 35 | Chassis unibody, 4 bolted mounts — cradles engine mounts, front lower control arms, steering rack | **rigid** | Matte black powder-coated steel | Structural — intact through the entire "moderate" range and most of "hard"; tears from the unibody only in the most extreme frontal tier, taking the engine mounts and front control arms with it. |
| 26 | Rear subframe | 950×900×200 | −1450, 280, 0 | 30 | Chassis unibody, 4 bolted mounts — cradles differential, rear control arms, rear driveshaft support | **rigid** | Matte black powder-coated steel | Same rare/late failure tier as the front subframe, mirrored for the rear; pairs with the fuel tank for a "everything back there lets go at once" beat in a severe rear impact. |
| 27 | Driveshaft (single rigid tube, U-joint yokes both ends) | 1400×Ø70 | −150, 260, 0 (spans transmission to rear diff, under the cabin floor tunnel) | 9 | Transmission output flange (front, ball joint) + rear diff input flange (rear, ball joint) | firm | Bare steel tube (natural silver-grey), black U-joint yokes | A hard rear impact, or the rear subframe/diff shifting out of alignment, snaps a U-joint — once one end lets go the shaft whips down and drags/gouges the ground before the second joint follows. |
| 28 | Front-left lower control arm | 450×100×80 | +1350, 320, −850 | 5 | Front subframe (inner bushing) + FL hub/knuckle (outer ball joint) | firm | Cast aluminum, matte silver/gunmetal | Bends visibly then tears from its inner bushing on a hard frontal/side hit to that corner — pairs with the existing wheel-detach mechanic for a "wheel folds under the car" beat. |
| 29 | Front-right lower control arm — mirror of #28 | 450×100×80 | +1350, 320, +850 | 5 | same | firm | same | same |
| 30 | Rear-left lower control arm | 420×100×80 | −1350, 320, −850 | 6 | Rear subframe (inner bushing) + RL hub/knuckle | firm | Cast aluminum, matte silver/gunmetal | Rear-corner equivalent of #28/29. |
| 31 | Rear-right lower control arm — mirror of #30 | 420×100×80 | −1350, 320, +850 | 6 | same | firm | same | same |
| 32 | Front bumper beam | 1300×120×100 | +2230, 430, 0 | 8 | Front subframe/chassis rails, 2 crash-box mounts (sits behind the bumper *cover*, which is a visual-only chassis-shell crumple, not a body) | firm | Matte black powder-coated steel, visible crush-can ribbing | **First** new rigid body struck in a frontal crash. Crumples/bends in place on light-moderate hits, then shears from its crash-box mounts on a hard hit, punching straight back into the intercooler. |
| 33 | Rear bumper beam | 1250×120×100 | −2150, 430, 0 | 9 | Rear subframe/chassis rails, 2 crash-box mounts | firm | Matte black powder-coated steel | Mirrors the front beam's role; shears free on a hard hit, driving the muffler/tailpipe ahead of it out of position. |
| 34 | Headlight L | 450×350×250 | +2200, 620, −850 | 3.5 | Front fender/radiator-support structure (clip + 2 bolts) | breaks-easily | Clear polycarbonate lens over black projector housing, chrome bezel | Pops from its clips almost immediately on any frontal corner hit — cracks visually first, then detaches whole; cheap high-value early scatter piece. |
| 35 | Headlight R — mirror of #34 | 450×350×250 | +2200, 620, +850 | 3.5 | same | breaks-easily | same | same |
| 36 | Taillight L | 400×300×200 | −2120, 620, −850 | 1.8 | Rear quarter-panel structure (clip + bolts) | breaks-easily | Red/clear polycarbonate lens, black housing | Rear-corner equivalent of the headlight — pops loose easily on any rear-corner hit. |
| 37 | Taillight R — mirror of #36 | 400×300×200 | −2120, 620, +850 | 1.8 | same | breaks-easily | same | same |
| 38 | Side mirror L | 200×150×180 (projects outboard) | +550, 1150, −1250 | 0.9 | Door panel (existing `doorL` body), single breakaway stalk | breaks-easily | Body-color painted shell, black glass edge, chrome-rimmed glass | Snaps off its stalk on almost any side-scrape or rollover — among the easiest, earliest parts in the whole car to detach; classic "first thing gone" in a side impact. |
| 39 | Side mirror R — mirror of #38 | 200×150×180 | +550, 1150, +1250 | 0.9 | Door panel (existing `doorR` body) | breaks-easily | same | same |

**Visual-only, no dynamic body:**
- **Upper control arms / tie rods / toe links** — small welded detail fused near each lower control arm/hub (implied multi-link look without a full per-link body).
- **Front + rear license plates** — thin plates welded to the front/rear bumper beam.
- **Wiper arms/blades** — welded to the cowl/hood, cosmetic only.
- **Heat shields** — cosmetic plating fused to nearby structural parts (subframe, downpipe, muffler).

---

## 4. Crash Choreography — hard frontal impact

Failure order, tuned so the earliest, cheapest, most visible parts go first and the structural/safety
parts go last. Numbers below refer to the component numbering above.

1. **Front bumper cover** dents/crushes (this is the existing chassis-shell visual crumple system, `game/src/damage/crumple.ts` — not a new body; zero cost, first visual cue).
2. **Front bumper beam** (#32, firm) takes the real structural load — bends/crumples in place on lighter hits, shears from its crash-box mounts once the hit is hard enough.
3. **Intercooler** (#3, breaks-easily) is driven straight back, crushes flat, mounts fail almost immediately.
4. **Radiator + fan** (#4, breaks-easily) takes the intercooler's momentum, punctures/folds against the engine block; mounts fail right after.
5. **Upper + lower radiator hoses** (#5, #6, breaks-easily) whip free the moment either end (radiator or engine) moves out of range.
6. **Headlights L/R** (#34, #35, breaks-easily) pop from their corner clips — can happen in parallel with 2–4 depending on impact offset/width.
7. **Strut brace, coolant/washer reservoir, fuse box** (#10, #12, #13 — all breaks-easily, light bolt-on/clip-mounted bay accessories) shake loose from shock transmitted through the bay structure.
8. **Battery** (#8, breaks-easily) hold-down clamp shears; it becomes a loose 15kg mass tumbling inside the crumpling bay.
9. **Intake assembly** and **turbo + downpipe** (#7, #2, breaks-easily) tear free from their light couplers/studs as the engine itself begins to shift.
10. **Rearview mirror** snaps off (#21) and the **steering wheel/column** (#18) hits its "collapsed" intermediate state — cabin cues that can trigger in parallel once the impact is severe enough to reach the cabin.
11. **Alternator** (#11, firm) stays put — it's mounted to the engine, not the bay, so it only comes free once the block itself moves.
12. **Brake master cylinder + booster, dashboard, pedal cluster** (#9, #17, #20 — all firm) — only now, at the hard/severe end of the range, do these firewall/cabin-mounted parts start to fail, as the firewall visibly caves.
13. **Engine block + head** (#1, firm — last engine-bay body to go): mounts finally give way; the block pitches back/down into the firewall/transmission-tunnel area, dragging its still-attached alternator with it.
14. **Front subframe + front lower control arms** (#25, #28, #29 — rigid/firm): only in the most extreme frontal tier does the subframe itself tear from the unibody, taking the control arms with it. Rare, catastrophic finale — not a routine crash outcome.
15. **Hood** (existing panel, `game/src/damage/panels.ts`) buckles/flies per its own already-tuned loosen/break stress model — this should land in roughly the same "moderate–hard" window as steps 2–5 above, since that's when the hero shot (open engine bay) needs to be visible. No change needed to the existing 5-panel system; just note the sequencing dependency.

*(Rear-impact choreography mirrors this list using the rear-side components — rear bumper beam →
muffler/tailpipe → fuel tank/rear subframe/driveshaft as the late, rare, heavy finale — and is not
repeated in full here.)*

---

## 5. Body Budget

| Section | New dynamic bodies | Running total |
|---|---|---|
| Engine bay | 13 (#1–13) | 13 |
| Interior | 8 (#14–21) | 21 |
| Underbody / extremities | 18 (#22–39) | **39** |

**39 new dynamic-capable bodies total — under the ≤40 budget.** Plus the visual-only items listed at
the end of each section (exhaust manifold, strut towers, wiring harness, belt, door cards, instrument
binnacle, upper control arms/tie rods, license plates, wipers, heat shields — none of these need their
own body; they're welded/fused geometry on a parent).

This is on top of (not counting) the 10 bodies the game already has: 1 chassis + 4 wheels + 5 existing
damage panels (hood/doorL/doorR/hatch/roof, `game/src/damage/panels.ts`).

---

## 6. Integration note (for whoever wires these into box3d, not the modeler)

Total added mass across the 39 new bodies is **~506kg** (engine bay ~223kg, interior ~98kg, underbody
~184kg). The existing chassis (`game/src/vehicle/tuning.ts`'s `CHASSIS_MASS_KG = 1279`) already
represents an abstracted engine-mass concentration via the low-slung "ballast" sensor sphere (see that
file's `COM_LOWER_OFFSET_M` / `BALLAST_*` comments — explicitly described as standing in for "a dense
engine block/cast-iron mass concentration"). If/when any of these components become real dynamic
bodies rather than pure visual detail, that ballast assumption will need reconciling against the real
component masses above — the same way `CHASSIS_MASS_KG` was already reduced by exactly the 5 existing
panels' summed mass (71kg) to keep total car mass conserved. Skipping that reconciliation would
silently double-count engine mass (once via the ballast workaround, once via these new bodies).
