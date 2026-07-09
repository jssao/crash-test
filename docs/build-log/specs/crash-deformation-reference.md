# Crash-deformation reference spec

Reference-driven acceptance targets for the car crash-deformation model, judged against real
crash-test imagery/reports. Written for the "make car crash deformation match reality" wave, in
response to a user playtest: an 80 km/h front-right crash that "is not what happens", and doors that
fly off in frontal impacts (both wrong). This file is the yardstick the damage tuning + the
`game/verify/crash-realism/` comparison harness are calibrated against.

## Sources (public IIHS / NHTSA / FMVSS)

- **IIHS moderate overlap frontal protocol** — 40 mph (64 km/h), 40% driver-side overlap into a
  deformable barrier; intrusion measured at footwell / instrument panel / A-pillar relative to the
  seat. Good rating = little occupant-compartment intrusion; struck side takes the crush.
  <https://www.iihs.org/ratings/about-our-tests/moderate-overlap-front>
  and the current test protocol PDF
  <https://www.iihs.org/media/df1fdcc9-8335-4c79-a6e7-c2eca304a8c4/cOFgoA/Ratings/Protocols/current/Moderate%202.0%20Test%20protocol_June%202023_FINAL.pdf>
- **NHTSA NCAP full-frontal** — car driven straight into a rigid barrier at 35 mph (56 km/h), full
  width of the front end engaged; equivalent to a head-on between two like cars each at 35 mph.
  <https://www.nhtsa.gov/ratings/resources-related-nhtsas-new-car-assessment-program>
- **FMVSS 206 (door locks & retention)** — latches/hinges are designed to keep doors **closed** and
  prevent occupant ejection. NHTSA's own rulemaking record states plainly: *"Crashes such as offset
  frontals, near side impacts, and especially rollovers lead to complex loading conditions, which
  cause doors to open."* i.e. a door coming off/open is a **side-impact / rollover / complex-loading**
  event, NOT a straight frontal — in a pure frontal the doors are required to, and do, stay latched.
  <https://www.federalregister.gov/documents/2004/12/15/04-27215/federal-motor-vehicle-safety-standards-door-locks-and-door-retention-components-and-side-impact>

## The governing principle (why doors must not fly off in a frontal)

A door's hinges + latch + B-pillar carry **longitudinal** (fore-aft) crash load well — in a frontal
the door is loaded in shear/compression along its length and the latch keeps it shut. The door is
weak against **lateral push-in** (a side impact drives the door inboard and tears hinge/latch), and
against the complex loading of a rollover. So door detachment is fundamentally a **direction-aware**
outcome: essentially side impacts, rollovers, and extreme (>100 km/h) complex events — never a clean
frontal, at any speed in this game's range. The old model broke doors from a *nose* impact purely
because a distance-only stress radius reached them; that is the bug this spec corrects.

The hood, by contrast, IS frontal-weak: it buckles/tents and (at high speed) tears loose. That
behaviour is kept.

## Measurable targets per impact class

"Crush depth" below = the max chassis-local rearward displacement of the front-shell (nose)
deformable vertices, i.e. how far the nose caves in, in the game's local metres. The car is ~4 m
long, so these are scaled to read as plausible on this mesh, not literal full-size centimetres, but
they preserve the real-world **ordering and ratios** (deeper with speed; offset concentrates crush on
the struck side).

| Impact class            | Speed   | Crush depth (nose, m) | Hood            | Doors                    | Glass            |
|-------------------------|---------|-----------------------|-----------------|--------------------------|------------------|
| Frontal, full width     | 40 km/h | ~0.18–0.35            | buckle / loosen | **INTACT & attached**    | may spider       |
| Frontal / mod. overlap  | 64 km/h | ~0.38–0.52            | buckle→tear     | struck door **JAMMED, ATTACHED** | windshield shatter |
| Frontal, full width     | 80 km/h | ~0.45–0.56            | torn loose      | **attached** (may jam)   | shatter          |
| Frontal, full width     | 120 km/h| ~0.50–0.58 (capped)   | torn loose      | **attached**             | shatter          |
| **Side** into door      | 55 km/h | n/a (lateral)         | intact          | **struck door DETACHES** | door glass shatter |

Real-world anchors for the ordering: IIHS moderate-overlap (64 km/h) puts substantial crush into the
struck front corner with the occupant compartment/A-pillar mostly preserved in a good car; NHTSA full
frontal (56 km/h) collapses the whole front end while the doors stay latched. Higher closing speeds
deepen the crush monotonically; an offset concentrates it on the struck side rather than spreading it.

### Shape targets (not just depth)

- **Localised crease at the impact site**, not a broad global "cloth wrinkle" spread over the whole
  panel — real sheet metal folds sharply where it's struck.
- **Deeper max crush scales with closing speed** (a 40 km/h tap must be visibly shallower than a
  120 km/h hit, not both saturated to the same clamp).
- **Offset front-right** concentrates the crush on the right front corner; the left front stays
  comparatively clean.

## Acceptance (how this is judged)

1. `game/sim/crash-realism.test.mjs` — numeric matrix: crush depth is monotonic in speed and lands in
   the per-class bands above; **no door breaks in any frontal or offset crash** (40/64/80/120); a
   dedicated **side** impact **does** detach the struck door (proving the model discriminates
   direction, not just "doors never break").
2. `game/verify/crash-realism/shoot-matrix.mjs` — renders the real car crashing at each speed and
   screenshots TOP / SIDE / THREE-QUARTER, logging measured crush per run; the screenshots are opened
   and judged against the descriptions above until an honest reviewer calls each class *plausible*.
3. Pre-existing damage tests stay green, except the two frontal expectations that this spec flips:
   `damage-threshold-ordering`'s 55/100 km/h cases no longer require a **door** to loosen/break in a
   pure frontal (they now require the hood to take the damage and the doors to stay attached, per the
   FMVSS-206 principle above).
