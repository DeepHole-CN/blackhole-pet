#!/bin/sh
# 一条命令产出可分发的 macOS 安装包（universal：Intel + Apple 芯片都能跑）。
#
#   ./scripts/build-mac.sh
#   # → dist/黑洞宠物-<版本>-mac-universal.dmg    双击挂载，拖进 Applications
#   # → dist/黑洞宠物-<版本>-mac-universal.zip    解压后拖进 Applications
#
# 为什么要绕过 electron-builder 自带的 dmg/zip target：
#   electron-builder 是在**签名之前**就打包 dmg/zip 的，而它默认不做签名
#   （没有 Apple 开发者证书）。结果是安装包里的 app 只有链接器级别的
#   ad-hoc 签名（Identifier=Electron、Info.plist 未绑定、资源未封存），
#   macOS 直接拒绝启动。所以流程必须是：先出未签名的 .app → 重新签名 → 再打包。
set -e
cd "$(dirname "$0")/.."

NODE="${NODE:-/opt/homebrew/bin/node}"
command -v "$NODE" >/dev/null 2>&1 || NODE=node

# 缓存都留在项目里：有些环境不允许写 ~/Library/Caches
export ELECTRON_BUILDER_CACHE="$PWD/.builder-cache"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://cdn.npmmirror.com/binaries/electron/}"
export CSC_IDENTITY_AUTO_DISCOVERY=false

VERSION=$("$NODE" -p "require('./package.json').version")
NAME="黑洞宠物-${VERSION}-mac-universal"
APP="dist/mac-universal/黑洞宠物.app"

echo "==> 1/5 打包 universal .app（此时未签名）"
"$NODE" ./node_modules/.bin/electron-builder --mac --dir

echo "==> 2/5 ad-hoc 签名"
[ -d "$APP" ] || { echo "找不到 $APP"; exit 1; }
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "    签名 OK：$(codesign -dv "$APP" 2>&1 | grep Identifier)"

echo "==> 3/5 生成 zip"
rm -f dist/*.zip
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist/${NAME}.zip"

echo "==> 4/5 生成 dmg"
rm -rf dist/dmg-stage
mkdir -p dist/dmg-stage
cp -R "$APP" dist/dmg-stage/
cp build/安装说明.txt dist/dmg-stage/
ln -sfn /Applications dist/dmg-stage/Applications
rm -f "dist/${NAME}.dmg"
hdiutil create -volname "黑洞宠物" -srcfolder dist/dmg-stage -ov -format UDZO "dist/${NAME}.dmg"
rm -rf dist/dmg-stage

echo "==> 5/5 完成"
ls -lh dist/*.dmg dist/*.zip
cat <<'TIP'

把 dmg 或 zip 拷到另一台 Mac 上即可安装。
注意：app 没有 Apple 开发者签名，第一次打开会被系统拦住 ——
在「应用程序」里 Control+点击 →「打开」，或执行：
  xattr -dr com.apple.quarantine "/Applications/黑洞宠物.app"
TIP
