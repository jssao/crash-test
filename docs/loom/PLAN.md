# loom run plan + ledger — box3d-js port + crash sandbox game

Run started 2026-07-08. Orchestrator: Fable 5 (this session). Spec:
`docs/superpowers/specs/2026-07-08-crash-sandbox-design.md`. Port governed by `BRIEF.md`.

## Completion condition (the gate walks this checklist)

Port (BRIEF items, verbatim source of truth in BRIEF.md):
1. Core lib compiles to wasm via reproducible `scripts/build-wasm.sh` (exit 0), single-threaded,
   wasm-simd, ES module.
2. TS binding: init, world+body+shape create, step, read position/quaternion; vitest gravity-drop
   test exits 0.
3. Three.js example: N boxes drop and rest, batched HEAPF32 transform reads, renders headlessly
   without console errors.
4. Lifecycles: create→destroy loop shows stable wasm memory (test asserts).
5. npm-installable ES module package with TS types.
6. Honest README (alpha pin, single-threaded target, coordinate conventions, re-pin procedure).

Game:
7. `game/` builds (exit 0); headless screenshot shows PBR/HDRI scene with car, no console errors.
8. Scripted headless drive test: throttle moves car >20 m in 3 s; steering changes yaw. Exit 0.
9. Scripted crash test: impact above threshold destroys ≥1 panel weld; crumple displaces vertices
   (bounded). Exit 0.
10. Destructible world: scripted impact topples a stacked structure (bodies leave initial pose).
11. GitHub Pages deploy workflow green; published page loads wasm + renders (no SAB/COOP-COEP).
12. Perf: physics step avg < 8 ms in full scene on this machine.

Constraints: don't modify vendor/box3d (except documented minimal CMake workaround per BRIEF);
single precision; no SharedArrayBuffer dependency; honest rigid-body framing (no soft-body claim).
**Bound: 3 gate passes per phase; on 3rd fail stop and report blocker.**

## Budget (user directive 2026-07-08, overnight autonomous run)

Session usage cap **40%**; 3% used at directive time → ~37 points remain. Allocation: port 9 ·
game 17 · playtest+fixes 6 · gates/deploy 2 · contingency 3. Rules: one worker per phase, merged
briefs (P1+P2 one worker; P3 one; P4 minimal), haiku gates, compact returns, ≤2 re-dispatches per
phase. If hot: cut packaging polish and playtest rounds first; NEVER cut car quality, graphics,
or deformation (user's priorities). User priorities verbatim: runs well · realistic · good car
model · realistic graphics · closest-possible-to-soft-body deformation · good crash physics ·
orchestrated playtesting/simulations at the end.

## Damage upgrades (user ask: "like soft body deformation")

G3 scope now: (a) accumulated PLASTIC vertex deformation — dents persist, radius falloff,
crease noise, per-vertex max clamp; (b) weld LOOSENING before break (drop weld hertz on
mid-impacts → dangling doors/hood) then destroy on threshold; (c) wheels detachable on extreme
impacts (destroy wheel joint); (d) STRETCH: after major impacts, rebuild the chassis collision
hull from the deformed mesh (destroy+recreate hull shape, low vert count, rate-limited) so
deformation feeds back into physics.

## Phase status ledger

| Phase | Work | Tier | Status | Tokens | Notes |
|---|---|---|---|---|---|
| P0 | Toolchain (emsdk+cmake via brew) + core wasm build + scripts/build-wasm.sh | sonnet | **done** | 187,207 | cmake 4.3.4 + emcc 6.0.2 via brew; out-of-tree CMake consumes vendor/box3d/src directly (no pthread flags, vendor untouched); box3d.wasm 325KB simd; smoke green; commit d5a7396. ABI: ALL structs pass by pointer → shim design validated; P1 must add -sWASM_BIGINT |
| P0b | Enumerate box3d.h API surface (joints/contacts/raycast/heightfield/reaction forces) | haiku | **done** | 110,727 | wheel joint has suspension+spin motor+steering built in; weld constraint-force getters exist; polled hit events carry point/normal/approachSpeed; move events give changed-body transforms; handles are by-value structs → C shim (see P1-binding-design.md) |
| P1 | Binding design (Fable) + TS wrapper implementation (sonnet) | fable+sonnet | **done** | 317,355 (w/ P2) | 79 b3js_ fns; full wheel setter surface; Y-up, quat maps 1:1 to Three; commit 055dc10. Deferred: compound shapes. Untested: mesh/heightfield, raycast, joint events (game phases will exercise) |
| P2 | Vitest tests: gravity, rest, memory stability | sonnet | **done** | (merged P1) | 6/6 pass incl. zero heap growth over 220 cycles; weld force ordering sane |
| P3 | Three.js boxes example + headless render verify | sonnet | **done** | 189,868 (w/ P4) | 50/50 boxes rest, 0 console errors, moveEvents-only sync (main.ts:171-192), full-puppeteer fallback (no Chrome on machine); commit 8b21508. Orchestrator re-ran verify: PASSED |
| P4 | npm packaging + README | sonnet | **done** | (merged P3) | dist/ exports+types, verify-dist green (orchestrator re-ran), honest README w/ unexercised list; known wrinkle: zero-arg init() path in-repo only (documented); no root LICENSE file yet; commit 909a2e2 |
| GATE-PORT | Verify BRIEF items 1–6 | loom:verifier | **PASS** | 55,530 | 2026-07-08: all 6 items + 3 constraints YES w/ file:line evidence; orchestrator had re-run all deterministic checks fresh (build 0, vitest 6/6, verify-dist 0, example verify PASSED) |
| G1 | Game scaffold (vite+TS) + renderer (PBR/HDRI/tonemap/shadows) | sonnet (threejs-rendering agent) | **done** | 193,687 | AgX tonemap, PMREM HDRI (derelict airfield), sun from HDRI brightest texel, 0 console errors via Brave CDP harness (santiago-wrath pattern; no Chrome on machine — SwiftShader software GL, FPS numbers not representative), trademark textures stripped (license plate + tiresides, NOT the variants), car-map.ts measured (wheelbase 2800mm, track 1952/1969, wheel r≈390/384mm), commit 81ac297 |
| G1b | Asset sourcing: car GLB w/ separable panels + HDRI + licenses | sonnet | **done** | 126,602 | Khronos CarConcept.glb CC-BY 4.0, 11MB, 213k tris, wheels+hood+doors+hatch+roof all separate nodes; 2 Poly Haven CC0 HDRIs; committed dc1b6ca. Caveat: avoid Khronos-logo material variant (trademark); decimate if perf demands |
| G2 | Vehicle: chassis+wheel joints+powertrain+steering (design fable, impl sonnet) | fable+sonnet | pending | — | |
| G3 | Damage: weld panels + break thresholds + crumple | fable+sonnet | pending | — | |
| G4 | World: terrain, destructibles, ramps, spawn/reset | sonnet | pending | — | |
| G5 | HUD, chase camera, input polish | sonnet | pending | — | |
| G6 | Pages deploy workflow + perf gate | sonnet | pending | — | BLOCKER (user-input): no GitHub credentials on machine (no gh, no SSH, no stored HTTPS) → build deploy-READY (workflow + base path + verified prod build); user runs repo-create+push in the morning (handoff commands in final report). Item 11 verified as far as locally possible |
| GATE-GAME | Verify items 7–12 | loom:verifier | pending | — | |

## Pass log

(append: date · phase · evaluator verdict · directive)
