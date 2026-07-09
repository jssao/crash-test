// SPDX-License-Identifier: MIT
//
// WorldFeature contract — the integration seam for self-contained world content modules
// (trees, buildings, occupants, car-detail parts, ...). Each feature lives in its OWN folder
// game/src/world/features/<name>/ with an index.ts default-exporting a WorldFeatureFactory.
// The registry (./registry.ts) discovers folders via import.meta.glob, so adding a feature
// requires ZERO edits to shared files (no main.ts / registry churn, no merge collisions).
//
// Lifecycle (driven by main.ts):
//   factory(ctx)          once at startup, after ground + vehicle + destructible world exist.
//                         Create physics bodies (SPAWN THEM ASLEEP unless they must move at t=0
//                         — sleep discipline is the perf budget's main lever) + visuals here.
//   afterFixedStep(dt)    once per physics fixed step, AFTER world.step() and the damage system.
//                         Sample body transforms into interpolation buffers here; poll your own
//                         weld/joint break conditions here.
//   applyVisuals(alpha)   once per render frame with the fixed-step interpolation alpha.
//   reset(kind)           'car' = car repair (R). 'world' = full world reset (Shift+R) — note a
//                         world reset fires reset('car') first (main.ts's doWorldRepair calls
//                         doCarRepair), then reset('world'); make both idempotent.
//   bodyCount()           current number of live physics bodies owned by the feature (perf +
//                         physics-everywhere inventory accounting; window.__GAME__ exposes sums).
//   hooks                 optional read-only playtest hooks, exposed as
//                         window.__GAME__.features[<name>] for scripted verification.
//
// HARD-WON WARNINGS (violating these has produced permanent wasm traps / runaway bugs before):
//   1. NEVER call getTransform()/getPosition() on a body you have destroyed — it is a wasm
//      "memory access out of bounds" trap that permanently poisons the module (see the despawned-
//      panel guard in main.ts's doFixedStep, and game/verify's repro-oob history). Track your own
//      despawned bodies and skip them.
//   2. NEVER cache ctx.getVehicle()'s return value across resets — the vehicle object is destroyed
//      and recreated on every car repair. Call the getter each time you need it.
//   3. Body creation order must be deterministic (no Math.random without a seeded RNG — see
//      world/materials.ts for the existing seeded-noise pattern) or the sim replay tests break.

import type * as THREE from 'three';
import type { World } from '../../../../src/ts/index.js';
import type { QualityPreset } from '../../render/quality';
import type { Vehicle } from '../../vehicle/vehicle';

export interface FeatureContext {
  world: World;
  scene: THREE.Scene;
  /** Live vehicle accessor — the vehicle is REPLACED on car repair; never cache the result. */
  getVehicle: () => Vehicle;
  /** The car's visual root (three.js graph). */
  carRoot: THREE.Object3D;
  /** Quality preset at startup (renderer-side quality changes do not re-notify features). */
  quality: QualityPreset;
}

export interface WorldFeature {
  name: string;
  afterFixedStep?(dt: number): void;
  applyVisuals?(alpha: number): void;
  reset?(kind: 'car' | 'world'): void;
  bodyCount(): number;
  hooks?: Record<string, unknown>;
  dispose?(): void;
}

export type WorldFeatureFactory = (ctx: FeatureContext) => Promise<WorldFeature> | WorldFeature;
