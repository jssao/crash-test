#!/usr/bin/env python3
"""
prepare-s90.py — from-scratch, re-runnable headless Blender prep script for the Volvo S90
Blender asset -> the crash-sandbox game's car GLB.

Run with:
  /opt/homebrew/bin/blender --background --python game/scripts/prepare-s90.py

What it does (see docs/loom/p0b-mustang-coupling.md + scripts/analyze-car.mjs for the game-side
contract this asset must satisfy):
  1. Loads the source .blend (139 flat meshes, 7 collections, no armature, no engine modeled,
     1:1 meter scale, Door Front/Door Rear are single X-mirrored meshes).
  2. Applies every modifier per-object, choosing a Subdivision level per object BEFORE applying:
       - "floor" objects (Hood/Doors/Trunk/Bumpers/Fender/Body shell) are auto-tuned to the
         smallest subdivision level that clears a minimum post-modifier vertex count (the
         deformation density budget — the whole point of this swap vs. the old Mustang car).
       - "ceiling" objects (wheel rigid parts, seats, dashboard) have their Subdivision disabled
         (level 0) and are decimated down to a target vertex count afterward — these are dense
         source meshes, not meshes needing MORE density.
       - everything else is just applied with its authored default levels.
  3. Splits the mirrored Door Front / Door Rear (+ their handles + door glass) into independent
     DoorL/DoorR (front pair) and DoorRL/DoorRR (rear pair) objects via loose-part separation on
     world-space X sign (source file already labels FL/FR e.g. Brake Disc FL at +X, matching the
     game's "left at +X" convention, confirmed against car-map.ts's Mustang WheelFL centerMm X>0).
  4. Groups each wheel corner's 7 rigid sub-parts (tire/rim/wheelhub/brake disc/caliper/rim
     bolt/rim emblem) under an Empty parent node named WheelFL/FR/RL/RR — analyze-car.mjs already
     supports this (childNodes / subtreeBox union), it's just unused by the flat Mustang split.
  5. Renames everything to the game convention with NO trailing spaces (every object name is
     stripped; known misspellings/typos fixed: "Windsheild" -> "Windshield" etc.).
  6. Merges the non-detachable exterior shell pieces (Body Frame + bumpers + front fender +
     grille + underbody + quarter trim + mirrors) into one "BodyShell" node — this is the
     equivalent of the Mustang's single BodyShell chassis node; there is no separate bumper/fender
     PanelKey in the game's damage model, so these must live inside the one deformable shell.
  7. Adds a procedural low-poly EngineBlock (+ battery + radiator boxes, dark rough materials)
     positioned under the Hood's actual bounding box so a torn/tented hood doesn't reveal void.
  8. Aligns the car to world Y=0 at the lowest point (tire contact patch) — Blender's own glTF
     exporter performs the Z-up -> Y-up axis conversion automatically on export, so no manual
     axis-swap matrix is needed here (unlike split-mustang.py, which was compensating for a
     different, quirkier source file).
  9. Resizes + packs all textures (max 1024px body/interior, 512px small parts by name keyword).
 10. Exports GLB to game/public/assets/car/volvo-s90.glb.

Re-running is idempotent from the SOURCE file's perspective (it always opens the pristine .blend
fresh and never saves it back), so tuning the LEVEL/TARGET dicts below and re-running is safe.
"""
import math
import os
import sys

import bpy
from mathutils import Vector

# ---------------------------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------------------------
SRC_BLEND = "/Users/jesuscalderon/Downloads/Volvo S90/Volvo S90.blend"
GAME_ROOT = "/Users/jesuscalderon/Documents/crash test/game"
OUT_GLB = os.path.join(GAME_ROOT, "public/assets/car/volvo-s90.glb")

# Deformation density FLOORS (min verts after modifier apply) — the reason for this whole swap.
FLOOR_TARGETS = {
    "Hood": 7000,
    "Door Front": 10000,  # combined cage BEFORE L/R split -> each half should clear ~5000
    "Door Rear": 10000,
    "Trunk": 4000,
    "Bumper Front": 4000,
    "Bumper Rear": 4000,
    "Fender Front": 10000,  # single continuous cage spans both sides in this source file
    "Body Frame": 20000,  # topped up further below once BodyShell merge-partner sum is known
}
MAX_SUBSURF_LEVEL_SEARCH = 4

