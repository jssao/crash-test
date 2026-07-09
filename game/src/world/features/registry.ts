// SPDX-License-Identifier: MIT
/// <reference types="vite/client" />
//
// WorldFeature registry — discovers feature folders (./<name>/index.ts) via import.meta.glob and
// instantiates them in DETERMINISTIC path order (sorted), because physics body creation order
// affects solver iteration order and the sim tests assert deterministic replays.
//
// Headless sim tests should import a feature module directly (plain relative import) rather than
// going through this registry — import.meta.glob is a vite-ism; it works under vitest too, but a
// direct import keeps a feature's tests independent of every other feature.

import type { FeatureContext, WorldFeature, WorldFeatureFactory } from './feature';

interface FeatureModule {
  default: WorldFeatureFactory;
}

export interface WorldFeatureSet {
  all: WorldFeature[];
  afterFixedStep(dt: number): void;
  applyVisuals(alpha: number): void;
  reset(kind: 'car' | 'world'): void;
  totalBodyCount(): number;
  /** name -> feature.hooks, for window.__GAME__.features (scripted playtests). */
  hooks: Record<string, Record<string, unknown>>;
  dispose(): void;
}

export async function createWorldFeatures(ctx: FeatureContext): Promise<WorldFeatureSet> {
  const modules = import.meta.glob('./*/index.ts', { eager: true }) as Record<string, FeatureModule>;
  const paths = Object.keys(modules).sort();

  const all: WorldFeature[] = [];
  for (const path of paths) {
    const factory = modules[path]?.default;
    if (typeof factory !== 'function') {
      console.warn(`[features] ${path} has no default-export factory — skipped`);
      continue;
    }
    all.push(await factory(ctx));
  }

  const hooks: Record<string, Record<string, unknown>> = {};
  for (const f of all) if (f.hooks) hooks[f.name] = f.hooks;

  return {
    all,
    afterFixedStep(dt) {
      for (const f of all) f.afterFixedStep?.(dt);
    },
    applyVisuals(alpha) {
      for (const f of all) f.applyVisuals?.(alpha);
    },
    reset(kind) {
      for (const f of all) f.reset?.(kind);
    },
    totalBodyCount() {
      let n = 0;
      for (const f of all) n += f.bodyCount();
      return n;
    },
    hooks,
    dispose() {
      for (const f of all) f.dispose?.();
    },
  };
}
