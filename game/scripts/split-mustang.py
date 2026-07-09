# Deterministic Blender headless pipeline: split the ONE skinned Mustang mesh into
# separate named rigid meshes (by vertex group; glass by material), rescale to the real
# 1965 Mustang wheelbase (2743mm), reorient to the game convention (glTF Y-up, +Z forward,
# left side = +X, wheel-bottoms at Y~0), and export public/assets/car/mustang65.glb.
#
# Weights were verified 100% clean (0% blended) by inspect_mustang.py, so per-group
# separation is exact. Run:  blender --background --python scripts/split-mustang.py
import bpy, mathutils, os

SRC = "/Users/jesuscalderon/Documents/crash test/assets-src/cars/mustang-1965/source/MUSTANG_render.glb"
OUT = "/Users/jesuscalderon/Documents/crash test/game/public/assets/car/mustang65.glb"

# vertex-group -> exported node name. 'body' also yields glass sub-meshes split by material.
GROUP_TO_NODE = {
    "body": "BodyShell",
    "Hood_front": "Hood",
    "Hood_Back": "Trunk",
    "Door_L": "DoorL",
    "Door_R": "DoorR",
    "Engine": "Engine",
    "wheel_Front_L": "WheelFL",
    "wheel_Front_R": "WheelFR",
    "wheel_Rear_L": "WheelRL",
    "wheel_Rear_R": "WheelRR",
}
# 496-vert neutral_bone group is rigid detail; fold it into the shell.
MERGE_INTO_BODY = ["neutral_bone"]
GLASS_MATERIALS = {"TransparentGlass", "refract glass"}  # split out of BodyShell -> Glass*

REAL_WHEELBASE_M = 2.743

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=SRC)

# 1) drop the stray light-probe icosphere + anything that isn't the skinned 'main' mesh
for o in list(bpy.context.scene.objects):
    if o.type == 'MESH' and o.name != 'main':
        bpy.data.objects.remove(o, do_unlink=True)

main = bpy.data.objects['main']

# measure wheelbase from the rig BEFORE deleting the armature (front/rear wheel bone heads)
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
def bhead(n):
    b = arm.data.bones[n]; return arm.matrix_world @ b.head_local
wb_measured = (bhead('wheel_Front_L').y - bhead('wheel_Rear_L').y)
SCALE = REAL_WHEELBASE_M / wb_measured
print(f"measured wheelbase(Blender Y) = {wb_measured:.4f} m -> SCALE = {SCALE:.5f}")

# 2) bake rest pose: remove armature modifiers so meshes become plain static geometry
#    (rest pose == identity deform, so vertex positions are already correct).
for m in [mm for mm in main.modifiers if mm.type == 'ARMATURE']:
    main.modifiers.remove(m)
bpy.data.objects.remove(arm, do_unlink=True)
# Bake the glTF-importer's hidden Y-up->Z-up conversion into 'main' so it starts from a clean
# identity object matrix. Every later transform then composes predictably.
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = main
main.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

def separate_by_group(obj, gname):
    """Separate all verts dominant in vertex group gname into a new object; return it."""
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    if gname not in obj.vertex_groups:
        return None
    before = set(bpy.data.objects)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    obj.vertex_groups.active_index = obj.vertex_groups[gname].index
    bpy.ops.object.vertex_group_select()
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    new = list(set(bpy.data.objects) - before)
    return new[0] if new else None

# 3) fold neutral_bone verts into the body group first (assign weight to 'body')
for g in MERGE_INTO_BODY:
    if g in main.vertex_groups and 'body' in main.vertex_groups:
        # reassign: select those verts, add to body group with weight 1
        bpy.ops.object.select_all(action='DESELECT')
        bpy.context.view_layer.objects.active = main
        main.select_set(True)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='DESELECT')
        main.vertex_groups.active_index = main.vertex_groups[g].index
        bpy.ops.object.vertex_group_select()
        main.vertex_groups.active_index = main.vertex_groups['body'].index
        bpy.ops.object.vertex_group_assign()
        bpy.ops.object.mode_set(mode='OBJECT')

# 4) separate each group into its own named object
parts = {}
for gname, node in GROUP_TO_NODE.items():
    part = separate_by_group(main, gname)
    if part is None:
        print(f"WARN: group {gname} produced no geometry")
        continue
    part.name = node
    parts[node] = part