# Dense rigid-part CEILINGS (decimate down to ~this many verts after modifiers, subsurf disabled).
CEILING_TARGETS = {
    "Tire": 3000,
    "Brake Disc": 1500,
    "Caliper": 800,
    "Rim": 3000,
    "Rim Bolt": 300,
    "Rim Bolts": 300,  # source has one inconsistent plural ("Rim Bolts RR")
    "Rim Emblem": 500,
    "Wheelhub": 1200,
    "Driver Seat": 3000,
    "Passenger Seat": 3000,
    "Rear Seats": 3200,  # shared 2-up bench, slightly above the flat "seats ~3k" per-seat figure
    "Dashboard": 2500,
    "CenterConsole": 1800,
}

BODYSHELL_MERGE_PARTNERS = [
    "Bumper Front",
    "Bumper Rear",
    "Fender Front",
    "Grille",
    "LowerGrille",
    "Underbody",
    "QuarterPanel Chrome",
    "QuarterPanel Rubber",
    "MIrror",
    "MIrrorTurnSignal Glass",
    "MirrorTurnsignal Reflector",
    "Windsheild Trim",
]

# Overshoot control for FLOOR_TARGETS: subsurf levels are integer (~4x per level), so a naive
# "smallest level that clears the floor" search can massively overshoot (observed: Hood floor
# 7000 -> level 2 -> 25922 actual). After finding that level and applying, decimate back down
# toward floor*OVERSHOOT_TARGET_MULT whenever the raw result exceeds floor*OVERSHOOT_TRIGGER_MULT,
# so every floor target is still cleared but without ballooning the total vertex/file-size budget.
OVERSHOOT_TRIGGER_MULT = 1.5
OVERSHOOT_TARGET_MULT = 1.2

# Anything NOT explicitly floor/ceiling targeted (headlight/taillight trim, grille, underbody,
# mirrors, exhaust, wipers, etc.) still needs a sane cap — these are rigid, non-deforming visual
# detail, not crush-relevant, and the source file's default Subdivision levels (often 2) applied
# across ~80 such objects were the dominant cause of the first export's 950k-vert / 93MB overshoot.
MERGE_PARTNER_CAP = 2500  # non-floor BodyShell merge partners (Grille, Mirror, trim, ...)
TRIM_CAP = 1800  # everything else outside any explicit budget (Headlights/Taillights/Other/etc.)

WHEEL_CORNERS = ["FL", "FR", "RL", "RR"]
SUBPART_RENAME = {
    "Tire": "Tire",
    "Rim": "Rim",
    "Wheelhub": "Wheelhub",
    "Brake Disc": "BrakeDisc",
    "Caliper": "Caliper",
    "Rim Bolt": "RimBolt",
    "Rim Bolts": "RimBolt",
    "Rim Emblem": "RimEmblem",
}

TEXTURE_MAX_BODY = 1024
TEXTURE_MAX_SMALL = 512
# Non-color ("data") maps -- normal/roughness/metallic/ORM/AO/bump -- carry far less perceptible
# detail than base-color maps and PNG-compress poorly (normal maps especially are high-frequency
# noise, ~4MB each at 1024px in this asset). Capping THESE more aggressively than the nominal
# 1024/512 body/small split is what actually gets the GLB under the <=30MB hard budget (the first
# full-res pass came in at 61MB, ~46MB of which was images, dominated by a handful of 1024px
# normal maps) -- so these caps intentionally go below the literal "1024 body / 512 small" wording
# where needed to satisfy the harder, explicit file-size ceiling.
TEXTURE_MAX_BODY_DATAMAP = 384
TEXTURE_MAX_SMALL_DATAMAP = 192
DATAMAP_KEYWORDS = ["normal", "rough", "metal", "_orm", "gloss", "bump", "height", "_ao", "occlusion"]
SMALL_PART_KEYWORDS = [
    "bolt", "emblem", "badge", "logo", "disc", "caliper", "bulb", "stalk", "knob",
    "buckle", "license", "plate", "switch", "button", "vent", "stitch",
]

log_lines = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s)
    log_lines.append(s)


