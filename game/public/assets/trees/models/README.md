# Tree models (optimized GLBs)

Game-ready trees decimated + textured from **Tree Pack 01** (`Tree_Pack_01.blend`, 19 source trees
with packed textures). Produced with Blender headless (whole-mesh COLLAPSE-only decimation — island
culling shreds these modeled-leaf trees; see the pipeline scripts in the session scratchpad). Foliage
materials export as glTF **alphaMode MASK** (alpha-cutout, double-sided); trunks are opaque. Textures
are embedded (bark 1024, leaf 512, bud 256). +Y up, trunk base at origin, centred in X/Z.

`src/world/features/trees/visuals.ts` loads these once and clones per instance, scaling each to its
physics size class (sapling / mid / large) from `tuning.ts`.

| GLB file        | source object | ~tris | class it serves |
|-----------------|---------------|-------|-----------------|
| `tree_005.glb`  | Tree_005      | ~3.9k | sapling         |
| `tree_004.glb`  | **Tree_023**  | ~4.5k | sapling         |
| `tree_022.glb`  | Tree_022      | ~6.0k | mid             |
| `tree_014.glb`  | Tree_014      | ~6.0k | mid             |
| `tree_013.glb`  | Tree_013      | ~7.0k | large           |
| `tree_012.glb`  | Tree_012      | ~15k  | large           |

Note: `tree_004.glb` holds **Tree_023** geometry — the original Tree_004 (a spiky-frond species)
shredded under decimation, so it was swapped for the cleaner Tree_023 while keeping the filename the
code already references.

Licensing/attribution for Tree Pack 01 is pending confirmation from the asset's owner — see the repo
`CREDITS.md` before publishing.
