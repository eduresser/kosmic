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
OWN="$SRC/install.d/own.txt"
UNBOUND_LOG="$HOME/.local/state/kosmic-unbound"
WIDGET_ID="io.github.eduresser.kosmic-tiling"

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

# The KDE defaults that collide with KOSMIC's keys. Not derived from keybindings.json because
# they are not KOSMIC's bindings: they are the ones KWin and ksmserver ship, named by the key
# kglobalshortcutsrc stores them under.
#
# The list is this long because a stock Plasma claims most of what COSMIC's keymap wants. Every
# entry here was read out of the `default` field of a real kglobalshortcutsrc and checked against
# install.d/claimed.txt: Meta+arrows is Quick Tile, Meta+Ctrl+arrows is Switch One Desktop,
# Meta+Ctrl+Shift+arrows is Window One Desktop, Meta+Shift+Left/Right is Window to Next Screen,
# and Meta+G is Grid View. Shipping only the first five of these is why a stock KDE Neon had
# working tiling and almost no working chord.
#
# The fourth field is the component's own default chord, and it is load-bearing rather than
# documentation. kglobalshortcutsrc stores `active,default,friendly name`, and kglobalaccel
# compares the stored default against the one the component registers at login: where they differ
# it concludes the default has changed and **resets the shortcut to it**, throwing the `none` away.
# Writing `none,none,…` therefore unbinds a key for exactly one session. Measured on KDE Neon --
# sixteen unbound at install, all sixteen back on Meta+Left and friends after the next login.
CONFLICTING=(
  "kwin:Grid View:Grid View:Meta+G"
  "kwin:Window Quick Tile Bottom:Quick Tile Window to the Bottom:Meta+Down"
  "kwin:Window Quick Tile Left:Quick Tile Window to the Left:Meta+Left"
  "kwin:Window Quick Tile Right:Quick Tile Window to the Right:Meta+Right"
  "kwin:Window Quick Tile Top:Quick Tile Window to the Top:Meta+Up"
  "kwin:Switch One Desktop to the Left:Switch One Desktop to the Left:Meta+Ctrl+Left"
  "kwin:Switch One Desktop to the Right:Switch One Desktop to the Right:Meta+Ctrl+Right"
  "kwin:Switch One Desktop Up:Switch One Desktop Up:Meta+Ctrl+Up"
  "kwin:Switch One Desktop Down:Switch One Desktop Down:Meta+Ctrl+Down"
  "kwin:Window One Desktop to the Left:Window One Desktop to the Left:Meta+Ctrl+Shift+Left"
  "kwin:Window One Desktop to the Right:Window One Desktop to the Right:Meta+Ctrl+Shift+Right"
  "kwin:Window One Desktop Up:Window One Desktop Up:Meta+Ctrl+Shift+Up"
  "kwin:Window One Desktop Down:Window One Desktop Down:Meta+Ctrl+Shift+Down"
  "kwin:Window to Next Screen:Window to Next Screen:Meta+Shift+Right"
  "kwin:Window to Previous Screen:Window to Previous Screen:Meta+Shift+Left"
  "ksmserver:Lock Session:Lock Session:Meta+L"
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

# The commands that get the compiled half building, named rather than run. Installing them needs
# root and a package manager per distribution, which is the one thing this script does not do.
#
# Nothing in KDE would do it either, which is worth knowing before wishing for it: KNewStuff
# unpacks an archive and resolves nothing, and the only dependency field KPackage has --
# X-KPackage-Dependencies -- takes `kns://` URIs naming other Store content, never a distribution
# package. An extension whose dependency is missing does not report it; it fails to load, and the
# whole of the user's evidence is an empty space where it should have been.
#
# The command for *this* distribution where /etc/os-release names one, and all four where it does
# not. Printing four lines and leaving the reader to find their own is a small thing, but it is
# the last thing between somebody and a working install, and it is the step they are least in the
# mood for.
build_deps_cmd() {
  local id="" like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")"
    like="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID_LIKE:-}")"
  fi
  case " $id $like " in
    *" arch "*|*" cachyos "*|*" manjaro "*)
      echo "pacman -S base-devel cmake extra-cmake-modules kwin kconfig" ;;
    *" fedora "*|*" rhel "*)
      echo "dnf install cmake extra-cmake-modules kwin-devel qt6-qtbase-devel kf6-kconfig-devel" ;;
    *" opensuse "*|*" suse "*)
      echo "zypper install cmake extra-cmake-modules kwin6-devel qt6-base-devel kf6-kconfig-devel" ;;
    *" debian "*|*" ubuntu "*|*" neon "*)
      echo "apt install build-essential cmake extra-cmake-modules kwin-dev qt6-base-dev kf6-kconfig-dev" ;;
    *) echo "" ;;
  esac
}

