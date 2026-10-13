#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only
#
# Installs KOSMIC for the current user, without root.
#
#   ./install.sh              install into ~/.local, enable what was installed
#   ./install.sh --no-cpp     skip the three compiled components
#   ./install.sh --uninstall  take it all back out
#
# Per-user by design. Everything it writes lands under $HOME, which is also where the
# configuration belongs: ~/.config/kwinrc is read after any /etc/xdg copy, so a system-wide
# install writing there would be overridden by this one anyway. Packaging for a distribution is
# CMakeLists.txt's job -- it has INSTALL_PACKAGES, the three BUILD_* options and a prefix.
#
# The compiled half is optional and is skipped with a message when KWin's development headers are
# missing. The KWin script, the two effects and the applet never need them.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WANT_CPP=1
ACTION=install

for arg in "$@"; do
  case "$arg" in
    --no-cpp)    WANT_CPP=0 ;;
    --uninstall) ACTION=uninstall ;;
    -h|--help)   sed -n '6,18p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

PREFIX="$HOME/.local"
UNIT_DIR="$HOME/.config/systemd/user"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"

STATE="$SRC/.kosmic-install-state"
BUILD="$SRC/build"
CHORD_INI="$SRC/install.d/chordhold.ini"
SILENCED="$SRC/install.d/silenced.txt"
CLAIMED="$SRC/install.d/claimed.txt"

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

# The KDE defaults that *can* collide with KOSMIC's keys. Not derived from keybindings.json
# because they are not KOSMIC's bindings: they are the ones KWin and ksmserver ship, named here by
# the key kglobalshortcutsrc stores them under. Whether each one actually collides is tested at
# install time against install.d/claimed.txt -- see conflicts().
CONFLICTING=(
  "kwin:Grid View:Grid View"
  "kwin:Window Quick Tile Bottom:Quick Tile Window to the Bottom"
  "kwin:Window Quick Tile Left:Quick Tile Window to the Left"
  "kwin:Window Quick Tile Right:Quick Tile Window to the Right"
  "kwin:Window Quick Tile Top:Quick Tile Window to the Top"
  "ksmserver:Lock Session:Lock Session"
)

kwin_version() { kwin_wayland --version 2>/dev/null | head -1 || echo unknown; }

# Tell KWin to drop the configuration it is holding. busctl first for the reason the applet uses
# it too: it ships with systemd, which this already requires for kosmic-stated, so it is the one
# call that is always there. `qdbus` is not -- on the Debian family it lives in a package of its
# own and is installed as `qdbus6`, so the bare name resolves to nothing on a stock KDE Neon and
# this step would have been skipped in silence, leaving every key written above unread until the
# next login.
reconfigure_kwin() {
  if command -v busctl >/dev/null 2>&1; then
    busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null 2>&1 && return 0
  fi
  for q in qdbus6 qdbus qdbus-qt6 /usr/lib/qt6/bin/qdbus /usr/lib64/qt6/bin/qdbus; do
    if command -v "$q" >/dev/null 2>&1 || [ -x "$q" ]; then
      "$q" org.kde.KWin /KWin reconfigure >/dev/null 2>&1 && return 0
    fi
  done
  warn "could not reach KWin to reconfigure -- the changes land at the next login"
  return 1
}

# Reads a generated kwinrc fragment: `[Group]` headers and `Key=value` lines, comments and blanks
# ignored. `--delete` as the second argument removes each key instead of writing it, which is what
# makes the uninstall exact -- it takes out the keys this file put in and nothing else.
apply_ini() {
  local file="$1" mode="${2:-write}" group="" key value n=0
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      ""|"#"*) continue ;;
      "["*"]")
        group="${line#[}"; group="${group%]}" ;;
      *=*)
        [ -n "$group" ] || continue
        key="${line%%=*}"; value="${line#*=}"
        if [ "$mode" = delete ]; then
          kwriteconfig6 --file kwinrc --group "$group" --key "$key" --delete 2>/dev/null || true
        else
          kwriteconfig6 --file kwinrc --group "$group" --key "$key" "$value"
        fi
        n=$((n + 1)) ;;
    esac
  done < "$file"
  [ "$n" -gt 0 ]
}

