#!/bin/sh
# 假 pi：把 piPath 指到这个脚本就能用假模型（见 dev/fakePi.js）
exec node "$(dirname "$0")/fakePi.js" "$@"