build_deps_hint() {
  local cmd; cmd="$(build_deps_cmd)"
  warn "KOSMIC needs cmake and KWin's development headers for stated, chordhold and outline."
  warn "Installing them needs root, which this script does not take. On this machine:"
  if [ -n "$cmd" ]; then
    warn ""
    warn "  sudo $cmd"
    warn ""
  else
    warn "  Arch/CachyOS/BigLinux  pacman -S base-devel cmake extra-cmake-modules kwin kconfig"
    warn "  Fedora                 dnf install cmake extra-cmake-modules kwin-devel kf6-kconfig-devel"
    warn "  openSUSE               zypper install cmake extra-cmake-modules kwin6-devel kf6-kconfig-devel"
    warn "  Debian/Ubuntu/Neon     apt install build-essential cmake extra-cmake-modules kwin-dev kf6-kconfig-dev"
  fi
  warn "Then run this script again. Everything that does not need them is already installed."
}

# Where the two KWin plugins actually landed, and whether KWin can see them there.
#
# `kcoreaddons_add_plugin(... INSTALL_NAMESPACE "kwin/plugins")` installs under
# KDE_INSTALL_PLUGINDIR, which is `<libdir>/qt6/plugins` -- and <libdir> is `lib` on some
# distributions and `lib/x86_64-linux-gnu` on the Debian family. Guessing it was wrong twice over,
# so it is read out of the install manifest cmake writes, which is exact by construction.
#
# Then the part that matters more: Qt searches QCoreApplication::libraryPaths(), which is the Qt
# installation's own plugin directory plus QT_PLUGIN_PATH, and a prefix under $HOME is in neither.
# A per-user plugin is therefore built, installed, and never loaded -- silently, because KWin
# reports nothing about a plugin it did not find. systemd's environment.d is how a user session
# gets a variable without root, and this already requires a systemd session for kosmic-stated.
PLUGIN_ROOT=""
ENV_D="$HOME/.config/environment.d/10-kosmic.conf"

plugin_dir_from_manifest() {
  local m="$BUILD/install_manifest.txt" line
  PLUGIN_ROOT=""
  [ -f "$m" ] || { warn "cmake wrote no install manifest -- cannot place the plugins"; return 1; }
  line="$(grep -m1 -E '/kwin/plugins/.*\.so$' "$m" 2>/dev/null || true)"
  [ -n "$line" ] || { warn "no KWin plugin in the install manifest"; return 1; }
  # .../qt6/plugins/kwin/plugins/kosmic-chordhold.so -> .../qt6/plugins
  PLUGIN_ROOT="${line%/kwin/plugins/*}"
  say "plugins installed under $PLUGIN_ROOT"
}

# QT_PLUGIN_PATH for the next session. Prepended to whatever is already there rather than
# replacing it, and written as its own file so the uninstall can take exactly this back out.
write_plugin_path() {
  [ -n "$PLUGIN_ROOT" ] || return 1
  mkdir -p "$(dirname "$ENV_D")"
  printf 'QT_PLUGIN_PATH=%s${QT_PLUGIN_PATH:+:$QT_PLUGIN_PATH}\n' "$PLUGIN_ROOT" > "$ENV_D"
  say "wrote $ENV_D so KWin looks in $PLUGIN_ROOT"
}

