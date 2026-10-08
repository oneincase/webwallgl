# 生成多格式模型导入夹具（verify-editor MI 段用）：
#   Blender --background --factory-startup --python scripts/fixtures/gen-models.py -- scripts/fixtures/models
#   再用 assimp 由 rig.glb 转出 rig.dae / rig.3ds / rig-ascii.fbx（见 scripts/fixtures/gen-models.sh）
# 场景：Z 向上的 8 边圆柱（高 3、7 圈），3 根链式骨按高度分段线性蒙皮，30 帧 loop 动画（中骨绕 X、末骨绕 Z），
# 骨架物体带平移 + 绕 Z 转 30°；贴图 16×16 上红下蓝（检查 UV 朝向）。
import math
import os
import sys

import bmesh
import bpy

out = os.path.abspath(sys.argv[sys.argv.index("--") + 1])
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30
scene.frame_start = 0
scene.frame_end = 30

img = bpy.data.images.new("tex", 16, 16)
px = []
for y in range(16):
    for x in range(16):
        px += [1.0, 0.0, 0.0, 1.0] if y >= 8 else [0.0, 0.0, 1.0, 1.0]
img.pixels = px
img.filepath_raw = os.path.join(out, "tex.png")
img.file_format = "PNG"
img.save()

mat = bpy.data.materials.new("Skin")
mat.use_nodes = True
bsdf = mat.node_tree.nodes["Principled BSDF"]
tn = mat.node_tree.nodes.new("ShaderNodeTexImage")
tn.image = img
mat.node_tree.links.new(tn.outputs["Color"], bsdf.inputs["Base Color"])

SEG, RINGS, H, R = 8, 7, 3.0, 0.3
me = bpy.data.meshes.new("Body")
bm = bmesh.new()
uvl = bm.loops.layers.uv.new("UVMap")
verts = [[bm.verts.new((R * math.cos(2 * math.pi * s / SEG), R * math.sin(2 * math.pi * s / SEG), H * r / (RINGS - 1))) for s in range(SEG)] for r in range(RINGS)]
for r in range(RINGS - 1):
    for s in range(SEG):
        s2 = (s + 1) % SEG
        f = bm.faces.new((verts[r][s], verts[r][s2], verts[r + 1][s2], verts[r + 1][s]))
        for loop, (u, v) in zip(f.loops, ((s, r), (s + 1, r), (s + 1, r + 1), (s, r + 1))):
            loop[uvl].uv = (u / SEG, v / (RINGS - 1))
bm.to_mesh(me)
bm.free()
me.materials.append(mat)
body = bpy.data.objects.new("Body", me)
scene.collection.objects.link(body)

arm = bpy.data.armatures.new("Rig")
rig = bpy.data.objects.new("Rig", arm)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode="EDIT")
prev = None
for i in range(3):
    b = arm.edit_bones.new(f"b{i}")
    b.head = (0, 0, i)
    b.tail = (0, 0, i + 1)
    if prev:
        b.parent = prev
        b.use_connect = True
    prev = b
bpy.ops.object.mode_set(mode="OBJECT")

groups = [body.vertex_groups.new(name=f"b{i}") for i in range(3)]
for v in me.vertices:
    z = v.co.z
    for i in range(3):
        w = max(0.0, 1.0 - abs(z - (i + 0.5)))
        if i == 0 and z < 0.5:
            w = 1.0
        if i == 2 and z > 2.5:
            w = 1.0
        if w > 0:
            groups[i].add([v.index], w, "REPLACE")
body.parent = rig
mod = body.modifiers.new("Armature", "ARMATURE")
mod.object = rig

rig.location = (0.5, 0.25, 0)
rig.rotation_euler = (0, 0, math.radians(30))
act = bpy.data.actions.new("Wave")
rig.animation_data_create()
rig.animation_data.action = act
for pb in rig.pose.bones:
    pb.rotation_mode = "XYZ"
for f, a1, a2 in ((0, 0, 0), (15, 35, 20), (30, 0, 0)):
    scene.frame_set(f)
    rig.pose.bones["b1"].rotation_euler = (math.radians(a1), 0, 0)
    rig.pose.bones["b2"].rotation_euler = (0, 0, math.radians(a2))
    rig.pose.bones["b1"].keyframe_insert("rotation_euler", frame=f)
    rig.pose.bones["b2"].keyframe_insert("rotation_euler", frame=f)
scene.frame_set(0)

p = lambda n: os.path.join(out, n)
bpy.ops.export_scene.gltf(filepath=p("rig.glb"), export_format="GLB", export_animations=True, export_force_sampling=True)
bpy.ops.export_scene.fbx(filepath=p("rig.fbx"), bake_anim=True, add_leaf_bones=False, path_mode="COPY", embed_textures=True, bake_anim_use_nla_strips=False, bake_anim_use_all_actions=False)
bpy.ops.wm.obj_export(filepath=p("rig.obj"), export_materials=True, path_mode="RELATIVE", export_animation=False)
# Z 向上原始坐标，供 assimp 转 3DS（3ds Max 惯例 Z 向上）
bpy.ops.wm.obj_export(filepath=p("rig-zup.obj"), export_materials=True, path_mode="RELATIVE", forward_axis="Y", up_axis="Z")
bpy.ops.wm.stl_export(filepath=p("rig.stl"), ascii_format=False)
bpy.ops.wm.stl_export(filepath=p("rig-ascii.stl"), ascii_format=True)
bpy.ops.wm.ply_export(filepath=p("rig.ply"), ascii_format=False, export_uv=True)
bpy.ops.wm.ply_export(filepath=p("rig-ascii.ply"), ascii_format=True, export_uv=True)
