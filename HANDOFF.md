# Handoff — crash-sandbox game (box3d-js physics port)

**Folder:** `/Users/jesuscalderon/Documents/crash test` (renamed 2026-07-09 from `box3d-js`; the physics npm package inside is still named `box3d-js`). Branch `main`. Git history preserved across the rename.
**Date:** 2026-07-09.

## What this project is (don't re-derive — read these)

- Design spec: `docs/superpowers/specs/2026-07-08-crash-sandbox-design.md`
- Run ledger + full phase history + completion checklist: `docs/build-log/PLAN.md` (**RUN COMPLETE** section at top; per-phase token ledger; pass log). *(Was `docs/loom/PLAN.md`; the notes folder was renamed to drop the "loom" label — same content.)*
- Binding architecture: `docs/build-log/P1-binding-design.md`
- Deploy handoff: `DEPLOY.md` · Port build recon: `knowledge/04-upstream-build.md`
- Persistent memory (already written): `~/.claude/projects/-Users-jesuscalderon-Documents-crash-test/memory/` — `box3d-js-project-state.md`, `usage-budget-discipline.md`

One-liner: a from-scratch **WASM+TypeScript port of Box3D** (Erin Catto's alpha 3D engine, pinned `vendor/box3d@52f1a254`, read-only) that lives in this folder as the physics engine, plus a **realistic-visuals crash-sandbox driving game** in `game/` that consumes it. Both halves are **complete and adversarially gate-passed** (GATE-PORT pass 1/1, GATE-GAME pass 2/3).

## Folder structure (one folder holds engine + game)

- Physics engine (the `box3d-js` package): `src/` (TS binding), `src/wasm-shim/` (C shim), `build/wasm/` (compiled wasm, committed), `vendor/box3d/` (upstream, read-only), `scripts/`, `tests/`, `dist/`, `examples/`, root `package.json`.
- Game: `game/` — a standalone Vite app that imports the engine via `../../../src/ts/index.js` and loads `../build/wasm/box3d.wasm`. **The game is NOT self-contained; it depends on the engine files above it.**
- Docs: `docs/build-log/` (build ledger + design), `docs/superpowers/` (design spec), `docs/media/` (README hero shot). `HANDOFF.md` (this file). `DEPLOY.md`.

## Current state

- **Everything is committed** (working tree clean through commit `304d810` plus this reorg commit). The user is starting a Fable 5 session "to commit a ton of changes" — those are NEW changes not yet made.
- **Dev server:** run `cd "/Users/jesuscalderon/Documents/crash test/game" && npm run dev` → http://localhost:5173/ (note the SPACE in the path — quote it). Not owned across sessions; relaunch as needed.
- **Deploy is the only unfinished original goal:** no GitHub credentials on this machine (no `gh`, no SSH, no stored HTTPS). `DEPLOY.md` has the 2-command publish + Pages setup. Workflow `.github/workflows/deploy.yml` is pristine-clone-proven. (DEPLOY.md still names the GitHub repo `box3d-js`; rename to `crash-test` there if desired.)

## Most recent work (this session, Opus 4.8) — commit `304d810`

Fixed 3 driving bugs found in live play (details in the commit body):
1. No reverse → S key now reverses when stopped/rolling back (needed the forward drive's traction taper, else backward burnout).
2. Inverted steering → negated steer→angle mapping (`game/src/vehicle/vehicle.ts`); D=right, A=left now.
3. Cocked front wheels → the CarConcept GLB authors front wheels turned ~30° (show-car pose); `game/src/scene/wheels.ts` strips world-up yaw from the steered wheels' authored orientation.
Verified live via CDP; game builds; 16/16 sim tests; browser verifies 0 console errors.

## How to verify (deterministic — run these, don't trust worker claims)

From folder root: `npx vitest run` (binding, 7/7) · `npm run build` (dist, exit 0) · `node scripts/verify-dist.mjs`.
From `game/`: `npm run test:sim` (14 files/16 tests) · `npm run bench` (perf gate, ~0.14ms « 8ms) · `npm run build`.
Browser checks in `game/verify/`: `node verify/shoot.mjs` / `shoot-driving.mjs` / `shoot-crash.mjs` / `shoot-world.mjs` (each spawns its own `vite preview` + headless **Brave** — there is NO Chrome on this machine; Brave via raw CDP is the harness).

## Load-bearing facts / gotchas

- **Box3D is Y-up, meters**; `b3Quat{v,s}` maps 1:1 to `THREE.Quaternion(x,y,z,w=s)` — no coordinate conversion anywhere.
- **wasm ABI passes ALL structs by pointer** → the C shim (`src/wasm-shim/binding.c`) flattens everything; handles cross as **bigint** (`-sWASM_BIGINT`). Build is single-threaded, no SharedArrayBuffer (`scripts/build-wasm.sh`; needs `brew install cmake emscripten`). **Never modify `vendor/box3d`.**
- **wasm artifacts are committed** (`build/wasm/box3d.{mjs,wasm}`, via a `.gitignore` negation) so CI needs no Emscripten.
- The chase camera looks ALONG the car's forward axis, so world +X renders screen-left — relevant to any steering/camera sign reasoning.
- **Known residuals (documented, not bugs to chase blindly):** rare pole-graze loosens hood at ~24 km/h (`game/src/damage/damage-tuning.ts`); HUD shows gear "1" (not "R") while reversing and reverse caps ~25 km/h by design; `game/verify/playtest/battery.mjs` has stale pre-relayout lane coords; deferred binding features (compound shapes; mesh/heightfield/raycast/joint-events implemented-but-unexercised).

## Suggested skills for the next session

- **`superpowers:brainstorming`** BEFORE any new feature work (it's a hard gate in this environment).
- **`superpowers:systematic-debugging`** for any bug (the reverse fix this session came from tracing actual wheel-spin telemetry, not guessing).
- **`loom:loom-update`** if the next batch of changes is large/parallelizable (this whole project was built that way; keep updating `docs/build-log/PLAN.md` as the ledger).
- **`verify`** / the `game/verify/*.mjs` CDP harness before claiming any gameplay change works — this project's bugs (inverted steer, show-car wheels, wasm OOB) were only caught by driving it, not by unit tests.

## Committing next session

Standard flow: branch off `main` if the work is nontrivial, keep commits scoped, end messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Deploy still needs the user's GitHub creds (see `DEPLOY.md`).
