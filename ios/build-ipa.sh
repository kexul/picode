#!/usr/bin/env bash
#
# 打一个没签名的 iOS 包（.ipa）。
#
#   bash ios/build-ipa.sh
#
# 出来的是 ios/build/PiChat.ipa。只有 macOS 上能跑（要 Xcode 的命令行工具）；
# 没签名的包装不上手机，得先用 AltStore / Sideloadly / Xcode 拿自己的 Apple ID 签一遍
# —— 见 ios/README.md 的「装到 iPhone / iPad 上」。
set -euo pipefail
cd "$(dirname "$0")"

OUT="build"
APP="$OUT/DerivedData/Build/Products/Release-iphoneos/PiChat.app"

# 每一轮从干净的产物目录起：旧的那份还在时 xcodebuild 会认为不用再编，
# 打出来的就是上一轮那个包（改了源码也看不出来）
rm -rf "$OUT/DerivedData" "$OUT/Payload" "$OUT/PiChat.ipa"

xcodebuild \
    -project PiChat.xcodeproj \
    -scheme PiChat \
    -configuration Release \
    -sdk iphoneos \
    -derivedDataPath "$OUT/DerivedData" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY="" \
    build

if [ ! -d "$APP" ]; then
    echo "没找到编出来的 PiChat.app：$APP" >&2
    exit 1
fi

# .ipa 就是「Payload/ 里放着 .app」这一层目录的 zip
mkdir -p "$OUT/Payload"
cp -R "$APP" "$OUT/Payload/"
(cd "$OUT" && /usr/bin/zip -qry PiChat.ipa Payload)
rm -rf "$OUT/Payload"
echo "打好了：$(pwd)/$OUT/PiChat.ipa"
