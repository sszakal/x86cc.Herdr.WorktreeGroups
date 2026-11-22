#!/bin/sh
# Copies the mods and layout into your Herdr home. Run only when you want them live.
set -e
H="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
D="$(cd "$(dirname "$0")" && pwd)"
for m in worktree-group spaces-wg tabs-wg new-menu-wg; do
  mkdir -p "$H/mods/$m"; cp "$D/mods/$m/"* "$H/mods/$m/"
  herdr-app check "$H/mods/$m"
done
[ "$1" = "--layout" ] && cp "$D/layouts/main-wg.json" "$H/layouts/"
echo "Installed. Switch with: herdr-app do layout.switch '{\"name\":\"main-wg\"}'"
