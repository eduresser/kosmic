#!/usr/bin/env bash
# What the installed package must do on a bare system, run inside a container after the package
# manager has installed it. The setup runs as an ordinary user with its own HOME, because that is
# who runs it, and a root run is refused on purpose -- which is checked too.
#
#   tools/check-package.sh root       as root: files in place, and kosmic-setup refuses
#   tools/check-package.sh user       as the user: setup, what it wrote, uninstall, what is left
set -uo pipefail

failed=0
ok()  { printf '   %s\n' "$*"; }
bad() { printf '   FAIL: %s\n' "$*"; failed=1; }

case "${1:-}" in
  root)
    for f in /usr/bin/kosmic-setup /usr/bin/kosmic-open /usr/share/kosmic/install.sh \
             /usr/share/kwin/scripts/kosmic-tiling/metadata.json \
             /usr/share/kwin/effects/kosmic-tiling-anim/metadata.json \
             /usr/share/kwin/effects/kosmic-focusdim/metadata.json \
             /usr/share/plasma/plasmoids/io.github.eduresser.kosmic-tiling/metadata.json \
             /usr/share/icons/hicolor/scalable/apps/kosmic-tiling-symbolic.svg; do
      [ -e "$f" ] && ok "$f" || bad "missing $f"
    done
    for t in kwriteconfig6 kreadconfig6 busctl awk; do
      command -v "$t" >/dev/null 2>&1 && ok "$t resolved by the package's dependencies" || bad "$t not installed"
    done
    kosmic-setup >/dev/null 2>&1 && bad "kosmic-setup ran as root" || ok "kosmic-setup refuses to run as root"
    ;;
  user)
    kosmic-setup >/dev/null 2>&1 && ok "kosmic-setup" || bad "kosmic-setup failed"
    [ "$(kreadconfig6 --file kwinrc --group Plugins --key kosmic-tilingEnabled)" = true ] \
      && ok "script enabled in kwinrc" || bad "kosmic-tilingEnabled not written"
    [ -e "$HOME/.local/share/applications/kosmic-browser.desktop" ] \
      && ok "command shortcuts written" || bad "no command shortcut written"
    grep -q '^Exec=/usr/bin/kosmic-open' "$HOME/.local/share/applications/kosmic-browser.desktop" \
      && ok "shortcuts point at the packaged kosmic-open" || bad "shortcut Exec is not /usr/bin/kosmic-open"
    kosmic-setup --uninstall >/dev/null 2>&1 && ok "kosmic-setup --uninstall" || bad "uninstall failed"
    [ -z "$(kreadconfig6 --file kwinrc --group Plugins --key kosmic-tilingEnabled)" ] \
      && ok "script entry removed from kwinrc" || bad "kosmic-tilingEnabled left behind"
    ls "$HOME"/.local/share/applications/kosmic-*.desktop >/dev/null 2>&1 \
      && bad "command shortcuts left behind" || ok "command shortcuts removed"
    [ -e /usr/bin/kosmic-open ] && ok "the package's own files untouched" || bad "uninstall removed a package file"
    ;;
  *) echo "usage: tools/check-package.sh root|user" >&2; exit 2 ;;
esac
exit "$failed"