# Whether KWin has the plugin loaded right now. The only honest answer about whether the gesture
# will work, and the thing ChordHold must follow -- a plugin that is built but unseen is the same
# dead key as a plugin that was never configured.
chordhold_loaded() {
  busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins LoadedPlugins 2>/dev/null \
    | grep -q "kosmic-chordhold"
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


# ---------------------------------------------------------------- live shortcut owners
#
# The table above is KDE's own defaults, and it is not the whole list of what can be in the way:
# Spectacle takes Meta+R and Meta+Shift+S, the emoji picker takes Meta+., System Settings takes
# Meta+I -- all of them under components the table does not name, and different on every distro.
# So the running kglobalaccel is asked who holds each chord KOSMIC claims, and whatever answers
# gets unbound the same way. That is the only version of this that holds on a distribution this
# script has never seen.

# Qt's integer for a chord written the way keybindings.json writes it (Meta+Shift+Left, Meta+F13).
keycode() {
  local rest="$1" code=0 part
  while [ "${rest#*+}" != "$rest" ]; do
    part="${rest%%+*}"; rest="${rest#*+}"
    case "$part" in
      Meta) code=$((code + 0x10000000)) ;; Ctrl) code=$((code + 0x04000000)) ;;
      Alt) code=$((code + 0x08000000)) ;;   Shift) code=$((code + 0x02000000)) ;;
      *) return 1 ;;
    esac
  done
  case "$rest" in
    Left) code=$((code + 0x1000012)) ;; Up) code=$((code + 0x1000013)) ;;
    Right) code=$((code + 0x1000014)) ;; Down) code=$((code + 0x1000015)) ;;
    ,) code=$((code + 0x2c)) ;; .) code=$((code + 0x2e)) ;;
    F[0-9]|F[0-9][0-9]) code=$((code + 0x100002f + ${rest#F})) ;;
    [A-Z0-9]) code=$((code + $(printf '%d' "'$rest"))) ;;
    *) return 1 ;;
  esac
  echo "$code"
}

# The reverse, for the default field of an entry that does not exist yet. Qt spells the comma and
# the period as the characters themselves, and so does kglobalshortcutsrc.
keystring() {
  local code="$1" out="" key
  [ $((code & 0x10000000)) -eq 0 ] || out+="Meta+"
  [ $((code & 0x04000000)) -eq 0 ] || out+="Ctrl+"
  [ $((code & 0x08000000)) -eq 0 ] || out+="Alt+"
  [ $((code & 0x02000000)) -eq 0 ] || out+="Shift+"
  key=$((code & 0x01ffffff))
  case "$key" in
    $((0x1000012))) out+=Left ;; $((0x1000013))) out+=Up ;;
    $((0x1000014))) out+=Right ;; $((0x1000015))) out+=Down ;;
    *)
      if [ "$key" -ge $((0x1000030)) ] && [ "$key" -le $((0x1000052)) ]; then
        out+="F$((key - 0x100002f))"
      elif [ "$key" -ge 33 ] && [ "$key" -le 126 ]; then
        out+="$(printf "\\$(printf '%03o' "$key")")"
      else
        return 1
      fi ;;
  esac
  echo "$out"
}

