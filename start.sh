#!/bin/sh
# 受限环境启动器。
#
# 为什么需要它：
#   1. `node_modules/.bin/electron` 的 shebang 是 `#!/usr/bin/env node`，
#      而在某些环境里（比如被 DSH Desktop 托管时）`node` 本身是个包装脚本，
#      会 export ELECTRON_RUN_AS_NODE=1 —— 这会让 Electron 退化成纯 Node 跑，
#      于是 require('electron') 拿不到 app 对象，启动即崩。
#   2. 被别的沙箱/容器包着时，Chromium 自带的 sandbox 会 `sandbox initialization failed`。
#
# 本脚本绕过 node 包装、直接调用 Electron 二进制，并允许传入 --no-sandbox。
#
#   ./start.sh                                   # 正常启动
#   ./start.sh --no-sandbox                      # 沙箱里启动
#   ./start.sh --entry scripts/preview.js --no-sandbox
set -e

cd "$(dirname "$0")"

if [ ! -f node_modules/electron/path.txt ]; then
  echo "Electron 还没装好。先执行：npm install" >&2
  echo "（下载卡住的话见 README 的「启动不了？先看这几条」）" >&2
  exit 1
fi

ENTRY="."
while [ $# -gt 0 ]; do
  case "$1" in
    --entry) ENTRY="$2"; shift 2 ;;
    *) break ;;
  esac
done

unset ELECTRON_RUN_AS_NODE
BIN="node_modules/electron/dist/$(cat node_modules/electron/path.txt)"

if [ ! -x "$BIN" ]; then
  echo "找不到 Electron 二进制：$BIN" >&2
  exit 1
fi

# 注意顺序：Chromium 只认「app 路径之前」的开关。
# 写成 `Electron . --no-sandbox` 的话，--no-sandbox 会被当成 app 自己的参数，
# Chromium 沙箱照样起不来，进程直接 SIGTRAP 而且一句输出都没有。
exec "$BIN" "$@" "$ENTRY"
