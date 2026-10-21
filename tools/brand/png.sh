#!/bin/sh
# PNG copies of the tab icon, from the SVGs tools/brand/gen.mjs writes.
# Safari ignores SVG tab icons and every phone wants a PNG home-screen icon,
# so these ship beside the SVG. Not part of the build; re-run after changing
# the icon. Needs a headless Chromium (CHROME=..., default: Playwright's).
#   sh tools/brand/png.sh
set -e
CHROME=${CHROME:-$(ls -d /opt/pw-browsers/chromium_headless_shell-*/*/headless_shell 2>/dev/null | head -1)}
DIR=$(cd "$(dirname "$0")/../../public/brand" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
shot() { # svg, size, out
  printf '<style>html,body{margin:0}img{display:block;width:%spx;height:%spx}</style><img src="file://%s/%s">' \
    "$2" "$2" "$DIR" "$1" > "$TMP/page.html"
  "$CHROME" --headless --no-sandbox --hide-scrollbars --allow-file-access-from-files \
    --default-background-color=00000000 --window-size="$2,$2" \
    --screenshot="$DIR/$3" "file://$TMP/page.html" >/dev/null 2>&1
}
shot tab-icon.svg 32 favicon-32.png
shot tab-icon.svg 48 favicon-48.png
shot tab-icon-bleed.svg 180 apple-touch-icon.png
echo "wrote favicon-32.png favicon-48.png apple-touch-icon.png to $DIR"
