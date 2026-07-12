// SPDX-License-Identifier: MIT
//
// Shared shape for one browsable model in the Model Viewer. catalog.ts produces these (by calling the
// game's real procedural/GLB builders); ui.ts lists them; main.ts frames the selected one on the
// turntable.

import type * as THREE from 'three';

/** Per-model geometry stats — the numbers you actually care about for a game asset. */
export interface ModelStats {
  triangles: number;
  vertices: number;
  meshes: number;
  materials: number;
}

export interface ModelEntry {
  /** Stable unique id (used as the list key). */
  id: string;
  /** Human label shown in the list. */
  label: string;
  /** Grouping bucket, e.g. 'Vehicle' | 'Trees' | 'Structures' | 'Props' | 'Occupants' | 'Engine bay'. */
  category: string;
  /** The display object to place on the turntable. Already self-contained (safe to add/remove from a
   * parent group repeatedly); NOT yet recentered — main.ts recenters+frames it on selection. */
  object: THREE.Object3D;
  /** Optional one-line dimension string, e.g. "1.8 × 1.3 × 4.5 m". */
  dims?: string;
  /** Optional short note (material, source, part count…). */
  note?: string;
  /** Geometry stats (tris/verts/meshes/materials), computed once at catalog build. */
  stats?: ModelStats;
}
