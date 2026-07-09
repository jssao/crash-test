import bpy
scratch = "/private/tmp/claude-501/-Users-jesuscalderon-Documents-crash-test/a4af82be-c3c5-461b-8d5a-ac8e86c4535d/scratchpad/impala"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=scratch + "/source/Chevy Impala Rigged by FrigonTech.fbx")
for o in bpy.context.scene.objects:
    if o.type == 'ARMATURE':
        print("=== BONES ===")
        def wb(b, d=0):
            print("  " * d + b.name)
            for c in b.children: wb(c, d + 1)
        for b in o.data.bones:
            if b.parent is None: wb(b)
for o in bpy.context.scene.objects:
    if o.type == 'MESH' and o.name.startswith('CarUP'):
        bb = [o.matrix_world @ __import__('mathutils').Vector(c) for c in o.bound_box]
        xs = [v.x for v in bb]; ys = [v.y for v in bb]; zs = [v.z for v in bb]
        vg = [g.name for g in o.vertex_groups]
        print(f"{o.name}: center=({(min(xs)+max(xs))/2:.2f},{(min(ys)+max(ys))/2:.2f},{(min(zs)+max(zs))/2:.2f}) size=({max(xs)-min(xs):.2f},{max(ys)-min(ys):.2f},{max(zs)-min(zs):.2f}) vgroups={vg}")
