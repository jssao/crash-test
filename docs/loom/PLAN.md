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

## Phase status ledger

| Phase | Work | Tier | Status | Tokens | Notes |
|---|---|---|---|---|---|
| P0 | Toolchain (emsdk+cmake via brew) + core wasm build + scripts/build-wasm.sh | sonnet | pending | — | emcc/cmake NOT installed; brew 6.0.2 present; node v22 ✓; vendor @ 52f1a254 ✓ |
| P0b | Enumerate box3d.h API surface (joints/contacts/raycast/heightfield/reaction forces) | haiku | pending | — | feeds P1 design; runs ∥ P0 |
| P1 | Binding design (Fable) + TS wrapper implementation (sonnet) | fable+sonnet | pending | — | widened surface per spec |
| P2 | Vitest tests: gravity, rest, memory stability | sonnet | pending | — | ∥ P3 |
| P3 | Three.js boxes example + headless render verify | sonnet | pending | — | ∥ P2 |
| P4 | npm packaging + README | sonnet | pending | — | |
| GATE-PORT | Verify BRIEF items 1–6 | loom:verifier | pending | — | |
| G1 | Game scaffold (vite+TS) + renderer (PBR/HDRI/tonemap/shadows) | sonnet (+threejs-rendering agent) | pending | — | ∥ G1b |
| G1b | Asset sourcing: car GLB w/ separable panels + HDRI + licenses | modern-threejs-assets | pending | — | risk item 3 |
| G2 | Vehicle: chassis+wheel joints+powertrain+steering (design fable, impl sonnet) | fable+sonnet | pending | — | |
| G3 | Damage: weld panels + break thresholds + crumple | fable+sonnet | pending | — | |
| G4 | World: terrain, destructibles, ramps, spawn/reset | sonnet | pending | — | |
| G5 | HUD, chase camera, input polish | sonnet | pending | — | |
| G6 | Pages deploy workflow + perf gate | sonnet | pending | — | |
| GATE-GAME | Verify items 7–12 | loom:verifier | pending | — | |

## Pass log

(append: date · phase · evaluator verdict · directive)