# One chord, every other action that holds it. Prints `component|action|friendly|default-keys`.
# busctl's text form is the only thing a bare shell can read; its strings escape non-ASCII as \ooo,
# which printf %b turns back into the bytes.
foreign_holders() {
  local code out rest n i d defaults
  code="$(keycode "$1")" || return 0
  out="$(busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
         getGlobalShortcutsByKey i "$code" 2>/dev/null)" || return 0
  rest="${out#a(ssssssaiai) }"; n="${rest%% *}"; rest="${rest#"$n"}"
  local re='^ *"([^"]*)" "([^"]*)" "([^"]*)" "([^"]*)" "([^"]*)" "([^"]*)"'
  for ((i = 0; i < n; i++)); do
    [[ "$rest" =~ $re ]] || return 0
    local action="${BASH_REMATCH[1]}" friendly="${BASH_REMATCH[2]}" comp="${BASH_REMATCH[3]}"
    local compname="${BASH_REMATCH[4]}"
    rest="${rest:${#BASH_REMATCH[0]}}"
    # Two lists of integers follow, each led by its length: the keys held now, then the defaults.
    # Consumed one number at a time, because the next row starts with a quoted string.
    local nums=() want=0 list
    for list in 1 2; do
      [[ "$rest" =~ ^\ *([0-9]+) ]] || return 0
      want="${BASH_REMATCH[1]}"; rest="${rest:${#BASH_REMATCH[0]}}"
      nums=()
      for ((d = 0; d < want; d++)); do
        [[ "$rest" =~ ^\ *([0-9]+) ]] || return 0
        nums+=("${BASH_REMATCH[1]}"); rest="${rest:${#BASH_REMATCH[0]}}"
      done
    done
    defaults=""
    for d in "${nums[@]}"; do
      defaults+="${defaults:+$'\t'}$(keystring "$d")" || { defaults=""; break; }
    done
    case "$action" in Kosmic*) continue ;; esac
    printf '%s|%s|%s|%s|%s\n' "$comp" "$action" "$(printf '%b' "${friendly//\\/\\0}")" \
      "$defaults" "$(printf '%b' "${compname//\\/\\0}")"
  done
}

# Where kglobalshortcutsrc keeps an action. Components that are a .desktop file -- Spectacle, the
# emoji picker, System Settings -- live under [services][<file>.desktop] and hold the bare key
# list; a legacy [<file>.desktop] group written by hand is not read back at login, which left
# Meta+I and Meta+Shift+S held by System Settings and Spectacle after the very next relogin.
# Everything else is [<component>] with the `active,default,name` triple.
rc_read() {
  case "$1" in
    *.desktop) kreadconfig6 --file kglobalshortcutsrc --group services --group "$1" --key "$2" ;;
    *)         kreadconfig6 --file kglobalshortcutsrc --group "$1" --key "$2" ;;
  esac 2>/dev/null || true
}
rc_write() { # component action value
  case "$1" in
    *.desktop) kwriteconfig6 --file kglobalshortcutsrc --group services --group "$1" --key "$2" "$3" ;;
    *)         kwriteconfig6 --file kglobalshortcutsrc --group "$1" --key "$2" "$3" ;;
  esac
}
rc_delete() {
  case "$1" in
    *.desktop) kwriteconfig6 --file kglobalshortcutsrc --group services --group "$1" --key "$2" --delete ;;
    *)         kwriteconfig6 --file kglobalshortcutsrc --group "$1" --key "$2" --delete ;;
  esac 2>/dev/null || true
}

# Unbind whatever else holds a chord KOSMIC claims, and remember what was unbound so that the
# uninstall gives back exactly that.
unbind_foreign() {
  local chord comp action friendly dflt compname current n=0
  command -v busctl >/dev/null 2>&1 || return 0
  busctl --user status org.kde.kglobalaccel >/dev/null 2>&1 || {
    warn "kglobalaccel is not running -- other applications' shortcuts were not checked"; return 0; }
  mkdir -p "$(dirname "$UNBOUND_LOG")"
  while IFS= read -r chord; do
    while IFS='|' read -r comp action friendly dflt compname; do
      [ -n "$action" ] || continue
      case "$comp" in
        *.desktop)
          rc_write "$comp" "$action" none ;;
        *)
          current="$(rc_read "$comp" "$action")"
          if [ -n "$current" ]; then
            rc_write "$comp" "$action" "none,${current#*,}"
          else
            # No default means the chord was somebody's own choice; `none` is then the whole entry.
            rc_write "$comp" "$action" "none,${dflt:-none},$friendly"
          fi ;;
      esac
      # The file is what the next login reads. The running daemon holds its own copy and, left
      # alone, writes it back over the file when it exits -- so it is told too, with no keys.
      busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
        setForeignShortcut "asai" 4 "$comp" "$action" "$compname" "$friendly" 0 >/dev/null 2>&1 || true
      printf '%s|%s\n' "$comp" "$action" >> "$UNBOUND_LOG"
      say "unbound \"$friendly\" ($comp) -- it held $chord"
      n=$((n + 1))
    done < <(foreign_holders "$chord")
  done < <(grep -vE '^\s*(#|$)' "$CLAIMED")
  if [ -f "$UNBOUND_LOG" ]; then sort -u -o "$UNBOUND_LOG" "$UNBOUND_LOG"; fi
}

