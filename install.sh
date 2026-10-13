#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only
#
# Installs KOSMIC for the current user, without root.
#
#   ./install.sh              install into ~/.local, enable what was installed
#   ./install.sh --system     install into /usr/local (needs write access there)
#   ./install.sh --no-cpp     skip the three compiled components
#   ./install.sh --uninstall  take it all back out
#
# The compiled half is optional and is skipped with a message when KWin's development headers are
# missing. The KWin script, the two effects and the applet never need them.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=user
WANT_CPP=1
ACTION=install

for arg in "$@"; do
  case "$arg" in
    --system)    MODE=system ;;
    --no-cpp)    WANT_CPP=0 ;;
    --uninstall) ACTION=uninstall ;;
    -h|--help)   sed -n '6,14p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = user ]; then
  PREFIX="$HOME/.local"
  UNIT_DIR="$HOME/.config/systemd/user"
  ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
  KPKG_ARGS=()
else
  PREFIX="/usr/local"
  UNIT_DIR="/usr/local/lib/systemd/user"
  ICON_DIR="/usr/local/share/icons/hicolor/scalable/apps"
  KPKG_ARGS=(--global)
fi

STATE="$SRC/.kosmic-install-state"
BUILD="$SRC/build"

say()  { printf '\033[1m==\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing: $1 -- this needs a Plasma 6 session's own tools" >&2; exit 1; }
}

# kpackagetool6 is how Plasma registers a package rather than merely finding the files, and it is
# the same call the KDE Store makes. The three types are separate because KWin keeps scripts,
# effects and plasmoids in three different places.
PKGS=(
  "KWin/Script:$SRC/comp/script:kosmic-tiling"
  "KWin/Effect:$SRC/comp/effect:kosmic-tiling-anim"
  "KWin/Effect:$SRC/comp/focusdim:kosmic-focusdim"
  "Plasma/Applet:$SRC/applet:io.github.eduresser.kosmic-tiling"
)

kwin_version() { kwin_wayland --version 2>/dev/null | head -1 || echo unknown; }

# ---------------------------------------------------------------- uninstall
if [ "$ACTION" = uninstall ]; then
  need kpackagetool6
  for spec in "${PKGS[@]}"; do
    IFS=: read -r type _ id <<<"$spec"
    kpackagetool6 "${KPKG_ARGS[@]}" --type "$type" --remove "$id" 2>/dev/null \
      && say "removed $id" || warn "$id was not installed"
  done
  systemctl --user disable --now kosmic-stated 2>/dev/null || true
  rm -f "$UNIT_DIR/kosmic-stated.service" "$PREFIX/bin/kosmic-stated"
  rm -f "$PREFIX/lib/kwin/plugins/kosmic-outline.so" \
        "$PREFIX/lib/kwin/plugins/kosmic-chordhold.so" \
        "$PREFIX/lib64/kwin/plugins/kosmic-outline.so" \
        "$PREFIX/lib64/kwin/plugins/kosmic-chordhold.so" 2>/dev/null || true
  for i in kosmic-tiling-symbolic kosmic-tiling-on-symbolic kosmic-tiling-off-symbolic; do
    rm -f "$ICON_DIR/$i.svg"
  done
  for k in kosmic-tilingEnabled kosmic-tiling-animEnabled kosmic-focusdimEnabled \
           kosmic-chordholdEnabled kosmic-outlineEnabled; do
    kwriteconfig6 --file kwinrc --group Plugins --key "$k" --delete 2>/dev/null || true
  done
  qdbus org.kde.KWin /KWin reconfigure 2>/dev/null || true
  rm -f "$STATE"
  say "uninstalled"
  exit 0
fi

# A KWin update since the last run means the two plugins were built against headers that are no
# longer the ones running. KWin's plugin API carries no binary compatibility, and the symptom of
# not rebuilding is a plugin the compositor refuses to load without saying why.
if [ "$ACTION" = install ] && [ -f "$STATE" ]; then
  was="$(sed -n 's/^kwin=//p' "$STATE")"
  now="$(kwin_version)"
  if [ -n "$was" ] && [ "$was" != "$now" ]; then
    warn "KWin changed since the last install:"
    warn "  built against  $was"
    warn "  running now    $now"
    warn "rebuilding the plugins, which is what this run is for"
  fi
