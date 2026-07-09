import bpy, mathutils
GLB = "/Users/jesuscalderon/Documents/crash test/assets-src/cars/mustang-1965/source/MUSTANG_render.glb"
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLB)

print("=== OBJECT TREE ===")
def walk(o, d=0):
    extra = ""
    if o.type == 'MESH':
        extra = f" verts={len(o.data.vertices)} mats={[m.name for m in o.data.materials]}"
    print("  "*d + f"{o.type}: {o.name}{extra}")
    for c in o.children: walk(c, d+1)
for o in bpy.context.scene.objects:
    if o.parent is None: walk(o)

print("=== ARMATURES / BONES ===")
for o in bpy.context.scene.objects:
    if o.type == 'ARMATURE':
        print("ARMATURE:", o.name)
        def wb(b, d=0):
            print("  "*d + b.name)
            for c in b.children: wb(c, d+1)
        for b in o.data.bones:
            if b.parent is None: wb(b)

print("=== SKINNED MESH WEIGHT ANALYSIS ===")
for o in bpy.context.scene.objects:
    if o.type != 'MESH': continue
    vgs = [g.name for g in o.vertex_groups]
    if not vgs:
        print(f"{o.name}: NO vertex groups")
        continue
    me = o.data
    n = len(me.vertices)
    # per-vertex: dominant group + how blended
    grp_vertcount = {g: 0 for g in vgs}       # verts whose dominant group is g
    grp_purecount = {g: 0 for g in vgs}       # verts where dominant weight >= 0.999
    blended = 0                                # verts with 2nd weight > 0.05
    multi_hist = {}                            # #groups with weight>0.05 -> count
    idx2name = {g.index: g.name for g in o.vertex_groups}
    for v in me.vertices:
        ws = sorted(((g.weight, idx2name.get(g.group,'?')) for g in v.groups), reverse=True)
        ws = [w for w in ws if w[0] > 1e-5]
        if not ws:
            multi_hist[0] = multi_hist.get(0,0)+1
            continue
        dom_w, dom_g = ws[0]
        grp_vertcount[dom_g] = grp_vertcount.get(dom_g,0)+1
        if dom_w >= 0.999: grp_purecount[dom_g] = grp_purecount.get(dom_g,0)+1
        nsig = sum(1 for w,_ in ws if w > 0.05)
        multi_hist[nsig] = multi_hist.get(nsig,0)+1
        if len(ws) > 1 and ws[1][0] > 0.05: blended += 1
    print(f"--- MESH {o.name}: {n} verts, groups={len(vgs)}")
    print(f"    blended verts (2nd weight>0.05): {blended} ({100*blended/max(n,1):.1f}%)")
    print(f"    #sig-groups histogram: {dict(sorted(multi_hist.items()))}")
    for g in vgs:
        vc = grp_vertcount.get(g,0); pc = grp_purecount.get(g,0)
        if vc>0:
            print(f"      grp {g:20s}: dominant={vc:6d} verts, pure(>=0.999)={pc:6d} ({100*pc/max(vc,1):.0f}%)")

print("=== OVERALL DIMS (world, meters) ===")
for o in bpy.context.scene.objects:
    if o.type=='MESH':
        bb=[o.matrix_world @ mathutils.Vector(c) for c in o.bound_box]
        xs=[v.x for v in bb]; ys=[v.y for v in bb]; zs=[v.z for v in bb]
        print(f"  {o.name}: size=({max(xs)-min(xs):.3f},{max(ys)-min(ys):.3f},{max(zs)-min(zs):.3f}) center=({(min(xs)+max(xs))/2:.3f},{(min(ys)+max(ys))/2:.3f},{(min(zs)+max(zs))/2:.3f})")

print("=== BONE HEADS (world, meters) — for wheelbase/track ===")
for o in bpy.context.scene.objects:
    if o.type=='ARMATURE':
        for b in o.data.bones:
            h = o.matrix_world @ b.head_local
            print(f"  bone {b.name:16s}: head=({h.x:.3f},{h.y:.3f},{h.z:.3f})")
print("DONE_INSPECT")
