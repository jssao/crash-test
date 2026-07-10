# Tier-3: Concave car hull with real openings — design (Fable, 2026-07-09)

## Problem
The chassis collides as ONE convex hull, so the car's interior is solid space. Every downstream
hack exists because of this: occupants collision-filtered against their own car, ejection staged
via filter-flips + hull-AABB-exit checks, windshield "breaking" triggered by a trajectory-plane
test instead of contact, cardetail parts forced to be sensors-while-attached ("embedded in hull"),
debris unable to enter the cabin or rest in it.

## Engine constraint that shapes the design
`b3CreateCompoundShape` is **static-only** (vendor header note, RUN-2 audit). Irrelevant: box3d
bodies carry MULTIPLE shapes natively (chassis already has hull + ballast sensor; mass accumulates
per-shape via b3UpdateBodyMassData, proven). N convex shapes on one dynamic body = a concave
composite with real apertures. No engine changes needed.

## Shape decomposition (Mustang split meshes give the dimensions)
Replace the single hull with ~12-14 convex shapes on the chassis body:
- floorpan (thin box) · firewall+dash volume · rear bulkhead/parcel shelf · trunk tub
- roof panel + A/B/C pillars (thin angled hulls or capsules) — leaves window APERTURES real
- left/right sills + lower body sides (below glassline)
- engine-bay rails + radiator core support — the bay becomes an open-top CAVITY; the hood (already
  a separate welded body) is its lid
- nose + tail crush volumes (retain current exterior collision fidelity)
Doors/hood/trunk stay separate welded panel bodies exactly as today (their boxes already fill the
lower door apertures).

## Glass becomes real physics
Each pane (windshield, rear window) = a thin SOLID shape on the chassis. Occupant/debris hits it →
hit event → existing shatter visual fires → **destroy the pane shape** → the aperture is now
genuinely open. "Ejected through the windshield, breaking it" becomes literal contact physics.
Retires the trajectory-plane hack. (Door glass lives with door panels — shatters with the door,
already documented.)

## What it retires
Occupant↔car filtering (seat-pan-only filter remains), filter-flip on ejection, hull-AABB-exit
staging, cardetail sensor-while-attached (bay parts become SOLID inside the open cavity),
the "corpses sink into wreck" bookkeeping.

## Mass parity (hard requirement)
Capture current chassis getMassData() before migration; after building the shape set, hard-set the
same total mass/COM/inertia via setMassData (wired, proven) so ALL vehicle calibration survives
untouched. Per-shape densities chosen for realistic distribution later, as its own measured retune.

## Risks
- Contact cost: ~14 shapes on a fast body vs 1 — bench before/after (14× perf margin available).
- Occupant capsules seated in a tight concave cabin: solver jitter risk → seat contact tuning,
  possibly soft contact (surface material hertz) on interior faces.
- Panel half-extent ground-clearance clamp (e4b9790) interacts with new sills — re-verify parasitic
  contact stays dead.
- Crumple stays cosmetic (shapes don't deform) — unchanged honesty note.

## Staged rollout (each stage independently green + eyes-on)
1. **Cabin tub**: floor/firewall/bulkhead/roof+pillars/sills shapes + mass parity; keep ALL current
   filters (behavior identical). Gate: full suite byte-stable, bench, stance/handling unchanged.
2. **Real interior**: drop occupant↔chassis filter; glass pane shapes + shatter-destroy; ejection
   through actual apertures. Gate: seated stability, 30km/h no-eject, 70km/h eject-through-glass
   (now via contact), corpse-on-hood rests ON the car.
3. **Open bay**: cardetail parts solid in the cavity; hood-lid interaction; debris can land in the
   bay/cabin. Gate: containment test rewritten against cavity volumes; scatter drama preserved.

Effort: L (2 waves ≈ 1.5-2M tokens). Owner: stage 1-2 opus xhigh w/ Fable eyes-on gates; escalate
per ladder. Prereq: none — engine surface already sufficient.