# ---------------------------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------------------------
def eval_vcount(o):
    deps = bpy.context.evaluated_depsgraph_get()
    eo = o.evaluated_get(deps)
    me = eo.to_mesh()
    n = len(me.vertices)
    eo.to_mesh_clear()
    return n


def find_min_subsurf_level(o, floor, max_level=MAX_SUBSURF_LEVEL_SEARCH):
    ssm = next((m for m in o.modifiers if m.type == "SUBSURF"), None)
    if ssm is None:
        return eval_vcount(o), None
    for lvl in range(0, max_level + 1):
        ssm.levels = lvl
        bpy.context.view_layer.update()
        n = eval_vcount(o)
        if n >= floor:
            return n, lvl
    return n, max_level


def apply_all_modifiers(o):
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
        except RuntimeError as e:
            log("WARN could not apply", m.name, "on", o.name, "->", e)
            o.modifiers.remove(m)


def decimate_to(o, target):
    n = len(o.data.vertices)
    if n <= target:
        return n
    ratio = max(0.02, min(0.99, target / n))
    bpy.context.view_layer.objects.active = o
    dm = o.modifiers.new(name="DecimateTarget", type="DECIMATE")
    dm.ratio = ratio
    try:
        bpy.ops.object.modifier_apply(modifier=dm.name)
    except RuntimeError as e:
        log("WARN decimate failed on", o.name, "->", e)
        o.modifiers.remove(dm)
    return len(o.data.vertices)


def floor_tune_and_apply(o, floor):
    """Find the smallest Subdivision level clearing `floor`, apply all modifiers, then trim any
    gross overshoot back down toward floor*OVERSHOOT_TARGET_MULT via Decimate (still >= floor)."""
    find_min_subsurf_level(o, floor)
    apply_all_modifiers(o)
    n = len(o.data.vertices)
    if n > floor * OVERSHOOT_TRIGGER_MULT:
        n = decimate_to(o, int(floor * OVERSHOOT_TARGET_MULT))
    return n


def world_center_x(ob):
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return sum(c.x for c in corners) / 8.0


def world_bbox(ob):
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    xs = [c.x for c in corners]
    ys = [c.y for c in corners]
    zs = [c.z for c in corners]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def join_objects(objs, new_name):
    objs = [o for o in objs if o is not None]
    if not objs:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    active = bpy.context.view_layer.objects.active
    active.name = new_name
    return active


def split_mirror_lr(name, left_name, right_name):
    """Apply all modifiers on a mirrored object, then separate by loose parts and regroup by
    world-space X sign (>=0 -> left, <0 -> right), matching the source's own FL/FR (+X/-X)
    convention. Returns (left_obj, right_obj)."""
    o = bpy.data.objects[name]
    apply_all_modifiers(o)
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")
    pieces = [ob for ob in bpy.context.selected_objects if ob.type == "MESH"]
    left_pieces = [p for p in pieces if world_center_x(p) >= 0]
    right_pieces = [p for p in pieces if world_center_x(p) < 0]
    left = join_objects(left_pieces, left_name)
    right = join_objects(right_pieces, right_name)
    return left, right


def join_into(piece, target):
    if piece is None or target is None:
        return target
    bpy.ops.object.select_all(action="DESELECT")
    piece.select_set(True)
    target.select_set(True)
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.join()
    return bpy.context.view_layer.objects.active


def strip_prefix_target(name):
    """Match a raw object name against FLOOR/CEILING target keys (exact or corner-suffixed)."""
    if name in FLOOR_TARGETS:
        return "floor", name
    for key, target in CEILING_TARGETS.items():
        for corner in WHEEL_CORNERS:
            if name == f"{key} {corner}" or name == f"{key}{corner}":
                return "ceiling", key
        if name == key:
            return "ceiling", key
    return None, None


# ---------------------------------------------------------------------------------------------
# 1. Load
# ---------------------------------------------------------------------------------------------
bpy.ops.wm.open_mainfile(filepath=SRC_BLEND)
log("loaded", SRC_BLEND)

