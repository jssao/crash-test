// Quality presets: the single knob that gates shadow resolution, AA and pixelRatio together.
// G4/G5: 3 tiers (high/medium/low), a 60-frame render benchmark picks the default once at boot (on
// top of the earlier devicePixelRatio/hardwareConcurrency heuristic), and the chosen/cycled level
// persists across reloads via localStorage. Q cycles high -> medium -> low -> high (main.ts).

export type QualityLevel = 'high' | 'medium' | 'low';

export interface QualityPreset {
  level: QualityLevel;
  /** Directional-light shadow map resolution (square). */
  shadowMapSize: number;
  /** Hard cap on devicePixelRatio — never trust devicePixelRatio uncapped. */
  pixelRatioCap: number;
  /** MSAA sample count requested from the WebGL2 context via `antialias`. */
  antialias: boolean;
  /** PMREMGenerator source equirect size is fixed by the HDRI; this only
   * affects how large a background render target we tolerate. */
  envMapSize: number;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualityPreset> = {
  high: {
    level: 'high',
    shadowMapSize: 4096,
    pixelRatioCap: 2.0,
    antialias: true,
    envMapSize: 256,
  },
  medium: {
    level: 'medium',
    shadowMapSize: 2048,
    pixelRatioCap: 1.4,
    antialias: true,
    envMapSize: 128,
  },
  low: {
    level: 'low',
    shadowMapSize: 1024,
    pixelRatioCap: 1.0,
    antialias: false,
    envMapSize: 64,
  },
};

export const QUALITY_CYCLE: readonly QualityLevel[] = ['high', 'medium', 'low'];

export function nextQualityLevel(current: QualityLevel): QualityLevel {
  const i = QUALITY_CYCLE.indexOf(current);
  return QUALITY_CYCLE[(i + 1) % QUALITY_CYCLE.length];
}

const STORAGE_KEY = 'box3d-crash-sandbox:quality';

/** Persists the current quality choice (Q cycling, or the auto-detected boot default) so a reload
 * keeps the player's preference rather than re-running the heuristic/benchmark every time. */
export function saveQualityPreference(level: QualityLevel): void {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Storage can be unavailable (private browsing, quota) -- losing the preference across reloads
    // is a cosmetic-only failure, not worth surfacing to the player.
  }
}

export function loadQualityPreference(): QualityLevel | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'high' || v === 'medium' || v === 'low' ? v : null;
  } catch {
    return null;
  }
}

/** Small heuristic fallback (no persisted preference, benchmark unavailable/skipped) — real
 * device-tier signal used only as a rough prior before the render benchmark below runs. */
function heuristicDefaultQuality(): QualityLevel {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  if (cores >= 6 && mem >= 4) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

/** Back-compat/simple entry point (no benchmark) -- kept for any caller that just wants the quick
 * heuristic. main.ts prefers detectDefaultQualityViaBenchmark() below when a persisted preference
 * isn't already available. */
export function detectDefaultQuality(): QualityLevel {
  return heuristicDefaultQuality();
}

/**
 * Runs a quick ~60-frame render benchmark (caller supplies a `renderOneFrame` callback that renders
 * exactly one frame of the ALREADY-BUILT scene) and picks a quality tier from the measured average
 * frame time. Falls back to the plain heuristic if fewer than a handful of frames can be measured
 * (e.g. renderOneFrame throws) rather than blocking startup indefinitely.
 */
export async function detectDefaultQualityViaBenchmark(renderOneFrame: () => void, frames = 60): Promise<QualityLevel> {
  const prior = heuristicDefaultQuality();
  try {
    const samples: number[] = [];
    // Warm up (shader compile, first-frame allocations) — don't count these frames.
    for (let i = 0; i < 5; i++) renderOneFrame();
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      renderOneFrame();
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    if (median < 10) return 'high'; // comfortably over 100fps-equivalent frame budget
    if (median < 20) return 'medium'; // ~50fps-equivalent
    return 'low';
  } catch {
    return prior;
  }
}
