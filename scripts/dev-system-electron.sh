#!/usr/bin/env bash
# 用系统 Electron 跑，避免下载 ~100MB 的 npm electron 包。
# 可用 ELECTRON_BIN 覆盖。
set -euo pipefail
cd "$(dirname "$0")/.."

find_electron() {
  if [ -n "${ELECTRON_BIN:-}" ]; then echo "$ELECTRON_BIN"; return 0; fi
  # 与 arch/PKGBUILD 的包装脚本保持同一优先级：显式 electron41 → 任意版本化包。
  # 注意 Arch 的版本化包只提供 /usr/lib/electronNN/electron，没有 /usr/bin/electron。
  for f in /usr/lib/electron41/electron /usr/lib/electron4*/electron \
           /usr/lib/electron/electron /usr/bin/electron /opt/electron/electron; do
    if [ -x "$f" ]; then echo "$f"; return 0; fi
  done
  if command -v electron >/dev/null 2>&1; then command -v electron; return 0; fi
  return 1
}

ELECTRON="$(find_electron)" || {
  echo "找不到 Electron。请安装：pacman -S electron41，或设 ELECTRON_BIN=/path/to/electron" >&2
  exit 1
}

# 允许把某个脚本当入口直接跑（例如 probe-capabilities.cjs）。
ENTRY="."
if [ $# -gt 0 ] && case "$1" in *.js|*.cjs|*.mjs) true;; *) false;; esac; then
  ENTRY="$1"; shift
fi

echo "[dev] electron = $ELECTRON  entry = $ENTRY" >&2
exec "$ELECTRON" "$ENTRY" "$@"
