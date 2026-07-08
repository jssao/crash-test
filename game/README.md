# Crash Sandbox — game/ (visual foundation)

Standalone Vite + TypeScript + Three.js app. Independent npm package (own `package.json`/
`tsconfig.json`) — does not depend on the box3d-js repo root; no physics yet (this milestone is
render-only, see `docs/superpowers/specs/2026-07-08-crash-sandbox-design.md` phase **G1a**).

## Scripts

```
npm install
npm run dev          # Vite dev server
npm run build         # tsc --noEmit && vite build -> dist/
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

## Known-not-representative

Headless SwiftShader software rendering reports very low FPS (single digits) in
`verify/screenshot-*.png`'s HUD — that reflects the software rasterizer, not real GPU performance.