# A `none` left over in kglobalshortcutsrc on a name KOSMIC owns beats the chord the script
# declares, so the key stays dead. Deleting the entry hands the name back to the script.
reset_dead_own() {
  local name chord current n=0
  [ -f "$OWN" ] || return 0
  while IFS='|' read -r name chord; do
    [ -n "$chord" ] || continue
    current="$(kreadconfig6 --file kglobalshortcutsrc --group kwin --key "$name" 2>/dev/null || true)"
    # Empty counts as dead too: an unparseable sequence is stored with nothing in the active field.
    if [ -n "$current" ] && { [ "${current%%,*}" = none ] || [ -z "${current%%,*}" ]; }; then
      kwriteconfig6 --file kglobalshortcutsrc --group kwin --key "$name" --delete 2>/dev/null || true
      n=$((n + 1))
    fi
  done < <(grep -vE '^\s*(#|$)' "$OWN")
  if [ "$n" -gt 0 ]; then say "gave back $n KOSMIC shortcut(s) that were left unbound"; fi
}

# ---------------------------------------------------------------- the panel widget
#
# Plasma has no file to drop an applet into: the panel's contents live in a config file that
# plasmashell rewrites whenever it likes. Its own scripting interface is the supported way in, and
# it is what `plasma-apply-*` and the layout templates use. With no running plasmashell -- an
# install over SSH, say -- there is nothing to talk to, and the install says so instead.
plasma_script() {
  busctl --user call org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell evaluateScript s "$1" \
    2>/dev/null
}

add_widget() {
  local out
  command -v busctl >/dev/null 2>&1 || return 1
  out="$(plasma_script "
    var found = false, ps = panels();
    for (var i = 0; i < ps.length; i++)
      for (var j = 0; j < ps[i].widgetIds.length; j++)
        if (ps[i].widgetById(ps[i].widgetIds[j]).type == '$WIDGET_ID') found = true;
    if (found) print('present');
    else if (ps.length == 0) print('nopanel');
    else { ps[0].addWidget('$WIDGET_ID'); print('added'); }")" || return 1
  case "$out" in
    *present*) say "panel widget already there" ;;
    *added*)   say "added the KOSMIC Tiling widget to the panel" ;;
    *nopanel*) return 1 ;;
    *)         return 1 ;;
  esac
}

