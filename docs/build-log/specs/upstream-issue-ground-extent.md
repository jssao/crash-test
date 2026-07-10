# Draft upstream report: trajectory diverges with a static shape's absolute coordinate magnitude (float32 seed, framed as a question)

**Status:** framed as a question + data, not a bug demand. This may well be expected behavior for a
single-precision engine — we want to ask, not assert.

## Summary

Changing only the half-extent of one large **static** ground box (never its position, never anything
the car geometrically touches differently) perturbs our vehicle simulation's trajectory, starting from
a ~1e-7-scale difference at the very first physics step and growing, via our own vehicle's chaotic
traction dynamics, to a multi-centimeter positional divergence and non-matching yaw rates after 4
seconds of an otherwise-identical, zero-steering, full-throttle straight-line run.

## Environment

- `box3d` @ our pin `52f1a254ad62a74c9f2a80052f436e2263b95214` (2026-07-06), single precision
  (`BOX3D_DOUBLE_PRECISION=OFF`, the default — matches our JS `Float32` usage throughout).
- Our own game/vehicle sim built on top of box3d (Three.js + wasm), fixed 60 Hz step, 4 substeps.
- Repro lives in-tree, already committed: `game/sim/diag/ground-extent-repro.test.mjs`.

## Repro (already in-tree; description below for a standalone port)

