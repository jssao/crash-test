// Quality presets: the single knob that gates shadow resolution, AA and
// pixelRatio together. Kept intentionally small for the visual-foundation
// milestone — perf-budget-driven adaptive scaling (docs §9) lands with G4/G5.

export type QualityLevel = 'high' | 'medium';

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
    shadowMapSize: 2048,
    pixelRatioCap: 2.0,
    antialias: true,
    envMapSize: 256,
  },
  medium: {
    level: 'medium',
    shadowMapSize: 1024,
    pixelRatioCap: 1.4,
    antialias: true,
    envMapSize: 128,
  },
};

/** Very small heuristic — good enough for a default; real device-tier
 * detection (hardwareConcurrency/deviceMemory/FPS probe) lands later. */
export function detectDefaultQuality(): QualityLevel {
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  return cores >= 6 && mem >= 4 ? 'high' : 'medium';
}
