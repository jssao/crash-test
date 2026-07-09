# Car model swap evaluation — 2026-07-09

User-provided candidates (both verified CC Attribution 4.0 on their Sketchfab pages, 2026-07-09,
via user's session; attribution required in CREDITS.md — compatible with public Pages deploy):

## Candidate A: Chevy Impala *Rigged* (Frigon Tech)
- sketchfab.com/3d-models/chevy-impala-rigged-by-frigon-tech-e1c7974b8cd34697a7d651fa73d02065
- Zip: FBX + full PBR sets (body/chrome/windows/interior/wheels). 37.7k verts.
- Rig bones: Chassis, Hood, Hood.001(trunk), FL/FR/RL/RR_Door (FOUR doors), 4 wheels,
  SteeringWheel, Dashboard_lever. Body split into separate mesh fragments matching the panels
  (door pairs confirmed by bbox symmetry) → maps well onto the existing separate-mesh panel system.
- Cons: no engine; FBX texture paths need re-pathing (Blender render came out untextured);
  miniature source units (~0.57 units long — rescale required).

## Candidate B: Mustang 1965 w/ ENGINE (rigged)
- sketchfab.com/3d-models/rigged-car-mustang-1965-with-engine-3d-model-c2d4f0a6170d43f4a5a8303373ebb81a
- Zip: GLB direct (4.3MB). Single skinned mesh (18 prims) + bones: root, body → Engine,
  Hood_front, Door_L, Door_R, Hood_Back(trunk); wheel_dir_L/R (steer) + 4 wheels; steer.
- Eyes-on Blender render: EXCELLENT out of the box — dark green fastback, chrome trim, badges,
  tire lettering, modeled interior. Includes a MODELED ENGINE (the user's engine-bay ask).
- Cons: parts are skin-weighted regions of ONE mesh → pipeline must split by vertex group
  (Blender scripted step, deterministic) into separate meshes for the panel/crumple system.

## RECOMMENDATION (orchestrator): Mustang as hero car.
Engine included + best out-of-box visual quality + classic crash icon; its hood/trunk/2-door split
maps onto the existing 5-panel damage system (roof folds into shell; hatch→trunk). The modeled
engine anchors the engine-bay reveal, with our 39 detachable cardetail parts re-fitted around it
for scatter. Impala (4 doors, clean PBR) is the licensed fallback if the split-mesh path
disappoints — both stay staged in assets-src.

## Swap blast radius (honest): car-map regeneration (analyze-car.mjs generalization), unit
rescale, wheelbase/track/radius re-measurement → suspension mounts + ride height re-derive, panel
key remap (roof out, trunk in), crumple deformable re-registration on split meshes, glass shatter
mesh remap, occupant seat re-fit, cardetail placement re-fit to Mustang bay/underbody, paint pass
port. Est. 1.5-2.5M tokens. Must wait for closeout wave (vehicle/damage/terrain files in flight).
