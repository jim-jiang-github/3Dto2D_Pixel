"""Render a Tripo GLB with a hand-built toon shader: albedo x 3 hard light bands.

No lights, no GI. Light direction is fixed in world space and the camera never
moves, so every facing gets the identical lighting pattern - exactly what a
sprite sheet needs.

Usage: blender -b --factory-startup --python tools/render_toon.py -- <glb> <outdir>
"""
import bpy
import os
import sys
import json
import math

RES = 1344
ORTHO = 1.12
DECIMATE = 0.12
ARM_DOWN = 58.0
LIGHT = (-0.42, -0.62, 0.66)   # world space, from camera upper-left

YAWS = {"S": 270, "SW": 315, "W": 0, "NW": 45, "N": 90, "NE": 135, "E": 180, "SE": 225}

# band positions on the 0..1 dot-product ramp and their brightness
BANDS = [(0.00, 0.52), (0.46, 0.78), (0.68, 1.00)]

# render-time pixelation (the "crunchy 3D" recipe: no AA + posterize in shader).
# With POSTERIZE = N every channel of the final emission is snapped to N steps,
# so the renderer itself outputs palette colours - baked texture gradients
# become hard colour steps and edge pixels never blend with the background.
POSTERIZE = 0


def tail():
    return sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def find_albedo(node, depth=0):
    """Walk upstream from Base Color until we hit something that yields colour."""
    if node is None or depth > 6:
        return None
    if node.type in {"TEX_IMAGE", "VERTEX_COLOR", "RGB"}:
        return node
    for inp in node.inputs:
        for lk in inp.links:
            got = find_albedo(lk.from_node, depth + 1)
            if got:
                return got
    return None


def toonify():
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        img = None
        if bsdf and bsdf.inputs["Base Color"].is_linked:
            src = find_albedo(bsdf.inputs["Base Color"].links[0].from_node)
            if src is not None and src.type == "TEX_IMAGE":
                img = src.image
        nt.nodes.clear()

        out = nt.nodes.new("ShaderNodeOutputMaterial")
        out.location = (900, 0)
        em = nt.nodes.new("ShaderNodeEmission")
        em.location = (700, 0)

        geo = nt.nodes.new("ShaderNodeNewGeometry")
        geo.location = (-800, 200)
        dot = nt.nodes.new("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        dot.location = (-600, 200)
        l = math.sqrt(sum(v * v for v in LIGHT))
        dot.inputs[1].default_value = tuple(v / l for v in LIGHT)

        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.location = (-420, 200)
        mr.inputs["From Min"].default_value = -1.0
        mr.inputs["From Max"].default_value = 1.0
        mr.inputs["To Min"].default_value = 0.0
        mr.inputs["To Max"].default_value = 1.0

        ramp = nt.nodes.new("ShaderNodeValToRGB")
        ramp.location = (-240, 200)
        cr = ramp.color_ramp
        cr.interpolation = "CONSTANT"
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[-1])
        cr.elements[0].position = BANDS[0][0]
        cr.elements[0].color = (BANDS[0][1],) * 3 + (1.0,)
        for pos, val in BANDS[1:]:
            e = cr.elements.new(pos)
            e.color = (val,) * 3 + (1.0,)

        mul = nt.nodes.new("ShaderNodeMixRGB")
        mul.blend_type = "MULTIPLY"
        mul.inputs["Fac"].default_value = 1.0
        mul.location = (200, 0)

        if img is not None:
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img
            tex.location = (-420, -260)
            nt.links.new(tex.outputs["Color"], mul.inputs["Color1"])
        else:
            mul.inputs["Color1"].default_value = (0.72, 0.72, 0.72, 1.0)

        nt.links.new(geo.outputs["Normal"], dot.inputs[0])
        nt.links.new(dot.outputs["Value"], mr.inputs["Value"])
        nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], mul.inputs["Color2"])
        src = mul
        if POSTERIZE > 1:
            sep = nt.nodes.new("ShaderNodeSeparateRGB")
            sep.location = (420, 0)
            nt.links.new(mul.outputs["Color"], sep.inputs["Image"])
            com = nt.nodes.new("ShaderNodeCombineRGB")
            com.location = (600, 0)
            for i, ch in enumerate(("R", "G", "B")):
                m1 = nt.nodes.new("ShaderNodeMath")
                m1.operation = "MULTIPLY"
                m1.inputs[1].default_value = POSTERIZE
                m1.location = (460, -120 - 40 * i)
                rd = nt.nodes.new("ShaderNodeMath")
                rd.operation = "ROUND"
                rd.location = (520, -120 - 40 * i)
                m2 = nt.nodes.new("ShaderNodeMath")
                m2.operation = "DIVIDE"
                m2.inputs[1].default_value = POSTERIZE
                m2.location = (580, -120 - 40 * i)
                nt.links.new(sep.outputs[ch], m1.inputs[0])
                nt.links.new(m1.outputs["Value"], rd.inputs[0])
                nt.links.new(rd.outputs["Value"], m2.inputs[0])
                nt.links.new(m2.outputs["Value"], com.inputs[ch])
            src = com
        out_sock = "Image" if POSTERIZE > 1 else "Color"
        nt.links.new(src.outputs[out_sock], em.inputs["Color"])
        nt.links.new(em.outputs["Emission"], out.inputs["Surface"])