# Whether a kglobalshortcutsrc value holds a chord KOSMIC registers. The stored form is
# `active,default,friendly name`, and the active field carries alternates separated by tabs.
#
# Asked rather than assumed, because the collision is with the *chord* and not with the action:
# KDE's Lock Session defaults to Meta+L, which KOSMIC takes for Focus Right -- but on a machine
# where somebody moved Lock Session to Meta+Escape there is nothing in the way, and unbinding it
# regardless is a working shortcut taken away with nothing on screen to say why.
conflicts() {
  local active="${1%%,*}"
  [ -n "$active" ] || return 1
  [ "$active" != none ] || return 1
  [ -f "$CLAIMED" ] || return 1
  printf '%s\n' "$active" | tr '\t' '\n' \
    | grep -Fxqf <(grep -vE '^\s*(#|$)' "$CLAIMED")
}

# The shortcut names that must not hold a key. `$1` is `write` or `delete`; `$2` is 1 when the
# chordhold plugin took the mode chords over, which is the only condition in the file.
apply_silenced() {
  local mode="$1" chordhold="${2:-0}" when component name label act
  [ -f "$SILENCED" ] || return 1
  while IFS='|' read -r when component name label || [ -n "$when" ]; do
    case "$when" in ""|"#"*) continue ;; esac
    [ -n "${label:-}" ] || continue
    act="$mode"
    # A conditional row that does not apply is deleted, not skipped. Skipping assumes the key is
    # unset, and on a machine that has run with the plugin before it is not: kglobalshortcutsrc
    # still holds `none` from that run, and it wins over the sequence the script declares. The
    # mode chord would then be dead with ChordHold off -- the same dead key as building the plugin
    # without configuring it, arrived at from the other side.
    if [ "$when" = chordhold ] && [ "$chordhold" != 1 ]; then act=delete; fi
    if [ "$act" = delete ]; then
      kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$name" --delete \
        2>/dev/null || true
    else
      kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$name" \
        "none,none,$label"
    fi
  done < "$SILENCED"
}

# ---------------------------------------------------------------- uninstall
if [ "$ACTION" = uninstall ]; then
  need kpackagetool6
  need kwriteconfig6
  need kreadconfig6
  for spec in "${PKGS[@]}"; do
    IFS=: read -r type _ id <<<"$spec"
    kpackagetool6 --type "$type" --remove "$id" 2>/dev/null \
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
  apply_ini "$CHORD_INI" delete || true

  # Everything this wrote into kglobalshortcutsrc comes back out, and by deleting the key rather
  # than restoring a value: with no entry, the component's own registered default applies again.
  # Leaving these behind is what the previous version did, and it left a machine with Quick Tile,
  # Grid View and Lock Session silently unbound long after KOSMIC was gone.
  apply_silenced delete || true

  # Only the ones still holding exactly what the install wrote. A value that has changed since is
  # somebody's decision, and deleting it would reset it to KDE's default -- undoing a choice this
  # never made.
  for spec in "${CONFLICTING[@]}"; do
    IFS=: read -r component key label <<<"$spec"
    current="$(kreadconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" 2>/dev/null || true)"
    if [ "$current" = "none,none,$label" ]; then
      kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" --delete \
        2>/dev/null || true
      say "restored \"$key\" -- it comes back at the next login"
    fi
  done

  reconfigure_kwin || true
  rm -f "$STATE"
  say "uninstalled"
  exit 0
fi

# A KWin update since the last run means the two plugins were built against headers that are no
# longer the ones running. KWin's plugin API carries no binary compatibility, and the symptom of
# not rebuilding is a plugin the compositor refuses to load without saying why.
if [ -f "$STATE" ]; then
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
need kreadconfig6

# The generated files are committed, so a clone is already a working package. Regenerating when
# Node happens to be here costs nothing and catches an edit to keybindings.json that was never run
# through the generator.
if command -v node >/dev/null 2>&1; then
  node "$SRC/tools/gen.mjs" >/dev/null
else
  for f in "$SRC/comp/script/contents/code/keymap.mjs" \
           "$SRC/comp/script/contents/config/main.xml" \
           "$CHORD_INI" "$SILENCED"; do
    [ -f "$f" ] || { echo "missing generated file $f and no node to write it" >&2; exit 1; }
  done
fi