# ---------------------------------------------------------------------------------------------
# 2. Global name normalization: strip ALL whitespace, fix known typos
# ---------------------------------------------------------------------------------------------
RENAME_FIX = {
    "Windsheild": "Windshield",
    "Windsheild Null": "Windshield Null",
    "Windsheild Rear": "RearWindow",
    "Windsheild Rear Null": "RearWindow Null",
    "Windsheild Trim": "Windshield Trim",
    "WindsheildWiper Left": "WindshieldWiperL",
    "WindsheildWiper Right": "WindshieldWiperR",
    "MIrror": "Mirror",
    "MIrrorTurnSignal Glass": "MirrorTurnSignal Glass",
}
for ob in list(bpy.data.objects):
    ob.name = ob.name.strip()
for old, new in RENAME_FIX.items():
    if old in bpy.data.objects and old != new:
        bpy.data.objects[old].name = new
# keep BODYSHELL_MERGE_PARTNERS / handle names in sync with the fixups above
BODYSHELL_MERGE_PARTNERS = [RENAME_FIX.get(n, n) for n in BODYSHELL_MERGE_PARTNERS]

mesh_objects_start = [o.name for o in bpy.data.objects if o.type == "MESH"]
log("mesh objects at load:", len(mesh_objects_start))

# ---------------------------------------------------------------------------------------------
# 3. Door split: Door Front -> DoorL/DoorR, Door Rear -> DoorRL/DoorRR (+ handles + door glass)
# ---------------------------------------------------------------------------------------------
floor_tune_and_apply(bpy.data.objects["Door Front"], FLOOR_TARGETS["Door Front"])
doorL, doorR = split_mirror_lr("Door Front", "DoorL", "DoorR")
log("DoorL/DoorR verts:", len(doorL.data.vertices), len(doorR.data.vertices))

floor_tune_and_apply(bpy.data.objects["Door Rear"], FLOOR_TARGETS["Door Rear"])
doorRL, doorRR = split_mirror_lr("Door Rear", "DoorRL", "DoorRR")
log("DoorRL/DoorRR verts:", len(doorRL.data.vertices), len(doorRR.data.vertices))

hL, hR = split_mirror_lr("Door Front Handle", "_tmpHandleFL", "_tmpHandleFR")
doorL = join_into(hL, doorL)
doorR = join_into(hR, doorR)

hRL, hRR = split_mirror_lr("Door Rear Handle", "_tmpHandleRL", "_tmpHandleRR")
doorRL = join_into(hRL, doorRL)
doorRR = join_into(hRR, doorRR)

gL, gR = split_mirror_lr("FrontDoorGlass", "_tmpGlassFL", "_tmpGlassFR")
doorL = join_into(gL, doorL)
doorR = join_into(gR, doorR)

gRL, gRR = split_mirror_lr("RearDoorGlass", "_tmpGlassRL", "_tmpGlassRR")
doorRL = join_into(gRL, doorRL)
doorRR = join_into(gRR, doorRR)

doorL.name, doorR.name, doorRL.name, doorRR.name = "DoorL", "DoorR", "DoorRL", "DoorRR"
log(
    "final doors:",
    "DoorL", len(doorL.data.vertices),
    "DoorR", len(doorR.data.vertices),
    "DoorRL", len(doorRL.data.vertices),
    "DoorRR", len(doorRR.data.vertices),
)

DOORS_HANDLED = {
    "Door Front", "Door Rear", "Door Front Handle", "Door Rear Handle",
    "FrontDoorGlass", "RearDoorGlass",
    "DoorL", "DoorR", "DoorRL", "DoorRR",
}

# ---------------------------------------------------------------------------------------------
# 4. Generic per-object pass: floor/ceiling auto-tune, or plain modifier apply.
#    (Body Frame + BodyShell merge-partners are floor-tuned here too, but NOT joined yet — the
#    join happens last, after every OTHER object's modifiers are applied, so any Shrinkwrap
#    elsewhere still has a valid, unmutated target at the time it's baked.)
# ---------------------------------------------------------------------------------------------
per_part_report = {}

remaining = [
    o for o in bpy.data.objects
    if o.type == "MESH" and o.name not in DOORS_HANDLED and not o.name.startswith("_tmp")
]

