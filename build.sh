#!/usr/bin/env bash
# pichat 后端的一键构建 + 安装（Linux / macOS 用；Windows 用 build.bat）。
#
# 只做「在这台机器上跑后端」这一件事：装依赖、编译、把 pichat 命令装成全局的。
# 不打包 vsix —— 那是给编辑器装插件用的，跟后端无关；要在 Linux 上装插件的话，
# 见 README 里那两条 code / codium --install-extension。
#
#   ./build.sh                 装依赖 + 编译 + 装全局 pichat
#   ./build.sh --skip-install  跳过 npm install（依赖已经装过）
#
# 编完就能敲 pichat 起后端；已经在跑的后端要重启一次才会用上新编的代码。
set -euo pipefail

cd "$(dirname "$0")"

SKIP_INSTALL=0
for arg in "$@"; do
    case "$arg" in
        --skip-install) SKIP_INSTALL=1 ;;
        -h|--help)
            sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo "[err] 不认识的参数：$arg（只认 --skip-install）" >&2
            exit 1
            ;;
    esac
done

# ---- 前置检查 ----
for cmd in node npm; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "[err] 没装 $cmd。先装 Node.js 20 以上（https://nodejs.org 或系统的包管理器）。" >&2
        exit 1
    fi
done

echo "[build] node $(node -v)，npm $(npm -v)"

# ---- 依赖 ----
if [ "$SKIP_INSTALL" = "1" ]; then
    echo "[build] 跳过 npm install"
else
    echo "[build] 装依赖..."
    npm install
fi

# ---- 编译（顺带过一遍类型检查；非 Windows 上自动跳过桌面截图那支小程序） ----
echo
echo "[build] 编译..."
npm run build

# ---- 把 pichat 装成全局命令 ----
# npm 的全局目录可能是 root 管的（系统包管理器装的 node 常这样），
# 让它自己报 EACCES 比我们猜要准确，所以不在这儿判断，失败了给一句人话。
echo
echo "[build] 装全局 pichat 命令..."
if ! npm i -g .; then
    echo "" >&2
    echo "[err] 全局安装失败。多半是 npm 的全局目录没有写权限，两个办法：" >&2
    echo "      1. 用 root 装一次：sudo npm i -g ." >&2
    echo "      2. 把 npm 全局目录改到自己家目录下（不用 sudo 也能装）：" >&2
    echo "         npm config set prefix ~/.npm-global" >&2
    echo "         然后确保 PATH 里有 ~/.npm-global/bin" >&2
    exit 1
fi

echo
echo "[build] 打一个单文件可执行（dist/pichat，自带界面文件，借本机的 Node）..."
node scripts/build-exe.mjs

echo
echo "[build] === 好了 ==="
echo "  起后端：pichat --cwd ~/你的项目目录"
echo "  或者直接跑那个单文件：./dist/pichat            （双击也行，会自动打开浏览器）"
echo "  已经在跑的后端要重启一次才会用上新编的代码。"
