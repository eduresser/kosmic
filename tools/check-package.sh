#!/usr/bin/env bash
# What the installed package must do on a bare system, run inside a container after the package
# manager has installed it. The setup runs as an ordinary user with its own HOME, because that is
# who runs it, and a root run is refused on purpose -- which is checked too.
#
#   tools/check-package.sh root       as root: files in place, and kosmic-setup refuses
#   tools/check-package.sh user       as the user: setup, what it wrote, uninstall, what is left
#   tools/check-package.sh removed    as root, after the package is removed: nothing it built is left
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
    any_file() { local f; for f in "$@"; do [ -e "$f" ] && return 0; done; return 1; }
    for p in chordhold outline swipe; do
      any_file /usr/lib/qt6/plugins/kwin/plugins/kosmic-$p.so /usr/lib64/qt6/plugins/kwin/plugins/kosmic-$p.so \
               /usr/lib/*/qt6/plugins/kwin/plugins/kosmic-$p.so \
        && ok "kosmic-$p plugin installed" || bad "kosmic-$p plugin missing"
    done
    [ -x /usr/bin/kosmic-stated ] && ok "kosmic-stated installed" || bad "missing /usr/bin/kosmic-stated"
    any_file /usr/lib/systemd/user/kosmic-stated.service /usr/lib64/systemd/user/kosmic-stated.service \
      && ok "kosmic-stated unit installed" || bad "kosmic-stated unit missing"
    [ -x /usr/bin/kosmic-rebuild ] && ok "kosmic-rebuild installed" || bad "missing /usr/bin/kosmic-rebuild"
    [ -s /var/lib/kosmic/manifest ] && ok "the postinstall built the compiled components ($(wc -l < /var/lib/kosmic/manifest) files)" \
      || bad "no build manifest: the postinstall did not compile the components"
    for t in kwriteconfig6 kreadconfig6 busctl awk; do
      command -v "$t" >/dev/null 2>&1 && ok "$t resolved by the package's dependencies" || bad "$t not installed"
    done
    kosmic-setup >/dev/null 2>&1 && bad "kosmic-setup ran as root" || ok "kosmic-setup refuses to run as root"
    ;;
  removed)
    left="$(ls /usr/bin/kosmic-stated /usr/lib/systemd/user/kosmic-stated.service /usr/lib/qt6/plugins/kwin/plugins/kosmic-*.so \
            /usr/lib64/qt6/plugins/kwin/plugins/kosmic-*.so /usr/lib/*/qt6/plugins/kwin/plugins/kosmic-*.so /var/lib/kosmic 2>/dev/null)"
    [ -z "$left" ] && ok "removing the package removed what it built" || bad "left behind: $left"
    ;;
  user)
    out="$(kosmic-setup 2>&1)" && ok "kosmic-setup" || bad "kosmic-setup failed"
    printf '%s' "$out" | grep -q "Installed without part of the compiled half" \
      && bad "kosmic-setup reports compiled components missing" || ok "kosmic-setup sees every compiled component"
    for p in chordhold outline swipe; do
      [ "$(kreadconfig6 --file kwinrc --group Plugins --key kosmic-${p}Enabled)" = true ] \
        && ok "kosmic-$p enabled in kwinrc" || bad "kosmic-${p}Enabled not written"
    done
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
  *) echo "usage: tools/check-package.sh root|user|removed" >&2; exit 2 ;;
esac
exit "$failed"
