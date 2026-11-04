#!/bin/zsh
# 用本机 Chrome 无头模式把 icon.html / store.html 渲染成插件图标和商店素材。
# 用法：zsh store-assets/design/render.sh
set -e
DESIGN="${0:A:h}"
ROOT="${DESIGN:h:h}"
OUT="$ROOT/store-assets"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

shoot() { # url width height scale output [transparent]
  local bg=()
  [[ -n "$6" ]] && bg=(--default-background-color=00000000)
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --allow-file-access-from-files \
    --user-data-dir="$TMP/profile" --force-device-scale-factor="$4" "${bg[@]}" \
    --window-size="$2,$3" --virtual-time-budget=3000 --screenshot="$5" "$1" >/dev/null 2>&1
}

# 商店要求截图和宣传图是不带透明通道的 PNG：先转 JPEG 去掉 alpha，再转回 PNG
flatten() {
  sips -s format jpeg -s formatOptions 100 "$1" --out "$TMP/flat.jpg" >/dev/null
  sips -s format png "$TMP/flat.jpg" --out "$1" >/dev/null
}

# 图标：128 按规范留 16px 透明边；16/32/48 基本铺满保证小尺寸可读
shoot "file://$DESIGN/icon.html?size=128&pad=16" 128 128 1 "$ROOT/icons/icon128.png" transparent
shoot "file://$DESIGN/icon.html?size=48&pad=2" 48 48 1 "$ROOT/icons/icon48.png" transparent
shoot "file://$DESIGN/icon.html?size=32&pad=1" 32 32 1 "$ROOT/icons/icon32.png" transparent
shoot "file://$DESIGN/icon.html?size=16&pad=0" 16 16 1 "$ROOT/icons/icon16.png" transparent
# 设计稿里用的大图标（不留边）
shoot "file://$DESIGN/icon.html?size=128&pad=0" 128 128 4 "$DESIGN/icon-512.png" transparent

render() { # view width height output
  shoot "file://$DESIGN/store.html?view=$1" "$2" "$3" 1 "$4"
  flatten "$4"
}

render shot1 1280 800 "$OUT/screenshot-1-1280x800.png"
render shot2 1280 800 "$OUT/screenshot-2-1280x800.png"
render shot3 1280 800 "$OUT/screenshot-3-1280x800.png"
render shot4 1280 800 "$OUT/screenshot-4-1280x800.png"
render small 440 280 "$OUT/small-promo-tile-440x280.png"
render marquee 1400 560 "$OUT/marquee-promo-tile-1400x560.png"

echo "done"