fi

# ---------------------------------------------------------------- the packages
need kpackagetool6
need kwriteconfig6

# The generated files are committed, so a clone is already a working package. Regenerating when
# Node happens to be here costs nothing and catches an edit to keybindings.json that was never run
# through the generator.
if command -v node >/dev/null 2>&1; then
  node "$SRC/tools/gen.mjs" >/dev/null
else
  for f in "$SRC/comp/script/contents/code/keymap.mjs" \
           "$SRC/comp/script/contents/config/main.xml"; do
    [ -f "$f" ] || { echo "missing generated file $f and no node to write it" >&2; exit 1; }
  done
fi

for spec in "${PKGS[@]}"; do
  IFS=: read -r type path id <<<"$spec"
  if kpackagetool6 "${KPKG_ARGS[@]}" --type "$type" --show "$id" >/dev/null 2>&1; then
    kpackagetool6 "${KPKG_ARGS[@]}" --type "$type" --upgrade "$path" >/dev/null
    say "upgraded $id"
  else
    kpackagetool6 "${KPKG_ARGS[@]}" --type "$type" --install "$path" >/dev/null
    say "installed $id"
  fi
done

# The applet's icons, a second time, outside the package. The plasmoid's own directory is not on
# the icon theme's search path, so the panel resolves `kosmic-tiling-symbolic` only from here --
# without this the widget shows a blank square.
mkdir -p "$ICON_DIR"
install -m 644 "$SRC"/applet/contents/icons/kosmic-tiling*.svg "$ICON_DIR/"
command -v gtk-update-icon-cache >/dev/null 2>&1 \
  && gtk-update-icon-cache -qtf "$(dirname "$(dirname "$(dirname "$ICON_DIR")")")" 2>/dev/null || true
say "installed 3 icons into $ICON_DIR"

# ---------------------------------------------------------------- the compiled half
BUILT_CPP=0
if [ "$WANT_CPP" = 1 ]; then
  if ! command -v cmake >/dev/null 2>&1; then
    warn "cmake not found -- skipping kosmic-stated, chordhold and outline"
  else
    say "configuring the compiled components"
    rm -rf "$BUILD"
    if cmake -S "$SRC" -B "$BUILD" \
         -DCMAKE_BUILD_TYPE=Release \
         -DCMAKE_INSTALL_PREFIX="$PREFIX" \
         -DKOSMIC_SYSTEMD_USER_UNIT_DIR="$UNIT_DIR" \
         -DINSTALL_PACKAGES=OFF >/dev/null 2>"$BUILD.log"; then
      cmake --build "$BUILD" --parallel >/dev/null
      cmake --install "$BUILD" >/dev/null
      BUILT_CPP=3
      say "built and installed kosmic-stated, chordhold and outline"
    else
      # The usual cause is the one worth naming: KWin installs no development headers on most
      # distributions unless a -dev/-devel package is present, and without them the two plugins
      # cannot be built at all. Everything above this point is already installed and works.
      warn "could not configure the KWin plugins -- see $BUILD.log"
      warn "KOSMIC needs KWin's development headers for chordhold and outline:"
      warn "  Arch/CachyOS/BigLinux  pacman -S extra-cmake-modules kwin"
      warn "  Fedora                 dnf install extra-cmake-modules kwin-devel kf6-kconfig-devel"
      warn "  openSUSE               zypper install extra-cmake-modules kwin6-devel kf6-kconfig-devel"
      warn "  Debian/Ubuntu/Zorin    apt install extra-cmake-modules kwin-dev libkf6config-dev"
      say  "retrying with the session service only"
      rm -rf "$BUILD"
      if cmake -S "$SRC" -B "$BUILD" \
           -DCMAKE_BUILD_TYPE=Release \
           -DCMAKE_INSTALL_PREFIX="$PREFIX" \
           -DKOSMIC_SYSTEMD_USER_UNIT_DIR="$UNIT_DIR" \
           -DINSTALL_PACKAGES=OFF -DBUILD_CHORDHOLD=OFF -DBUILD_OUTLINE=OFF \
           >/dev/null 2>>"$BUILD.log"; then
        cmake --build "$BUILD" --parallel >/dev/null
        cmake --install "$BUILD" >/dev/null
        BUILT_CPP=1
        say "built and installed kosmic-stated"
      else
        warn "could not build kosmic-stated either -- the applet's tiling switch will stay disabled"
      fi
    fi
  fi