remove_widget() {
  plasma_script "
    var ps = panels();
    for (var i = 0; i < ps.length; i++)
      for (var j = ps[i].widgetIds.length - 1; j >= 0; j--) {
        var w = ps[i].widgetById(ps[i].widgetIds[j]);
        if (w.type == '$WIDGET_ID') w.remove();
      }" >/dev/null || true
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
  remove_widget
  systemctl --user disable --now kosmic-stated 2>/dev/null || true
  rm -f "$UNIT_DIR/kosmic-stated.service" "$PREFIX/bin/kosmic-stated"
  # Found rather than guessed, for the reason the install reads the manifest: the directory is
  # `lib/qt6/plugins` on some distributions and `lib/<triplet>/qt6/plugins` on the Debian family,
  # and the pair of paths that used to be listed here matched neither.
  find "$PREFIX/lib" -type f \
    \( -name kosmic-chordhold.so -o -name kosmic-outline.so \) -delete 2>/dev/null || true
  rm -f "$ENV_D"
  rmdir "$(dirname "$ENV_D")" 2>/dev/null || true
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
    IFS=: read -r component key label dflt <<<"$spec"
    current="$(kreadconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" 2>/dev/null || true)"
    # The active field is what the install set, and the only field it is safe to judge by: the
    # other two are the component's and may have been rewritten by kglobalaccel since.
    if [ -n "$current" ] && [ "${current%%,*}" = none ]; then
      kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" --delete \
        2>/dev/null || true
      say "restored \"$key\" -- it comes back at the next login"
    fi
  done

  # The ones unbound because some other application held a chord KOSMIC claims, under the same
  # rule: only where the active field is still the `none` the install wrote.
  if [ -f "$UNBOUND_LOG" ]; then
    while IFS='|' read -r component key; do
      current="$(rc_read "$component" "$key")"
      if [ -n "$current" ] && [ "${current%%,*}" = none ]; then
        rc_delete "$component" "$key"
      fi
    done < "$UNBOUND_LOG"
    rm -f "$UNBOUND_LOG"
  fi

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
    # The same list the configure failure prints, because this branch costs exactly as much and
    # is the one a fresh machine hits. Nothing in KDE installs a dependency for an extension --
    # KNewStuff unpacks an archive, and the only dependency field KPackage has takes `kns://`
    # URIs naming other Store content, not distribution packages -- so naming the command is the
    # whole of what this can do about it.
    warn "cmake not found -- skipping kosmic-stated, chordhold and outline"
    build_deps_hint
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
      plugin_dir_from_manifest
    else
      # The usual cause is the one worth naming: KWin installs no development headers on most
      # distributions unless a -dev/-devel package is present, and without them the two plugins
      # cannot be built at all. Everything above this point is already installed and works.
      warn "could not configure the KWin plugins -- see $BUILD.log"
      build_deps_hint
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
  # The file has to be where it was put, as well as built. A .so under a prefix KWin does not
  # search is indistinguishable from no .so at all, and claiming the chord for it would hand
  # Meta+X to a plugin that never answers.
  if [ -n "$PLUGIN_ROOT" ] && [ ! -e "$PLUGIN_ROOT/kwin/plugins/kosmic-chordhold.so" ]; then
    warn "kosmic-chordhold.so is not under $PLUGIN_ROOT -- leaving the mode keys as toggles"
  elif [ "$chords" -gt 0 ] && apply_ini "$CHORD_INI"; then
    CHORDHOLD_ON=1
    say "configured kosmic-chordhold with $chords chord(s)"
    write_plugin_path || true
    if ! chordhold_loaded; then
      warn "KWin has not loaded kosmic-chordhold yet -- it looks for plugins on QT_PLUGIN_PATH,"
      warn "which the file just written only reaches at the next login. Until then Meta+X and"
      warn "Meta+R do nothing: the plugin owns them and is not running."
    fi
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

# An absent entry is not an absent shortcut. kglobalshortcutsrc is written lazily -- a name
# appears in it the first time kglobalaccel registers it, which on a fresh user happens after this
# runs -- and until then the component's own default applies. For every name in the list above
# that default is a chord KOSMIC claims, which is the only reason the name is in the list. So
# absent means "unbind it", not "nothing to do": skipping it leaves KWin to register Meta+Left for
# Quick Tile at the next login, and KOSMIC loses the chord it had been given.
#
# Only a key that is *present* and holds something KOSMIC does not claim is left alone. That is
# the case worth protecting -- somebody who moved Lock Session to Meta+Escape has no collision,
# and taking it anyway is a working shortcut gone with nothing on screen to say why.
unbound=0
for spec in "${CONFLICTING[@]}"; do
  IFS=: read -r component key label dflt <<<"$spec"
  current="$(kreadconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" 2>/dev/null || true)"
  active="${current%%,*}"
  # Where the entry exists its default and friendly name are copied across untouched and only the
  # active field becomes `none`. Nothing is invented that way -- not the default, not its spelling,
  # not the order of a tab-separated pair, all of which differ between machines. The table's
  # default is for the entry that is not there yet, which is every one of them on a fresh user.
  if [ -n "$current" ]; then
    replacement="none,${current#*,}"
  else
    replacement="none,$dflt,$label"
  fi
  if [ -z "$current" ] || conflicts "$current"; then
    kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" "$replacement"
    unbound=$((unbound + 1))
  elif [ -n "$active" ] && [ "$active" != none ]; then
    say "left \"$key\" on $active -- KOSMIC does not use that chord"
  fi
done
if [ "$unbound" -gt 0 ]; then
  say "unbound $unbound KDE shortcut(s) whose chords KOSMIC takes"
fi
unbind_foreign
reset_dead_own

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

WIDGET_NOTE='right-click the panel, Add Widgets, "KOSMIC Tiling"'
if add_widget; then WIDGET_NOTE="on the panel"; fi

cat <<EOF

KOSMIC is installed.

  Panel widget              $WIDGET_NOTE
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
