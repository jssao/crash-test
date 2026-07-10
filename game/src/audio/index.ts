// SPDX-License-Identifier: MIT
//
// Public entry point for the crash-audio layer -- see engine.ts's module doc for the node-graph
// overview. main.ts should only need this barrel (+ FIXED_DT, already imported there).

export { createAudioSystem } from './engine';
export type { AudioSystem, AudioDebugSnapshot } from './engine';
export { collectCarShapes } from './carShapes';
export { AUDIO_MATERIAL } from './materials';
export type { AudioMaterialName } from './materials';
