# Upstream Box3D delta report — pin → HEAD

Compiled 2026-07-10. Method: cloned `https://github.com/erincatto/box3d.git` fresh to a scratch
directory (outside this repo), confirmed the pinned commit resolves and exists in that clone, and ran
`git diff <pin>..HEAD` / `git log <pin>..HEAD`. Everything below is grounded in that byte-for-byte
diff — not speculation. `vendor/box3d` in this repo was NOT touched; it stays checked out at the pin.

## Pin vs. HEAD

- **Pinned:** `52f1a254ad62a74c9f2a80052f436e2263b95214` — "Name cache (#53)", 2026-07-06 17:33:45 -0700
  (per `knowledge/04-upstream-build.md`; verified present in the fresh clone).
- **Upstream HEAD (at time of writing):** `ef8ef0187a6fb7d93fc847872a538096b4a5833d` — "Ghost collision
  improvements (#61)", 2026-07-08 23:53:06 -0700.
- **Delta size: exactly 1 commit**, spanning 2 days. `main` is the only relevant branch (one stray
  topic branch `origin/edge_edge_optimization` exists upstream, not merged, not considered here).
  39 files changed, +16639/−12086 lines — but the overwhelming majority of that line count is
  regenerated shader header blobs under `samples/shaders/generated/` (capsule/cube/geom/sphere GLSL,
  ~20.9k of the changed lines) plus a new 413-line samples file (`samples/sample_issues.cpp`, adds a
  "Ghost Collisions" repro sample). **Core engine (`src/`, `include/`) touched: 12 files, all small.**

## (a) Wheel joint — untouched

`src/wheel_joint.c`, `src/joint.c`, `src/joint.h` do **not appear in the diff at all**. The suspected
force-readback bug (see `docs/build-log/specs/upstream-issue-wheel-force.md`) is confirmed **still
present verbatim** at upstream HEAD — same buggy line, same file, same offset. Not fixed.

## (b) Contact solver / friction / rolling resistance

No friction or rolling-resistance code changed. The one substantive core change in this delta is
entirely about **contact generation for hull-vs-triangle (mesh and heightfield) shapes**, framed as
reducing "ghost collisions" (phantom/duplicate contact points against internal mesh or heightfield
edges):

- `include/box3d/types.h`: `b3ShapeDef` gains a new field `bool enableSpeculativeContact` (default
  `true` in `b3DefaultShapeDef()` — i.e. current/legacy behavior is preserved unless a caller opts
  out).
- `src/shape.c` / `src/shape.h`: new shape flag `b3_enableSpeculative`, set from the def field.
- `src/contact.c` / `src/contact.h`: new contact flag `b3_enableSpeculativePoints`, set when both
  shapes in a contact have the flag.
- `src/mesh_contact.c`, `src/triangle_manifold.c`: `b3CollideHullAndTriangle()` (and its two internal
  helpers `b3CollideHullFace`/`b3CollideTriangleFace`) now take a `bool enableSpeculative` parameter;
  when `false`, points with positive separation (i.e. speculative/not-yet-touching contact points) are
  dropped and the speculative-distance threshold used for early-outs becomes `0.0f` instead of
  `B3_SPECULATIVE_DISTANCE`.

Net effect: this is an **opt-out knob**, off by default (speculative contact stays ON unless you flip
`enableSpeculativeContact = false` on a shape def) — trades continuous-collision robustness under fast
rotation for fewer ghost contacts on mesh/heightfield surfaces. Nothing here touches friction
coefficients, rolling resistance, or the wheel/suspension solve.

## (c) Heightfield

Not touched by this delta at all. `b3_heightShape`, `b3CreateHeightFieldShape`, `b3CreateGrid`,
`b3CreateWave`, ray/shape-cast-vs-heightfield, etc. (`include/box3d/box3d.h`, `include/box3d/
collision.h`) already existed at our pin and are unchanged. **We don't use this shape type** — our
game's ground is a single giant static **box** (`game/src/vehicle/vehicle.ts:338-342`,
`createGroundBody()`, half-extent up to 10,000 m), not a heightfield. Relevant context for the
ground-extent report (`upstream-issue-ground-extent.md`): the anomaly we characterized there is a
property of a large static **box**, unrelated to this delta's mesh-contact changes.

