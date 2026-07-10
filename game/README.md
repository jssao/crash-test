# Crash Sandbox — game/ (visual foundation)

Standalone Vite + TypeScript + Three.js app. Independent npm package (own `package.json`/
`tsconfig.json`) — does not depend on the box3d-js repo root; no physics yet (this milestone is
render-only, see `docs/superpowers/specs/2026-07-08-crash-sandbox-design.md` phase **G1a**).

## Scripts

```
npm install
npm run dev          # Vite dev server
npm run build         # tsc --noEmit && vite build -> dist/ (main game AND Crash Lab, see below)
npm run preview       # serve dist/ (used by verify)
npm run analyze-car   # re-derive src/assets/car-map.ts from public/assets/car/CarConcept.glb
npm run verify        # headless screenshot + console-error check (verify/shoot.mjs)
```

## Layout

- `src/render/` — renderer (`createRenderer.ts`), quality presets (`quality.ts`), HDRI/PMREM
  environment (`environment.ts`), directional sun + shadow tuning (`sun.ts`).
- `src/scene/` — ground plane + procedural asphalt texture (`ground.ts`,
  `proceduralAsphalt.ts`), car loader + variant selection + trademark-logo sanitization
  (`car.ts`), placeholder orbit camera (`cameraOrbit.ts`), scene assembly (`buildScene.ts`).
- `src/assets/car-map.ts` — **generated** (see header) typed car geometry map: wheel/panel/
  chassis node names + world-space bounding boxes, wheelbase/track, glass materials, chosen
  material variant, and the logo-texture sanitization list. Re-run `npm run analyze-car` after
  the source GLB changes.
- `scripts/analyze-car.mjs` — the generator above; parses the raw glTF node graph directly (not
  `GLTFLoader`, which needs image/canvas decode unavailable headlessly in plain Node).
- `verify/shoot.mjs` — headless verification harness, pattern reused from the sibling
  `LIFE AGENTS/santiago-wrath` project: raw DevTools Protocol over Node's built-in WebSocket+fetch
  (no puppeteer) driving headless Brave (Chromium/SwiftShader software WebGL — no system Google
  Chrome was present on this machine). Spawns its own `vite preview`, waits for
  `window.__GAME__.ready`, captures front/side/rear screenshots, asserts zero console errors.

## Crash Lab

A second, standalone page (`crash-lab.html` -> `src/lab/main.ts`) that runs standardized NHTSA/IIHS-
style crash test protocols on the real game vehicle, as a dev/showcase environment for the damage
model. Linked discreetly from the main game's HUD credits line ("Crash Lab"); reachable directly at
`/crash-lab.html`.

Reuses the game's own vehicle/damage/occupants/renderer modules (read-only from the lab's side — it
never edits `src/vehicle/**`, `src/damage/**`, or `src/world/features/occupants/**`), but runs its own
minimal scene: a flat instrumented pad with a metric ruler/grid overlay instead of the main game's 400m
terrain/forest world, and its own barrier/trolley rigs instead of the sandbox's destructible world.

**Protocols** (selectable in the sidebar): NHTSA full-frontal 56 km/h rigid barrier; IIHS moderate
overlap 64 km/h (40%, rigid-approximated barrier); IIHS small overlap 64 km/h (25%, rigid-approximated);
side MDB approximation (guided 1500 kg trolley into the near-side door at 50 km/h); rigid pole side
impact at 32 km/h; rear impact at 80 km/h (guided trolley); and a free-configuration protocol with
speed (20-160 km/h), lateral offset, and approach-angle sliders. Every run is deterministic (fixed
speeds/geometry, or the live slider state — no `Math.random` anywhere in `src/lab/**`); the vehicle is
velocity-set at run start (mirroring `damage/scenario.ts`'s `crashSetup()`) and re-guided each fixed
step during its brief guided approach so tire/suspension assists can't bleed off the specified closing
speed before impact — see `src/lab/barriers.ts`'s doc comments for the full rationale, including the
declared approximations (rigid vs. real deformable barrier faces, guided vs. free-flying trolleys).

**Instrumentation panel** (live + post-run): crush depth in all four body regions (front/rear/left/
right — a regional generalization of the headless crash-realism harness's max-inward-displacement
probe, since the real GLB shell has no single fixed mesh id to look up, see
`src/lab/instrumentation.ts`), per-panel and per-wheel states, dented-vertex count, chassis peak
deceleration (g), and per-seat occupant telemetry (alive/ejected/state/peak accel-g) via the occupants
feature's own hooks. Camera presets TOP / SIDE / THREE-QUARTER (reusing the main game's
`scene/cameraOrbit.ts`) plus free click-drag/wheel orbit; a 0.25× slow-motion toggle (scales the
fixed-step accumulator's input `dt`, not the physics step itself); and an "Export report" button that
downloads the current run's full readout as JSON.

Verified by `verify/crash-lab.mjs` — loads the page, runs the NHTSA full-frontal protocol headlessly via
`window.__LAB__`, asserts the readout lands in the reference-spec bands
(`docs/build-log/specs/crash-deformation-reference.md`), and screenshots TOP/SIDE/THREE-QUARTER for an
eyes-on check.

## Known-not-representative

Headless SwiftShader software rendering reports very low FPS (single digits) in
`verify/screenshot-*.png`'s HUD — that reflects the software rasterizer, not real GPU performance.