for o in remaining:
    name = o.name
    kind, key = strip_prefix_target(name)
    if kind == "floor":
        n = floor_tune_and_apply(o, FLOOR_TARGETS[key])
        per_part_report[name] = n
    elif kind == "ceiling":
        ssm = next((m for m in o.modifiers if m.type == "SUBSURF"), None)
        if ssm is not None:
            ssm.levels = 0
        apply_all_modifiers(o)
        n = decimate_to(o, CEILING_TARGETS[key])
        per_part_report[name] = n
    else:
        apply_all_modifiers(o)
        n = len(o.data.vertices)
        cap = MERGE_PARTNER_CAP if name in BODYSHELL_MERGE_PARTNERS else TRIM_CAP
        if n > cap:
            n = decimate_to(o, cap)
        per_part_report[name] = n

log("generic pass done, objects processed:", len(remaining))

# ---------------------------------------------------------------------------------------------
# 5. Wheel corner grouping: Empty parent WheelFL/FR/RL/RR + renamed rigid children
# ---------------------------------------------------------------------------------------------
wheel_report = {}
for corner in WHEEL_CORNERS:
    children = []
    for raw_prefix, clean_prefix in SUBPART_RENAME.items():
        candidate = f"{raw_prefix} {corner}"
        alt = f"{raw_prefix}s {corner}"  # "Rim Bolts RR" plural quirk
        ob = bpy.data.objects.get(candidate) or bpy.data.objects.get(alt)
        if ob is None:
            continue
        newname = f"{clean_prefix}{corner}"
        if ob.name != newname:
            ob.name = newname
        children.append(ob)
    if not children:
        log("WARN no wheel parts found for corner", corner)
        continue
    mins = [world_bbox(c)[0] for c in children]
    maxs = [world_bbox(c)[1] for c in children]
    center = Vector((
        (min(m[0] for m in mins) + max(m[0] for m in maxs)) / 2,
        (min(m[1] for m in mins) + max(m[1] for m in maxs)) / 2,
        (min(m[2] for m in mins) + max(m[2] for m in maxs)) / 2,
    ))
    empty = bpy.data.objects.new(f"Wheel{corner}", None)
    bpy.context.scene.collection.objects.link(empty)
    empty.location = center
    empty.empty_display_size = 0.05
    # CRITICAL: flush the depsgraph so empty.matrix_world reflects the location just assigned.
    # Without this update, matrix_parent_inverse gets computed from a stale IDENTITY matrix and
    # every child ends up displaced by +center (first export: wheels pushed outboard/forward to
    # ~2x their true coordinates, overall car AABB 3.5m wide x 6.6m long).
    bpy.context.view_layer.update()
    for c in children:
        mw = c.matrix_world.copy()
        c.parent = empty
        c.matrix_world = mw  # re-assert world transform; Blender derives the correct local basis
    wheel_report[f"Wheel{corner}"] = {c.name: len(c.data.vertices) for c in children}
    log("Wheel" + corner, "children:", wheel_report[f"Wheel{corner}"])

# ---------------------------------------------------------------------------------------------
# 6. EngineBlock + battery/radiator boxes under the Hood (no engine modeled in the source)
# ---------------------------------------------------------------------------------------------
hood = bpy.data.objects["Hood"]
hmin, hmax = world_bbox(hood)
hood_center_x = (hmin[0] + hmax[0]) / 2
hood_center_y = (hmin[1] + hmax[1]) / 2
hood_size_y = hmax[1] - hmin[1]
hood_bottom_z = hmin[2]


def make_box(name, dims, loc, mat):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc)
    ob = bpy.context.active_object
    ob.name = name
    ob.dimensions = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ob.data.materials.append(mat)
    return ob


