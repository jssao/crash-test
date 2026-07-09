import bpy
scratch = "/private/tmp/claude-501/-Users-jesuscalderon-Documents-crash-test/a4af82be-c3c5-461b-8d5a-ac8e86c4535d/scratchpad/impala"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=scratch + "/source/Chevy Impala Rigged by FrigonTech.fbx")
total_verts = 0
def walk(o, d=0):
    global total_verts
    extra = ""
    if o.type == 'MESH':
        v = len(o.data.vertices); total_verts += v
        extra = f" verts={v}"
    print("  " * d + f"{o.type}: {o.name}{extra}")
    for c in o.children:
        walk(c, d + 1)
for o in bpy.context.scene.objects:
    if o.parent is None:
        walk(o)
print(f"TOTAL_VERTS={total_verts}")
bpy.ops.export_scene.gltf(filepath=scratch + "/impala.glb", export_format='GLB')