fi

# ---------------------------------------------------------------- switching it on
say "enabling"
set_plugin() { kwriteconfig6 --file kwinrc --group Plugins --key "$1" "$2"; }
set_script() { kwriteconfig6 --file kwinrc --group Script-kosmic-tiling --key "$1" "$2"; }

set_plugin kosmic-tilingEnabled true
set_plugin kosmic-tiling-animEnabled true
set_plugin kosmic-focusdimEnabled true
# KWin's own dims by active window where focusdim dims by selection. Running both multiplies the
# two brightness factors and disagrees about what is selected.
set_plugin diminactiveEnabled false
if [ "$BUILT_CPP" = 3 ]; then
  set_plugin kosmic-chordholdEnabled true
  set_plugin kosmic-outlineEnabled true
  # The script reads this to stand its mode toggles down: the plugin has to see Meta+X and Meta+R
  # itself, and a shortcut registered on the same chord matches first.
  set_script ChordHold true
else
  set_plugin kosmic-chordholdEnabled false
  set_plugin kosmic-outlineEnabled false
  set_script ChordHold false
fi

# KWin's own edge tiling takes the drop away from KOSMIC, which has its own answer for where the
# window goes and has been showing it for the whole drag.
kwriteconfig6 --file kwinrc --group Windows --key ElectricBorderMaximize false
kwriteconfig6 --file kwinrc --group Windows --key ElectricBorderTiling false

# The KDE defaults that collide with KOSMIC's keys.
for pair in "Grid View:Grid View" \
            "Window Quick Tile Bottom:Quick Tile Window to the Bottom" \
            "Window Quick Tile Left:Quick Tile Window to the Left" \
            "Window Quick Tile Right:Quick Tile Window to the Right" \
            "Window Quick Tile Top:Quick Tile Window to the Top"; do
  IFS=: read -r key label <<<"$pair"
  kwriteconfig6 --file kglobalshortcutsrc --group kwin --key "$key" "none,none,$label"
done
kwriteconfig6 --file kglobalshortcutsrc --group ksmserver --key "Lock Session" "none,none,Lock Session"

if [ "$BUILT_CPP" != 0 ]; then
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now kosmic-stated 2>/dev/null \
    && say "kosmic-stated running" \
    || warn "could not start kosmic-stated -- the applet's tiling switch will stay disabled"
fi

qdbus org.kde.KWin /KWin reconfigure 2>/dev/null || true

# What the plugins were built against. They link KWin's internal headers, which carry no binary
# compatibility, so a KWin update is a rebuild -- and the symptom of not rebuilding is a plugin the
# compositor silently refuses to load. This is what lets the next run say so.
if [ "$BUILT_CPP" = 3 ]; then
  printf 'kwin=%s\n' "$(kwin_version)" > "$STATE"
elif [ -f "$STATE" ]; then
  rm -f "$STATE"
fi

cat <<EOF

KOSMIC is installed.

  Add the panel widget      right-click the panel, Add Widgets, "KOSMIC Tiling"
  Log out and back in       the script registers its shortcuts a few seconds after KWin starts
  Shortcuts                 System Settings, Shortcuts, search "KOSMIC"

EOF
if [ "$BUILT_CPP" != 3 ]; then
  cat <<EOF
Installed without the two KWin plugins. What that costs:

  Meta+X and Meta+R are toggles rather than holds -- a second press leaves the mode
  No line around the selection; the dimming shows it instead

EOF
fi
