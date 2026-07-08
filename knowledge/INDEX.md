# knowledge · box3d-js

Captured research for the Box3D→JS/WASM port, so the execution session doesn't re-derive it.
Read on demand — the BRIEF cites these.

| File | Read when |
|---|---|
| `01-box3d-facts.md` | You need the ground truth on what Box3D is, its features, license, and stability. |
| `02-wasm-binding-approach.md` | You're deciding the toolchain — how to compile C→WASM and expose it to JS/TS. |
| `03-prior-art-box2d-wasm.md` | You want a proven template pipeline to mirror (Box2D→WASM). |
| `04-upstream-build.md` | You need the real Box3D build structure: pinned commit, CMake targets, deps, API headers. (Written from a clone inspection.) |

## Provenance

All facts gathered 2026-07-08 via web research + a direct clone-and-inspect of upstream. Where a
claim needs re-verification against fast-moving alpha upstream, it is flagged **[VERIFY]** in the file.
Sources are linked inline. When upstream changes, re-run the inspection in `04` and bump the pinned SHA.
