#!/bin/sh
# 重新生成 scripts/fixtures/models 下的多格式模型夹具（需要 Blender 与 assimp）
set -e
cd "$(dirname "$0")"
BLENDER="${BLENDER:-/Applications/Blender.app/Contents/MacOS/Blender}"
"$BLENDER" --background --factory-startup --python gen-models.py -- models
cd models
# assimp 写内嵌贴图时会把相对输出路径和贴图名直接拼接，必须给绝对路径
assimp export rig.glb "$PWD/rig.dae"
# assimp 写 DAE 动画有缺陷（只写首个骨的数据源、时间按毫秒），去掉动画段，只留蒙皮静止姿势
perl -0pi -e 's#<library_animations>.*?</library_animations>\s*##s' rig.dae
assimp export rig-zup.obj "$PWD/rig.3ds"
rm -f rig-zup.obj rig-zup.mtl
assimp export rig.fbx "$PWD/rig-ascii.fbx" -ffbxa