mat_engine_metal = bpy.data.materials.new("EngineMetalDark")
mat_engine_metal.use_nodes = True
bsdf = mat_engine_metal.node_tree.nodes.get("Principled BSDF")
if bsdf:
    bsdf.inputs["Base Color"].default_value = (0.07, 0.075, 0.08, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.55
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.55

mat_plastic_dark = bpy.data.materials.new("EnginePlasticDark")
mat_plastic_dark.use_nodes = True
bsdf2 = mat_plastic_dark.node_tree.nodes.get("Principled BSDF")
if bsdf2:
    bsdf2.inputs["Base Color"].default_value = (0.03, 0.03, 0.035, 1.0)
    bsdf2.inputs["Roughness"].default_value = 0.85
    if "Metallic" in bsdf2.inputs:
        bsdf2.inputs["Metallic"].default_value = 0.0

engine_z = hood_bottom_z - 0.28
engine_block = make_box(
    "EngineBlockCore",
    (0.62, 0.55, 0.46),
    (hood_center_x, hood_center_y + 0.10 * hood_size_y, engine_z),
    mat_engine_metal,
)
battery = make_box(
    "EngineBattery",
    (0.26, 0.18, 0.20),
    (hood_center_x + 0.42, hood_center_y + 0.30 * hood_size_y, engine_z + 0.30),
    mat_plastic_dark,
)
radiator = make_box(
    "EngineRadiator",
    (1.05, 0.09, 0.48),
    (hood_center_x, hood_center_y - 0.40 * hood_size_y, engine_z + 0.02),
    mat_plastic_dark,
)
engine_block = join_objects([engine_block, battery, radiator], "EngineBlock")
log("EngineBlock verts:", len(engine_block.data.vertices), "at", tuple(engine_block.location))

# ---------------------------------------------------------------------------------------------
# 7. Glass node normalization (join the "*  Null" backer meshes into their glass counterpart)
# ---------------------------------------------------------------------------------------------
if "Windshield Null" in bpy.data.objects:
    join_into(bpy.data.objects["Windshield Null"], bpy.data.objects["Windshield"])
if "RearWindow Null" in bpy.data.objects:
    join_into(bpy.data.objects["RearWindow Null"], bpy.data.objects["RearWindow"])
if "QuarterPanelGlass Null" in bpy.data.objects and "QuarterpanelGlass" in bpy.data.objects:
    join_into(bpy.data.objects["QuarterPanelGlass Null"], bpy.data.objects["QuarterpanelGlass"])
    bpy.data.objects["QuarterpanelGlass"].name = "QuarterGlass"
if "SunRoofFrame" in bpy.data.objects and "Sunroof" not in bpy.data.objects:
    bpy.data.objects["SunRoof"].name = "Sunroof"

# analyze-car.mjs detects shatter-glass by MATERIAL name. The interior gauge/trinket meshes share
# the exterior "Glass" material in this source file — swap those slots to a renamed copy so only
# real exterior panes (Windshield/RearWindow/QuarterGlass/Sunroof + door glass inside panels) are
# ever glass-classified.
INTERIOR_GLASS_OBJECTS = ["SpeedoGlass", "Shifterknob Crystal", "InfoTainment Screen", "RearviewMirror"]
glass_interior_mat = None
for objname in INTERIOR_GLASS_OBJECTS:
    ob = bpy.data.objects.get(objname)
    if ob is None or ob.type != "MESH":
        continue
    for slot in ob.material_slots:
        if slot.material and slot.material.name == "Glass":
            if glass_interior_mat is None:
                glass_interior_mat = slot.material.copy()
                glass_interior_mat.name = "GlassInterior"
            slot.material = glass_interior_mat
            log("swapped interior Glass ->", glass_interior_mat.name, "on", objname)

# ---------------------------------------------------------------------------------------------
# 8. BodyShell merge (Body Frame + bumpers/fender/grille/underbody/quarter-trim/mirrors)
# ---------------------------------------------------------------------------------------------
partners_sum = sum(per_part_report.get(n, 0) for n in BODYSHELL_MERGE_PARTNERS)
body_floor = max(FLOOR_TARGETS["Body Frame"], 40000 - partners_sum + 2000)
body_frame = bpy.data.objects["Body Frame"]
body_frame_verts = floor_tune_and_apply(body_frame, body_floor)
log("Body Frame pre-merge verts:", body_frame_verts, "(floor target was", body_floor, ", partners_sum",
    partners_sum, ")")
per_part_report["Body Frame"] = body_frame_verts

merge_objs = [body_frame] + [bpy.data.objects[n] for n in BODYSHELL_MERGE_PARTNERS if n in bpy.data.objects]
bodyshell = join_objects(merge_objs, "BodyShell")
bodyshell_verts = len(bodyshell.data.vertices)
log("BodyShell merged verts:", bodyshell_verts, "(target >= 40000, partners_sum was", partners_sum, ")")

# ---------------------------------------------------------------------------------------------
# 9. Ground alignment: shift whole car so lowest point (tire contact patch) sits at Z=0
#    (Blender's glTF exporter converts Z-up -> Y-up automatically, so Z=0 here -> Y=0 in-game.)
# ---------------------------------------------------------------------------------------------
min_z = math.inf
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    lo, _ = world_bbox(o)
    min_z = min(min_z, lo[2])
log("pre-align min world Z:", min_z)

bpy.ops.object.select_all(action="DESELECT")
top_level = [o for o in bpy.data.objects if o.parent is None]
for o in top_level:
    o.select_set(True)
bpy.context.view_layer.objects.active = top_level[0] if top_level else None
bpy.ops.transform.translate(value=(0, 0, -min_z))

min_z_after = math.inf
for o in bpy.data.objects:
    if o.type != "MESH":
        continue
    lo, _ = world_bbox(o)
    min_z_after = min(min_z_after, lo[2])
log("post-align min world Z:", min_z_after)

# ---------------------------------------------------------------------------------------------
# 10. Texture resize + pack
# ---------------------------------------------------------------------------------------------
resized = 0
for img in list(bpy.data.images):
    if img.name == "Render Result" or img.source not in {"FILE", "GENERATED"}:
        continue
    try:
        if not img.has_data:
            img.pixels[:1]
    except Exception as e:
        log("WARN could not load pixels for", img.name, "->", e)
        continue
    w, h = img.size
    if w == 0 or h == 0:
        continue
    lname = img.name.lower()
    is_small = any(k in lname for k in SMALL_PART_KEYWORDS)
    is_datamap = any(k in lname for k in DATAMAP_KEYWORDS)
    if is_small:
        target = TEXTURE_MAX_SMALL_DATAMAP if is_datamap else TEXTURE_MAX_SMALL
    else:
        target = TEXTURE_MAX_BODY_DATAMAP if is_datamap else TEXTURE_MAX_BODY
    maxdim = max(w, h)
    if maxdim > target:
        scale = target / maxdim
        neww, newh = max(1, round(w * scale)), max(1, round(h * scale))
        try:
            img.scale(neww, newh)
            resized += 1
        except Exception as e:
            log("WARN scale failed for", img.name, "->", e)
    try:
        img.pack()
    except Exception as e:
        log("WARN pack failed for", img.name, "->", e)
log("textures resized:", resized, "/", len(bpy.data.images))

# ---------------------------------------------------------------------------------------------
# 11. Cleanup + export
# ---------------------------------------------------------------------------------------------
bpy.ops.object.select_all(action="DESELECT")
try:
    bpy.data.orphans_purge(do_recursive=True)
except Exception:
    pass

bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None

os.makedirs(os.path.dirname(OUT_GLB), exist_ok=True)
bpy.ops.export_scene.gltf(
    filepath=OUT_GLB,
    export_format="GLB",
    use_selection=False,
    export_apply=True,
    export_yup=True,
    export_materials="EXPORT",
    export_image_format="AUTO",
    export_cameras=False,
    export_lights=False,
)

size_bytes = os.path.getsize(OUT_GLB)
log("EXPORTED", OUT_GLB, size_bytes, "bytes", round(size_bytes / 1e6, 2), "MB")

total_verts = sum(len(o.data.vertices) for o in bpy.data.objects if o.type == "MESH")
log("TOTAL SCENE VERTS:", total_verts)

log("--- per-part report (deformation-relevant) ---")
for k in ["Hood", "Trunk", "Bumper Front", "Bumper Rear", "Fender Front", "Body Frame"]:
    if k in per_part_report:
        log(f"  {k}: {per_part_report[k]}")
log(f"  DoorL: {len(doorL.data.vertices)}  DoorR: {len(doorR.data.vertices)}")
log(f"  DoorRL: {len(doorRL.data.vertices)}  DoorRR: {len(doorRR.data.vertices)}")
log(f"  BodyShell (merged): {bodyshell_verts}")
log("--- wheel corners ---")
for k, v in wheel_report.items():
    log(f"  {k}: {v}")

with open(os.path.join(GAME_ROOT, "scripts/.prepare-s90-last-run.log"), "w") as f:
    f.write("\n".join(log_lines))