# --install first and --upgrade only as the fallback, which is the opposite of the obvious order
# and the only one that works. `--show` answers about every prefix it can see, not about this
# user's: where a distribution package or another install path has already put the package
# system-wide, it reports that copy, and `--upgrade` then tries to uninstall a path it does not
# own and fails the whole run. `--install` is prefix-local -- it writes the user copy, which KWin
# reads in preference to the system one -- and only fails when a user copy is already there,
# which is exactly the case `--upgrade` is for.
for spec in "${PKGS[@]}"; do
  IFS=: read -r type path id <<<"$spec"
  if kpackagetool6 --type "$type" --install "$path" >/dev/null 2>&1; then
    say "installed $id"
  elif kpackagetool6 --type "$type" --upgrade "$path" >/dev/null 2>&1; then
    say "upgraded $id"
  else
    echo "could not install or upgrade $id" >&2
    kpackagetool6 --type "$type" --install "$path" >&2 || true
    exit 1
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
      warn "  Debian/Ubuntu/Neon     apt install extra-cmake-modules kwin-dev libkf6config-dev"
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

# chordhold follows its *configuration*, not the build. The plugin reads the chords it watches out
# of [Plugin-kosmic-chordhold], defaulting to none at all, and `ChordHold true` is what makes the
# script stand its own Meta+X and Meta+R toggles down. Enabling the plugin without writing its
# chords therefore produced neither: no hold, because the plugin was watching nothing, and no
# toggle, because the script had already given the chords up. Both modes became dead keys.
#
# Count is read before anything is written, because it is the one thing that decides this: a
# fragment listing no chords configures a plugin that watches nothing, which is the same dead-key
# state by another route. The file itself is guaranteed to be here -- the generated-file guard
# above refuses to run without it -- so this is about its contents, not its existence.
CHORDHOLD_ON=0
if [ "$BUILT_CPP" = 3 ]; then
  chords="$(sed -n 's/^Count=//p' "$CHORD_INI" 2>/dev/null | head -1)"
  case "${chords:-0}" in
    ''|*[!0-9]*) chords=0 ;;
  esac
  if [ "$chords" -gt 0 ] && apply_ini "$CHORD_INI"; then
    CHORDHOLD_ON=1
    say "configured kosmic-chordhold with $chords chord(s)"
  else
    warn "no chords declared in $CHORD_INI -- leaving the mode keys as toggles"
  fi
fi
if [ "$CHORDHOLD_ON" = 1 ]; then
  set_plugin kosmic-chordholdEnabled true
  set_script ChordHold true
else
  set_plugin kosmic-chordholdEnabled false
  set_script ChordHold false
fi
if [ "$BUILT_CPP" = 3 ]; then set_plugin kosmic-outlineEnabled true
else set_plugin kosmic-outlineEnabled false; fi

# The names that must not hold a key. The script registers its own unpressable placeholders for
# these, which covers a machine whose kglobalshortcutsrc was never written for KOSMIC -- but that
# file wins over a QML default, so a machine that has run this before needs them written here.
apply_silenced write "$CHORDHOLD_ON" || warn "missing $SILENCED -- shortcuts left as they were"

# KWin's own edge tiling takes the drop away from KOSMIC, which has its own answer for where the
# window goes and has been showing it for the whole drag.
kwriteconfig6 --file kwinrc --group Windows --key ElectricBorderMaximize false
kwriteconfig6 --file kwinrc --group Windows --key ElectricBorderTiling false

for spec in "${CONFLICTING[@]}"; do
  IFS=: read -r component key label <<<"$spec"
  current="$(kreadconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" 2>/dev/null || true)"
  if conflicts "$current"; then
    kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" "none,none,$label"
    say "unbound \"$key\" -- it held ${current%%,*}, which KOSMIC registers"
  elif [ -n "${current%%,*}" ] && [ "${current%%,*}" != none ]; then
    say "left \"$key\" on ${current%%,*} -- KOSMIC does not use that chord"
  fi
done

if [ "$BUILT_CPP" != 0 ]; then
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now kosmic-stated 2>/dev/null \
    && say "kosmic-stated running" \
    || warn "could not start kosmic-stated -- the applet's tiling switch will stay disabled"
fi

reconfigure_kwin || true

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