# whatever remains in 'main' is the body shell residue -> it IS BodyShell's base.
# (We separated body LAST-relevant? No — separate 'body' too so 'main' empties.)
# Ensure BodyShell exists: if 'body' was separated it's parts['BodyShell']; 'main' leftover should be empty.
leftover = len(main.data.vertices)
print(f"leftover verts in 'main' after separations = {leftover}")
if 'BodyShell' in parts and leftover == 0:
    bpy.data.objects.remove(main, do_unlink=True)
elif leftover > 0:
    # fold leftover into BodyShell
    if 'BodyShell' in parts:
        bpy.ops.object.select_all(action='DESELECT')
        parts['BodyShell'].select_set(True); main.select_set(True)
        bpy.context.view_layer.objects.active = parts['BodyShell']
        bpy.ops.object.join()
    else:
        main.name = 'BodyShell'; parts['BodyShell'] = main

# 5) split glass out of BodyShell by material
shell = parts['BodyShell']
glass_slots = [i for i, s in enumerate(shell.material_slots) if s.material and s.material.name in GLASS_MATERIALS]
if glass_slots:
    before = set(bpy.data.objects)
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = shell; shell.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='DESELECT')
    for si in glass_slots:
        shell.active_material_index = si
        bpy.ops.object.material_slot_select()
    bpy.ops.mesh.separate(type='SELECTED')
    bpy.ops.object.mode_set(mode='OBJECT')
    newg = list(set(bpy.data.objects) - before)
    if newg:
        newg[0].name = 'Glass'
        parts['Glass'] = newg[0]
        print("split Glass out of BodyShell")

# 6) scale + reorient into the GAME frame, then export without the exporter's auto up-conversion
#    (export_yup=False => Blender axes pass straight through to glTF, verified empirically).
#    transform_apply on 'main' (step 2) baked the importer's Y-up->Z-up conversion, leaving a clean
#    base (identity object matrices) that is glTF-native in axes but, measured empirically, inverted
#    in Y (roof low) and left-handed (left at -X) vs the game frame; front is already on +Z. The
#    proper rotation (det=+1, no mirroring) to the game frame (X=width with front-left at +X, +Y=up,
#    +Z=forward -- matching CarConcept.glb) is a 180deg rotation about Z: newX=-X, newY=-Y, newZ=+Z.
#    Baking Rz180*scale straight into the mesh VERTICES is export-proof (object-matrix writes were
#    observed to be dropped by the exporter). Verified: dump_gameframe reports Y-up, +Z front,
#    wheelbase 2743mm, all four wheels at minY=0, body above wheels -- and an EEVEE render shows the
#    fastback intact and upright.
allobjs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
bpy.ops.object.mode_set(mode='OBJECT')
Rz180 = mathutils.Matrix(((-1, 0, 0, 0), (0, -1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1)))
S = mathutils.Matrix.Scale(SCALE, 4)
for o in allobjs:
    o.data.transform(Rz180 @ S)
    o.data.update()
bpy.context.view_layer.update()

# Recenter to CarConcept's convention: X on the symmetry plane, Z (length) on the wheelbase
# midpoint, Y (up) dropped so wheel bottoms sit at Y=0. Compute from LIVE vertices (bound_box is
# stale after data.transform). Object matrices are identity, so vertex coords == world coords.
def vcenter(o):
    vs = [v.co for v in o.data.vertices]
    return mathutils.Vector(((min(v.x for v in vs) + max(v.x for v in vs)) / 2,
                             (min(v.y for v in vs) + max(v.y for v in vs)) / 2,
                             (min(v.z for v in vs) + max(v.z for v in vs)) / 2))
wc = [vcenter(parts[n]) for n in ('WheelFL', 'WheelFR', 'WheelRL', 'WheelRR')]
midX = sum(c.x for c in wc) / 4
midZ = sum(c.z for c in wc) / 4
minY = min(v.co.y for o in allobjs for v in o.data.vertices)
for o in allobjs:
    o.data.transform(mathutils.Matrix.Translation((-midX, -minY, -midZ)))
    o.data.update()
bpy.context.view_layer.update()

# 7) export (passthrough: Blender axes == glTF axes)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(
    filepath=OUT, export_format='GLB', use_selection=True,
    export_yup=False, export_apply=True,
)
print("EXPORTED", OUT)
print("PARTS:", sorted(parts.keys()))
print("DONE_SPLIT")