The test creates, for each of three static-ground half-sizes (250 m, 1000 m, 10000 m — always
centered at the same position, `y = -0.5`, so the actual ground **surface** the car's wheels contact is
identical in all three runs; only how far the box's own far edges sit from the origin changes),
an identical dynamic vehicle at an identical starting pose, applies **full throttle, zero steering, no
brake** for 240 fixed steps (4 s at 60 Hz), and records chassis `x`, `z`, yaw rate, and speed every
step, then diffs the three runs bit-for-bit.

```js
async function run(halfSize, steps) {
  const world = new World(native, { gravity: { x: 0, y: -10, z: 0 } });
  createGroundBody(world, halfSize); // static box, half-extent = (halfSize, 0.5, halfSize)
  const vehicle = createVehicle(world);
  const rows = [];
  for (let i = 0; i < steps; i++) {
    stepVehicle(vehicle, { throttle: 1, brake: 0, steer: 0, handbrake: false }, FIXED_DT);
    world.step(FIXED_DT, FIXED_SUBSTEPS);
    rows.push({ /* chassis x, z, yawRate, speed */ });
  }
  return rows;
}
```

## Measured results (this run, honest numbers)

```
first bit-exact divergence: 250-vs-1000 at step=0, 250-vs-10000 at step=0 (of 240)
  step=0: halfSize250   x=-5.231598265709181e-7  z=0.00020595639944076538  yawRate=-0.0000922153449399424
  step=0: halfSize1000  x=-7.116198617040936e-7  z=0.00020592659711837769  yawRate=-0.00012111478344110254
  delta   x=-1.885e-7   z=-2.980e-8               yawRate=-2.890e-5

after 240 steps (4s):
  halfSize250   x=0.031135  z=41.943420  yawRate=0.000160  speed=72.8918
  halfSize1000  x=0.081671  z=41.945877  yawRate=0.001486  speed=72.9084
  halfSize10000 x=0.165350  z=41.951950  yawRate=0.002511  speed=72.9463

|x| divergence 250-vs-1000  at final step = 5.054e-2 m
|x| divergence 250-vs-10000 at final step = 1.342e-1 m
```

Notes on what this means:

- **The divergence exists from step 0**, at a ~1-2e-7 magnitude in position and ~1-3e-5 in yaw rate —
  it is not accumulated numerical drift over many steps, it is present immediately.
- **It grows** over 4 s of straight-line, zero-steering driving to a 5.05 cm (250-vs-1000) / 13.4 cm
  (250-vs-10000) lateral (`x`) divergence, and — notably — to three *different, all-nonzero* yaw rates
  (0.000160 / 0.001486 / 0.002511 rad/s) from a maneuver that has no steering input and should in
  principle track dead straight (yaw rate ≈ 0) in all three runs.
- The growth is **not linear** with the halfSize ratio (1000/250=4× halfSize → 1.6× the final-x
  divergence of 250-vs-10000/250-vs-1000's ratio would predict if it were simple ULP scaling) — 40× the
  ground halfSize (10000 vs 250) does NOT produce anywhere near 40× the divergence of 4× the halfSize
  (1000 vs 250). This is consistent with chaotic amplification of a small step-0 seed rather than a
  divergence that scales predictably/linearly with the shape's coordinate magnitude.

## Why we believe this is a float32 seed, amplified by our own chaotic vehicle dynamics (not necessarily a box3d defect)

`BOX3D_DOUBLE_PRECISION=OFF` — everything is single precision. A static box's half-extent feeds into
its computed AABB and into broadphase/narrowphase (SAT/manifold) intermediate math; at float32, larger
input magnitudes carry coarser representable precision (larger ULP at that scale). Even though the
ground **surface the wheels actually touch never moves** across our three runs, some intermediate
computation whose numeric range depends on the static box's own absolute size differs at the
least-significant-bit level, producing the observed sub-microscopic step-0 seed. Our vehicle's own
traction/slip feedback loop is a documented nonlinear, chaos-prone system (root-caused separately in
this project as sensitivity to asymmetric per-wheel mount geometry, since made robust/symmetrized —
see `docs/build-log/PLAN-2.md`, commit `e4b9790`) — it's the kind of system where a ~1e-7 seed
plausibly amplifies to centimeters over a few seconds, which is exactly what we measured. We are not
asserting this about box3d's determinism guarantees in general — we did not test whether the SAME
half-size repeated across separate runs is bit-identical (we have no evidence of that kind of
non-determinism, only of a difference **across different half-sizes** of the same static shape).

## Minimal repro description (for a standalone/vendor-side port)

Two static ground boxes of different half-extent (both centered identically, both far larger than
where a single dynamic body ever travels in the test window), one dynamic body dropped/driven
identically onto each, zero asymmetric input, compare state after N fixed steps. Our in-tree version
additionally drives a full vehicle (throttle + wheel joints) to make the amplification path
observable in real units (centimeters, not just raw floats); a pure free-fall-and-rest single-box
repro would likely show only the step-0-scale seed without the amplification, since it lacks our
chaotic traction feedback loop.

## Question for upstream (not a fix request)

1. Is this the expected class of float32 precision sensitivity for an engine that keeps
   `BOX3D_DOUBLE_PRECISION=OFF` by default — i.e., "the numeric path for broadphase/narrowphase against
   a large static shape is expected to shift at the ULP level with that shape's own absolute
   coordinate magnitude, even when the actually-touching geometry is unchanged" — and therefore
   something downstream consumers should design around (e.g., don't expect bit-identical output when
   only a large static shape's extent changes)?
2. Or is there a specific computation (AABB construction, SAT axis search, or manifold clipping) that
   could be made scale-invariant (e.g., done in the shape's local frame before the final transform,
   rather than at world-space magnitude) that would remove the step-0 divergence for shapes whose
   contact geometry is otherwise identical?

We are not requesting a change — this may well be wontfix/expected for a single-precision engine — but
wanted to report the measured numbers in case it's either a known/documented tradeoff we should link to
in our own docs, or a genuinely fixable scale-invariance gap.

## Our own mitigation (for context, not part of the ask)

We do not rely on bit-identical output across different ground sizes; instead we validated our own
gameplay-critical trajectories (kicker-ramp launch) for robustness **across** a range of ground
half-sizes (250 / 1000 / 5000 / 10000) rather than chasing determinism across sizes — see
`docs/build-log/PLAN-2.md`'s B-wave vehicle deep-pass notes ("kicker robust @ground
250/1000/5000/10000, pin removed").