def main():
    a = tail()
    glb, outdir = a[0], a[1]
    global DECIMATE
    head_scale = 1.0
    if len(a) > 2:
        DECIMATE = float(a[2])
    if len(a) > 3:
        head_scale = float(a[3])
    global BANDS
    if len(a) > 4:
        sh = float(a[4])
        BANDS = [(0.00, sh), (0.46, min(1.0, sh + 0.26)), (0.68, 1.00)]
    global POSTERIZE
    if len(a) > 5:
        POSTERIZE = int(a[5])
    global RES
    if len(a) > 7:
        RES = int(a[7])
    os.makedirs(outdir, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb)
    drop = [o for o in bpy.context.scene.objects
            if (o.type == "MESH" and o.name.startswith("Icosphere"))
            or o.type in {"LIGHT", "CAMERA"}]
    for o in drop:
        bpy.data.objects.remove(o, do_unlink=True)

    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            m = o.modifiers.new("d", "DECIMATE")
            m.ratio = DECIMATE
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier=m.name)
            for p in o.data.polygons:
                p.use_smooth = True

    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    arm = arms[0]

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    # arg 6 = TAA samples; posterized mode defaults to 1 (no AA) because
    # anti-aliased edges blend material colour with the transparent background
    scene.eevee.taa_render_samples = int(a[6]) if len(a) > 6 else (1 if POSTERIZE > 1 else 16)
    scene.render.film_transparent = True
    scene.render.resolution_x = RES
    scene.render.resolution_y = RES
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    scene.world = bpy.data.worlds.new("W")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs[1].default_value = 0.0

    cd = bpy.data.cameras.new("Cam")
    cd.type = "ORTHO"
    cd.ortho_scale = ORTHO
    cd.sensor_fit = "VERTICAL"
    cam = bpy.data.objects.new("Cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = (0.0, -10.0, 0.48)
    cam.rotation_euler = (math.radians(90), 0, 0)

    toonify()

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
    for side, sgn in (("L", -1.0), ("R", 1.0)):
        for bn in (side + "_Upperarm", side + "_Forearm"):
            b = arm.pose.bones.get(bn)
            if not b:
                continue
            amt = ARM_DOWN if bn.endswith("Upperarm") else ARM_DOWN * 0.18
            b.rotation_euler = (math.radians(sgn * amt), 0, 0)
    if head_scale != 1.0:
        hb = arm.pose.bones.get("Head")
        if hb:
            hb.scale = (head_scale,) * 3
    bpy.ops.object.mode_set(mode="OBJECT")

    arm.rotation_mode = "XYZ"

    # One framing for the whole turnaround: union of every yaw's bounds, otherwise
    # a wide pose would get clipped on some facings and not others.
    import mathutils
    lo = mathutils.Vector((1e9, 1e9, 1e9))
    hi = mathutils.Vector((-1e9, -1e9, -1e9))
    for yaw in YAWS.values():
        arm.rotation_euler = (0, 0, math.radians(yaw))
        bpy.context.view_layer.update()
        dg = bpy.context.evaluated_depsgraph_get()
        for o in scene.objects:
            if o.type != "MESH":
                continue
            ev = o.evaluated_get(dg)
            # bound_box is the pre-deform box, so a scaled Head bone would push the
            # hat outside the frame; read the deformed vertices instead.
            me = ev.to_mesh()
            mw = ev.matrix_world
            for v in me.vertices:
                w = mw @ v.co
                lo = mathutils.Vector((min(lo[i], w[i]) for i in range(3)))
                hi = mathutils.Vector((max(hi[i], w[i]) for i in range(3)))
            ev.to_mesh_clear()
    cd.ortho_scale = max(hi.x - lo.x, hi.z - lo.z) * 1.10
    cam.location = ((lo.x + hi.x) / 2, -10.0, (lo.z + hi.z) / 2)
    print("FRAME ortho=%.3f c=%.3f,%.3f h=%.3f" % (cd.ortho_scale, cam.location.x,
                                                  cam.location.z, hi.z - lo.z))

    for name, yaw in YAWS.items():
        arm.rotation_euler = (0, 0, math.radians(yaw))
        bpy.context.view_layer.update()
        scene.render.filepath = os.path.join(outdir, name + ".png")
        bpy.ops.render.render(write_still=True)
        print("RENDERED " + name)

    with open(os.path.join(outdir, "render.json"), "w", encoding="utf-8") as f:
        json.dump({"glb": os.path.basename(glb), "res": RES, "ortho": ORTHO,
                   "yaws": YAWS, "bands": BANDS, "light": LIGHT}, f, indent=2)
    print("DONE")


main()