## (d) Shape mutation / runtime hull-vertex update

Already available **at our pin**, unaffected by this delta: `b3Shape_SetHull`, `b3Shape_SetMesh`,
`b3Shape_SetCapsule`, `b3Shape_SetSphere` (`include/box3d/box3d.h:951-966`). We audited our own wasm
shim (`src/wasm-shim/binding.c`) and confirmed **none of these are currently wired** — a pre-existing
binding gap on our side, not something upstream drift introduced or fixed. If we ever want runtime
hull/vertex mutation (e.g. procedural crumple deformation instead of panel-swap-on-break), the API is
already sitting there; wiring it needs no re-pin.

## (e) Breaking API changes relevant to a re-pin

1. `b3CollideHullAndTriangle()` gained a trailing `bool enableSpeculative` parameter — **source-breaking
   only for direct callers of this low-level collision primitive**. We call it nowhere in our shim or
   game code (confirmed by grep); zero impact for us.
2. `b3GetByteCount()` return type changed `int32_t` → `int` (`include/box3d/base.h`). Identical width on
   our target (wasm32/Emscripten); non-breaking in practice, technically an ABI/signature change.
3. Recording format major version bumped **3 → 4** (`src/recording.h`) to serialize the new
   `enableSpeculativeContact` field. We don't use box3d's record/replay feature in the shipped game (not
   found in our shim or game code) — no impact, but worth re-confirming before any re-pin.
4. Root `CMakeLists.txt` no longer force-enables the OBJC language for Apple; that `enable_language
   (OBJC)` call moved into `samples/CMakeLists.txt`. Our wasm build already sets `BOX3D_SAMPLES=OFF`, so
   this is a net-neutral-to-slightly-cleaner change for us (one less irrelevant toggle in the path we
   actually build).
5. `src/platform.h` atomic-load rewrite is **MSVC-only** (`#if defined(_MSC_VER) && !defined(__clang__)`
   branch); our Emscripten/Clang build takes the untouched `__GNUC__`/`__clang__` branch. No impact.

## Re-pin cost/benefit

**Gain:** the ghost-collision opt-out flag (we don't currently hit ghost-collision symptoms worth
naming) plus assorted samples-only improvements. That's the entire delta — one commit, no wheel-joint
fix, no friction/rolling-resistance change, no heightfield change, no shape-mutation API change.

**Cost, per `knowledge/04-upstream-build.md`'s re-pin procedure:** re-run the upstream inspection, bump
the pinned SHA, rebuild the core-only wasm target (`BOX3D_SAMPLES=OFF` path is logically untouched —
low risk), re-run our full suite (~90+ tests across root + game) since the recording format bumped and
one low-level collision-primitive signature changed (we don't call either, but worth a green run to be
sure), re-verify `verify:dist` + driving/soak checks still pass. Given the tiny, mostly-cosmetic/
samples-side diff, estimated effort is **well under an engineer-hour**.

**Verdict: LOW priority, LOW risk, LOW reward.** Nothing in this delta fixes the wheel-force bug (it's
still there, byte-identical) or changes the ground-extent characterization (heightfield/box code path
untouched). Re-pin opportunistically — e.g. the next time `vendor/box3d`'s CMake integration is touched
for another reason — rather than as a standalone task.

## Honesty

Upstream was fully reachable; the pin hash resolved cleanly in a fresh clone and matches the commit
already checked out in `vendor/box3d` (verified via `git log -1` in-tree). All claims above come from a
direct `git diff`/`git log` between the two commits, not from changelog reading or inference.
