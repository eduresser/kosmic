#!/usr/bin/env bash
# Installs KOSMIC for the current user, without root.
#
#   ./install.sh              install into ~/.local, enable what was installed
#   ./install.sh --no-cpp     skip the three compiled components
#   ./install.sh --uninstall  take it all back out
#   ./install.sh --rebuild    rebuild the KWin plugins if KWin changed under them (run by systemd)
#
# On NixOS nothing is compiled here: the three compiled parts come from the flake's package, and
# this script only does the per-user half (enable, shortcuts, panel widget) once that is installed.
#
# Per-user by design. Everything it writes lands under $HOME, which is also where the
# configuration belongs: ~/.config/kwinrc is read after any /etc/xdg copy, so a system-wide
# install writing there would be overridden by this one anyway. Packaging for a distribution is
# CMakeLists.txt's job -- it has INSTALL_PACKAGES, the three BUILD_* options and a prefix.
#
# The compiled half is optional and is skipped with a message when KWin's development headers are
# missing. The KWin script, the two effects and the applet never need them. Its three components
# are built separately, so one that cannot be built -- or, for kosmic-outline, one the running KWin
# is too old for -- costs only itself.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WANT_CPP=1
ACTION=install

for arg in "$@"; do
  case "$arg" in
    --no-cpp)    WANT_CPP=0 ;;
    --uninstall) ACTION=uninstall ;;
    --rebuild)   ACTION=rebuild ;;
    -h|--help)   sed -n '6,21p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# NixOS has no shared /usr to install into: the compiled half must come from the flake's package.
NIXOS=0
if [ -e /etc/NIXOS ] || grep -qx 'ID=nixos' /etc/os-release 2>/dev/null; then
  NIXOS=1
  WANT_NIX_PKG="$WANT_CPP"
  WANT_CPP=0
fi

PREFIX="$HOME/.local"
UNIT_DIR="$HOME/.config/systemd/user"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"

STATE="$SRC/.kosmic-install-state"
BUILD="$SRC/build"
CHORD_INI="$SRC/install.d/chordhold.ini"
SILENCED="$SRC/install.d/silenced.txt"
CLAIMED="$SRC/install.d/claimed.txt"
OWN="$SRC/install.d/own.txt"
ASSIGN="$SRC/install.d/assign.txt"
COMMANDS="$SRC/install.d/commands.txt"
CONFLICTING_TXT="$SRC/install.d/conflicting.txt"
OPEN_BIN="$PREFIX/bin/kosmic-open"
APP_DIR="$HOME/.local/share/applications"
UNBOUND_LOG="$HOME/.local/state/kosmic-unbound"
ASSIGNED_LOG="$HOME/.local/state/kosmic-assigned"
WIDGET_ID="io.github.eduresser.kosmic-tiling"

say()  { printf '\033[1m==\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing: $1 -- this needs a Plasma 6 session's own tools" >&2; exit 1; }
}

# kpackagetool6 registers the package with Plasma, as the KDE Store does, rather than just copying.
PKGS=(
  "KWin/Script:$SRC/src/comp/script:kosmic-tiling"
  "KWin/Effect:$SRC/src/comp/effect:kosmic-tiling-anim"
  "KWin/Effect:$SRC/src/comp/focusdim:kosmic-focusdim"
  "Plasma/Applet:$SRC/src/applet:io.github.eduresser.kosmic-tiling"
)

# A file rather than an array because the NixOS module reads it too.
CONFLICTING=()
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ''|'#'*) continue ;; esac
  CONFLICTING+=("$line")
done < "$CONFLICTING_TXT"
[ "${#CONFLICTING[@]}" -gt 0 ] || {
  echo "no entries in $CONFLICTING_TXT -- KDE's colliding defaults would be left bound" >&2
  exit 1
}

kwin_version() { kwin_wayland --version 2>/dev/null | head -1 || echo unknown; }

# busctl, not qdbus: the Debian family ships it as `qdbus6`, so the bare name is missing on Neon.
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

# Named, not run: installing needs root and a per-distro package manager, and KPackage cannot
# declare distribution dependencies, so a missing one just fails to load.
DEPS_ARCH="pacman -S base-devel cmake extra-cmake-modules vulkan-headers kwin qt6-base kconfig"
DEPS_FEDORA="dnf install gcc-c++ make cmake extra-cmake-modules kwin-devel qt6-qtbase-devel kf6-kconfig-devel libepoxy-devel libdrm-devel wayland-devel"
DEPS_SUSE="zypper install gcc-c++ make cmake kf6-extra-cmake-modules kwin6-devel qt6-base-devel qt6-declarative-devel kf6-kconfig-devel kf6-kcoreaddons-devel kf6-kwindowsystem-devel libxkbcommon-devel"
DEPS_DEBIAN="apt install build-essential pkgconf cmake extra-cmake-modules kwin-dev qt6-base-dev libkf6config-dev libxkbcommon-dev libdrm-dev"
DEPS_NEON="apt install build-essential pkgconf cmake extra-cmake-modules kwin-dev qt6-base-dev kf6-kconfig-dev"

build_deps_cmd() {
  local id="" like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")"
    like="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID_LIKE:-}")"
  fi
  case " $id $like " in
    *" arch "*|*" cachyos "*|*" manjaro "*) echo "$DEPS_ARCH" ;;
    *" fedora "*|*" rhel "*)                echo "$DEPS_FEDORA" ;;
    *" opensuse "*|*" suse "*)              echo "$DEPS_SUSE" ;;
    *" neon "*)                             echo "$DEPS_NEON" ;;
    *" debian "*|*" ubuntu "*)              echo "$DEPS_DEBIAN" ;;
    *) echo "" ;;
  esac
}

# Deferred to the last line when a build fails, so it does not scroll away.
DEPS_REPORT=0
build_deps_hint() { DEPS_REPORT=1; }

print_deps_report() {
  [ "$DEPS_REPORT" = 1 ] || return 0
  if [ "${#BUILD_MISSING[@]}" -gt 0 ]; then
    warn "missing to build the compiled components:"
    for t in "${BUILD_MISSING[@]}"; do warn "  - $t"; done
  fi
  local cmd; cmd="$(build_deps_cmd)"
  warn "KOSMIC needs cmake and KWin's development headers for stated, chordhold, outline and swipe."
  warn "Installing them needs root, which this script does not take. On this machine:"
  if [ -n "$cmd" ]; then
    warn ""
    warn "  sudo $cmd"
    warn ""
  else
    warn "  Arch/CachyOS/BigLinux  $DEPS_ARCH"
    warn "  Fedora                 $DEPS_FEDORA"
    warn "  openSUSE               $DEPS_SUSE"
    warn "  Debian/Ubuntu          $DEPS_DEBIAN"
    warn "  KDE Neon               $DEPS_NEON"
  fi
}

# The plugin dir is read from cmake's install manifest (lib vs lib/<triplet> differs by distro).
# A $HOME prefix is not on Qt's plugin path, so without QT_PLUGIN_PATH KWin silently never loads it.
PLUGIN_ROOT=""
ENV_D="$HOME/.config/environment.d/10-kosmic.conf"

plugin_dir_from_manifest() {
  local m="$1/install_manifest.txt" line
  [ -f "$m" ] || { warn "cmake wrote no install manifest -- cannot place the plugins"; return 1; }
  line="$(grep -m1 -E '/kwin/plugins/.*\.so$' "$m" 2>/dev/null || true)"
  [ -n "$line" ] || { warn "no KWin plugin in the install manifest"; return 1; }
  # .../qt6/plugins/kwin/plugins/kosmic-chordhold.so -> .../qt6/plugins
  PLUGIN_ROOT="${line%/kwin/plugins/*}"
  say "plugins installed under $PLUGIN_ROOT"
}

# A file of its own so the uninstall can remove exactly this.
write_plugin_path() {
  [ -n "$PLUGIN_ROOT" ] || return 1
  mkdir -p "$(dirname "$ENV_D")"
  printf 'QT_PLUGIN_PATH=%s${QT_PLUGIN_PATH:+:$QT_PLUGIN_PATH}\n' "$PLUGIN_ROOT" > "$ENV_D"
  say "wrote $ENV_D so KWin looks in $PLUGIN_ROOT"
}

# A built but unseen plugin is the same dead key as an unconfigured one.
chordhold_loaded() {
  busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins LoadedPlugins 2>/dev/null \
    | grep "kosmic-chordhold" >/dev/null
}

# `--delete` as $2 removes each key instead, so the uninstall takes out exactly what was written.
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

# Value form: `active,default,friendly name`, alternates tab-separated. Checked by chord, so a user
# who moved Lock Session off Meta+L keeps it.
conflicts() {
  local active="${1%%,*}"
  [ -n "$active" ] || return 1
  [ "$active" != none ] || return 1
  [ -f "$CLAIMED" ] || return 1
  printf '%s\n' "$active" | tr '\t' '\n' \
    | grep -Fxf <(grep -vE '^\s*(#|$)' "$CLAIMED") >/dev/null
}

# $1: write|delete. $2: 1 when the chordhold plugin took the mode chords over.
apply_silenced() {
  local mode="$1" chordhold="${2:-0}" when component name label act
  [ -f "$SILENCED" ] || return 1
  while IFS='|' read -r when component name label || [ -n "$when" ]; do
    case "$when" in ""|"#"*) continue ;; esac
    [ -n "${label:-}" ] || continue
    act="$mode"
    # Deleted, not skipped: a `none` left from a run with the plugin wins over the script's sequence
    # and would leave the chord dead.
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

# Other apps hold claimed chords too (Spectacle, emoji picker, System Settings; varies by distro),
# so the running kglobalaccel is asked who holds each one.

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
    ,) code=$((code + 0x2c)) ;; .) code=$((code + 0x2e)) ;; /) code=$((code + 0x2f)) ;;
    Esc) code=$((code + 0x1000000)) ;; Tab) code=$((code + 0x1000001)) ;;
    Print) code=$((code + 0x1000009)) ;; Space) code=$((code + 0x20)) ;;
    PgUp) code=$((code + 0x1000016)) ;; PgDown) code=$((code + 0x1000017)) ;;
    Screensaver) code=$((code + 0x10000BA)) ;;
    Backspace) code=$((code + 0x1000003)) ;; Return) code=$((code + 0x1000004)) ;;
    Enter) code=$((code + 0x1000005)) ;; Ins) code=$((code + 0x1000006)) ;;
    Del) code=$((code + 0x1000007)) ;; Home) code=$((code + 0x1000010)) ;; End) code=$((code + 0x1000011)) ;;
    F[0-9]|F[0-9][0-9]) code=$((code + 0x100002f + ${rest#F})) ;;
    ?) code=$((code + $(printf '%d' "'$rest"))) ;;   # a letter, a digit, or the symbol Shift gives one
    *) return 1 ;;
  esac
  echo "$code"
}

# Qt and kglobalshortcutsrc spell comma and period as the characters themselves.
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
    $((0x1000000))) out+=Esc ;; $((0x1000001))) out+=Tab ;; $((0x1000009))) out+=Print ;;
    $((0x1000016))) out+=PgUp ;; $((0x1000017))) out+=PgDown ;; 32) out+=Space ;;
    $((0x10000BA))) out+=Screensaver ;;
    $((0x1000003))) out+=Backspace ;; $((0x1000004))) out+=Return ;; $((0x1000005))) out+=Enter ;;
    $((0x1000006))) out+=Ins ;; $((0x1000007))) out+=Del ;; $((0x1000010))) out+=Home ;;
    $((0x1000011))) out+=End ;;
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

# Parses busctl's `a(ssssssaiai)` text into `component|action|friendly|active|default|component name`
# rows, key lists tab-separated; printf %b decodes its \ooo escapes.
parse_infos() {
  local out="$1" rest n i d
  rest="${out#a(ssssssaiai) }"; n="${rest%% *}"; rest="${rest#"$n"}"
  local re='^ *"([^"]*)" "([^"]*)" "([^"]*)" "([^"]*)" "([^"]*)" "([^"]*)"'
  for ((i = 0; i < n; i++)); do
    [[ "$rest" =~ $re ]] || return 0
    local action="${BASH_REMATCH[1]}" friendly="${BASH_REMATCH[2]}" comp="${BASH_REMATCH[3]}"
    local compname="${BASH_REMATCH[4]}"
    rest="${rest:${#BASH_REMATCH[0]}}"
    # Two length-prefixed integer lists follow (active, then defaults); read number by number.
    local nums=() want=0 list lists=("" "")
    for list in 0 1; do
      [[ "$rest" =~ ^\ *([0-9]+) ]] || return 0
      want="${BASH_REMATCH[1]}"; rest="${rest:${#BASH_REMATCH[0]}}"
      nums=()
      for ((d = 0; d < want; d++)); do
        [[ "$rest" =~ ^\ *([0-9]+) ]] || return 0
        nums+=("${BASH_REMATCH[1]}"); rest="${rest:${#BASH_REMATCH[0]}}"
      done
      for d in "${nums[@]}"; do
        [ "$d" != 0 ] || continue   # key 0 is "no key": an unbound action lists [0] as its default
        # An unnameable key stays as `?` so the list is visibly incomplete.
        lists[$list]+="${lists[$list]:+$'\t'}$(keystring "$d" || echo '?')"
      done
    done
    printf '%s|%s|%s|%s|%s|%s\n' "$comp" "$action" "$(printf '%b' "${friendly//\\/\\0}")" \
      "${lists[0]}" "${lists[1]}" "$(printf '%b' "${compname//\\/\\0}")"
  done
}

# One chord, every other action that holds it. Prints `component|action|friendly|default-keys|
# component name`.
foreign_holders() {
  local code out comp action friendly active dflt compname
  code="$(keycode "$1")" || return 0
  out="$(busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
         getGlobalShortcutsByKey i "$code" 2>/dev/null)" || return 0
  while IFS='|' read -r comp action friendly active dflt compname; do
    [ -n "$action" ] || continue
    case "$action" in Kosmic*) continue ;; esac
    printf '%s|%s|%s|%s|%s\n' "$comp" "$action" "$friendly" "$dflt" "$compname"
  done < <(parse_infos "$out")
}

# .desktop components live under [services][<file>.desktop] with a bare key list; a hand-written
# [<file>.desktop] group is not read back at login. Others use [<component>] with the triple.
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

# Logs what was unbound so the uninstall restores exactly that.
unbind_foreign() {
  local chord comp action friendly dflt compname current n=0
  command -v busctl >/dev/null 2>&1 || return 0
  busctl --user status org.kde.kglobalaccel >/dev/null 2>&1 || {
    warn "kglobalaccel is not running -- other applications' shortcuts were not checked"; return 0; }
  mkdir -p "$(dirname "$UNBOUND_LOG")"
  local ASSIGNED=""
  [ ! -f "$ASSIGN" ] || ASSIGNED="$(grep -vE '^\s*(#|$)' "$ASSIGN")"
  while IFS= read -r chord; do
    while IFS='|' read -r comp action friendly dflt compname; do
      [ -n "$action" ] || continue
      # Never unbind the action this chord is being given to (e.g. Close Window on Alt+F4).
      if grep -Fxq "$comp|$action|$chord" <<<"$ASSIGNED"; then continue; fi
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
      # The running daemon would write its copy back over the file on exit, so it is told too.
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

# KWin actions KDE ships with no key or another one. The default comes from the running
# kglobalaccel: a stored default that differs from the registered one resets the entry at login.
component_infos() {
  local path
  path="$(busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
          getComponent s "$1" 2>/dev/null | awk '{gsub(/"/, "", $2); print $2}')" || return 0
  [ -n "$path" ] || return 0
  parse_infos "$(busctl --user call org.kde.kglobalaccel "$path" org.kde.kglobalaccel.Component \
                 allShortcutInfos 2>/dev/null)"
}

# `active` as integers for setForeignShortcut: `<count> <int>...`.
key_ints() {
  local keys="$1" k n=0 out=""
  while IFS= read -r k; do
    [ -n "$k" ] || continue
    out+=" $(keycode "$k")" || return 1
    n=$((n + 1))
  done < <(printf '%s\n' "$keys" | tr '\t' '\n')
  echo "$n$out"
}

# The daemon flushes its in-memory copy at logout, overwriting the file. $3: tab-separated keys.
live_set() { # component action keys
  local info friendly compname ints
  busctl --user status org.kde.kglobalaccel >/dev/null 2>&1 || return 0
  info="$(component_infos "$1" | awk -F'|' -v a="$2" '$2 == a && !f { print; f = 1 }')"
  [ -n "$info" ] || return 0
  IFS='|' read -r _ _ friendly _ _ compname <<<"$info"
  ints="$(key_ints "$3")" || return 0
  busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
    setForeignShortcut "asai" 4 "$1" "$2" "$compname" "$friendly" $ints >/dev/null 2>&1 || true
}

# An action whose entry was deleted from the file goes back to the keys it registers by default.
live_restore() { # component action
  local info dflt
  info="$(component_infos "$1" | awk -F'|' -v a="$2" '$2 == a && !f { print; f = 1 }')"
  [ -n "$info" ] || return 0
  IFS='|' read -r _ _ _ _ dflt _ <<<"$info"
  live_set "$1" "$2" "$dflt"
}

assign_native() {
  local target comp action chord info friendly active dflt compname merged added n=0
  [ -f "$ASSIGN" ] || return 0
  command -v busctl >/dev/null 2>&1 || return 0
  busctl --user status org.kde.kglobalaccel >/dev/null 2>&1 || {
    warn "kglobalaccel is not running -- chords were not given to KDE's actions"; return 0; }
  mkdir -p "$(dirname "$ASSIGNED_LOG")"
  while IFS= read -r target; do
    comp="${target%%|*}"; action="${target#*|}"
    case "$comp" in *.desktop) continue ;; esac
    info="$(component_infos "$comp" | awk -F'|' -v a="$action" '$2 == a && !f { print; f = 1 }')"
    if [ -z "$info" ]; then
      warn "\"$action\" ($comp) is not registered here -- its chords were left unbound"
      continue
    fi
    IFS='|' read -r _ _ friendly active dflt compname <<<"$info"
    # Rewriting a list this could not read in full would drop the keys it could not name.
    case "$active$dflt" in *\?*)
      warn "\"$action\" holds a key this cannot name -- its chords were left unbound"; continue ;;
    esac
    merged="$active"; added=""
    while IFS='|' read -r c a chord; do
      [ "$c|$a" = "$target" ] || continue
      case $'\t'"$merged"$'\t' in *$'\t'"$chord"$'\t'*) continue ;; esac
      merged="${merged:+$merged$'\t'}$chord"; added+="${added:+ }$chord"
      printf '%s|%s|%s\n' "$comp" "$action" "$chord" >> "$ASSIGNED_LOG"
    done < <(grep -vE '^\s*(#|$)' "$ASSIGN")
    [ -n "$added" ] || continue
    rc_write "$comp" "$action" "$merged,${dflt:-none},$friendly"
    ints="$(key_ints "$merged")" || { warn "could not encode the keys of \"$action\""; continue; }
    busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel \
      setForeignShortcut "asai" 4 "$comp" "$action" "$compname" "$friendly" $ints >/dev/null 2>&1 || true
    n=$((n + 1))
  done < <(grep -vE '^\s*(#|$)' "$ASSIGN" | awk -F'|' '!seen[$1 "|" $2]++ { print $1 "|" $2 }')
  if [ -f "$ASSIGNED_LOG" ]; then sort -u -o "$ASSIGNED_LOG" "$ASSIGNED_LOG"; fi
  if [ "$n" -gt 0 ]; then say "gave KOSMIC's chords to $n KDE action(s)"; fi
}

# A command shortcut is a .desktop flagged X-KDE-GlobalAccel-CommandShortcut plus a `_launch` key
# under [services], as System Settings writes for "Add Command".
install_commands() {
  local id name arg chord comp key
  [ -f "$COMMANDS" ] || return 0
  mkdir -p "$PREFIX/bin" "$APP_DIR"
  install -m 755 "$SRC/install.d/kosmic-open" "$OPEN_BIN"
  while IFS=$'\t' read -r id name arg; do
    case "$id" in ""|"#"*) continue ;; esac
    cat > "$APP_DIR/kosmic-$id.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=KOSMIC: $name
Exec=$OPEN_BIN $arg
NoDisplay=true
X-KDE-GlobalAccel-CommandShortcut=true
EOF
  done < "$COMMANDS"
  command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || true
  local n=0
  while IFS='|' read -r comp key chord; do
    case "$comp" in kosmic-*.desktop) ;; *) continue ;; esac
    rc_write "$comp" "$key" "$chord"
    if busctl --user status org.kde.kglobalaccel >/dev/null 2>&1; then
      id="${comp#kosmic-}"; id="${id%.desktop}"
      name="KOSMIC: $(awk -F'\t' -v i="$id" '$1 == i { print $2 }' "$COMMANDS")"
      busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel doRegister \
        as 4 "$comp" "$key" "$name" "$name" >/dev/null 2>&1 || true
      busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel setShortcut \
        asaiu 4 "$comp" "$key" "$name" "$name" 1 "$(keycode "$chord")" 2 >/dev/null 2>&1 || true
      # setShortcut leaves a key the action already holds in place, so a reinstall that changes a
      # chord would be written back over the file when the session ends. This one always replaces.
      busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel setForeignShortcut \
        asai 4 "$comp" "$key" "$name" "$name" 1 "$(keycode "$chord")" >/dev/null 2>&1 || true
    fi
    n=$((n + 1))
  done < <(grep -vE '^\s*(#|$)' "$ASSIGN")
  if [ "$n" -gt 0 ]; then say "wrote $n command shortcut(s): browser, files, terminal, launcher, screenshot"; fi
}

# Only KOSMIC's own chords come out of an action's keys.
unassign_native() {
  local comp action chord current active rest keep k id
  if [ -f "$COMMANDS" ]; then
    while IFS=$'\t' read -r id _ _; do
      case "$id" in ""|"#"*) continue ;; esac
      kwriteconfig6 --file kglobalshortcutsrc --group services --group "kosmic-$id.desktop" \
        --key _launch --delete 2>/dev/null || true
      busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel unregister ss \
        "kosmic-$id.desktop" _launch >/dev/null 2>&1 || true
      rm -f "$APP_DIR/kosmic-$id.desktop"
    done < "$COMMANDS"
    rm -f "$OPEN_BIN"
    command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 >/dev/null 2>&1 || true
  fi
  # KWin never removes a script's Kosmic* entries from [kwin]; left behind they share chords with KDE.
  local name
  if [ -f "$HOME/.config/kglobalshortcutsrc" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      busctl --user call org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel unregister ss \
        kwin "$name" >/dev/null 2>&1 || true
      kwriteconfig6 --file kglobalshortcutsrc --group kwin --key "$name" --delete 2>/dev/null || true
    done < <(awk '/^\[/ { in_kwin = ($0 == "[kwin]"); next }
                  in_kwin && /^Kosmic[A-Za-z0-9]*=/ { sub(/=.*/, ""); print }' \
             "$HOME/.config/kglobalshortcutsrc")
  fi
  [ -f "$ASSIGNED_LOG" ] || return 0
  # All chords per action in one write: per-chord writes let the daemon save the file in between.
  local target mine
  while IFS= read -r target; do
    comp="${target%%|*}"; action="${target#*|}"
    current="$(rc_read "$comp" "$action")"
    [ -n "$current" ] || continue
    mine="$(awk -F'|' -v t="$target" '$1 "|" $2 == t { print $3 }' "$ASSIGNED_LOG")"
    active="${current%%,*}"; rest="${current#*,}"; keep=""
    while IFS= read -r k; do
      [ -n "$k" ] || continue
      grep -qxF -- "$k" <<<"$mine" || keep+="${keep:+$'\t'}$k"
    done < <(printf '%s\n' "$active" | tr '\t' '\n')
    rc_write "$comp" "$action" "${keep:-none},$rest"
    live_set "$comp" "$action" "$keep"
  done < <(awk -F'|' '!seen[$1 "|" $2]++ { print $1 "|" $2 }' "$ASSIGNED_LOG")
  rm -f "$ASSIGNED_LOG"
}

# Panel contents live in a file plasmashell rewrites; its scripting interface is the supported way in.
plasma_script() {
  busctl --user call org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell evaluateScript s "$1" \
    2>/dev/null
}

# addWidget only appends and a live `widget.index` cannot move it, so AppletOrder is rewritten and
# plasmashell restarted. Only for a widget this run added: an existing one may be placed on purpose.
place_widget() {
  local out
  out="$(plasma_script "
    var p = panels()[0];
    p.currentConfigGroup = ['General'];
    var order = String(p.readConfig('AppletOrder', '')).split(';').filter(function (x) { return x != ''; });
    var mine = '', tray = '';
    for (var i = 0; i < p.widgetIds.length; i++) {
      var w = p.widgetById(p.widgetIds[i]);
      if (w.type == '$WIDGET_ID') mine = String(w.id);
      if (w.type == 'org.kde.plasma.systemtray') tray = String(w.id);
    }
    if (mine == '' || tray == '' || order.indexOf(tray) < 0) print('kept');
    else {
      var at = order.indexOf(mine);
      if (at >= 0) order.splice(at, 1);
      order.splice(order.indexOf(tray), 0, mine);
      p.writeConfig('AppletOrder', order.join(';'));
      print('moved');
    }")" || return 1
  case "$out" in
    *moved*) ;;
    *)       return 0 ;;
  esac
  if systemctl --user restart plasma-plasmashell.service 2>/dev/null; then
    say "put the widget before the system tray (plasmashell restarted)"
  elif command -v kquitapp6 >/dev/null 2>&1 && command -v kstart >/dev/null 2>&1; then
    kquitapp6 plasmashell >/dev/null 2>&1 || true
    kstart plasmashell >/dev/null 2>&1 &
    say "put the widget before the system tray (plasmashell restarted)"
  else
    warn "the widget sits before the system tray from the next login; plasmashell was not restarted"
  fi
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
    else {
      ps[0].addWidget('$WIDGET_ID');
      var now = false;
      for (var k = 0; k < ps[0].widgetIds.length; k++)
        if (ps[0].widgetById(ps[0].widgetIds[k]).type == '$WIDGET_ID') now = true;
      print(now ? 'added' : 'refused');
    }")" || return 1
  case "$out" in
    *present*) say "panel widget already there" ;;
    *added*)   say "added the KOSMIC Tiling widget to the panel"
               # The panel saves its order a moment after a widget arrives; writing it before
               # that is writing something plasmashell then overwrites.
               sleep 2
               place_widget || true ;;
    # addWidget answers nothing when the panel refuses, so "added" is only said after looking.
    *refused*) warn "plasmashell did not add the widget to the panel"; return 1 ;;
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

# Major and minor of the running KWin as one number (6.3.6 -> 603), empty when it cannot be read.
kwin_minor() {
  local v; v="$(kwin_version | grep -Eo '[0-9]+\.[0-9]+' | head -1)"
  [ -n "$v" ] || return 0
  printf '%d%02d' "${v%%.*}" "${v#*.}"
}

# The running KWin has the old plugin mapped. Unlinked rather than written over, it keeps its copy
# until it exits, and the new file gets an inode of its own.
unlink_plugin() {
  find "$PREFIX/lib" "$PREFIX/lib64" -type f -name "kosmic-$1.so" -delete 2>/dev/null || true
}

# build_component NAME: log at $BUILD/NAME.log, outside the build dir so a retry keeps it.
build_component() {
  local name="$1" dir="$BUILD/$1" log="$BUILD/$1.log"
  local stated=OFF chord=OFF outline=OFF swipe=OFF
  case "$name" in
    stated)    stated=ON ;;
    chordhold) chord=ON ;;
    outline)   outline=ON ;;
    swipe)     swipe=ON ;;
  esac
  rm -rf "$dir"
  cmake -S "$SRC" -B "$dir" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX" \
        -DKOSMIC_SYSTEMD_USER_UNIT_DIR="$UNIT_DIR" \
        -DINSTALL_PACKAGES=OFF \
        -DBUILD_STATED="$stated" -DBUILD_CHORDHOLD="$chord" -DBUILD_OUTLINE="$outline" \
        -DBUILD_SWIPE="$swipe" \
        >"$log" 2>&1 \
    && cmake --build "$dir" --parallel >>"$log" 2>&1 \
    && { [ "$name" = stated ] || unlink_plugin "$name"; } \
    && cmake --install "$dir" >>"$log" 2>&1
}

# KWin refuses a plugin whose stamp is not its own, so headers not yet updated mean a refused plugin.
kwin_header_version() {
  local d
  for d in ${KOSMIC_KWIN_INCLUDE:-} /usr/include /usr/local/include "$PREFIX/include"; do
    [ -f "$d/kwin/config-kwin.h" ] || continue
    sed -n 's/^#define KWIN_PLUGIN_VERSION_STRING "\(.*\)"/\1/p' "$d/kwin/config-kwin.h" | head -1
    return 0
  done
}

# KWin and its headers update at different moments, so wait for the package manager and for both to agree.
package_manager_busy() {
  pgrep -x 'zypper|apt|apt-get|dpkg|pacman|dnf|dnf5|yum|rpm' >/dev/null 2>&1
}

update_settled() {
  local hdr
  package_manager_busy && return 1
  hdr="$(kwin_header_version)"
  [ -z "$hdr" ] || [ "$hdr" = "$(kwin_version | grep -Eo '[0-9]+(\.[0-9]+)+' | head -1)" ]
}

notify() {
  busctl --user call org.freedesktop.Notifications /org/freedesktop/Notifications \
    org.freedesktop.Notifications Notify 'susssasa{sv}i' \
    KOSMIC 0 kosmic-tiling-symbolic "$1" "$2" 0 0 -1 >/dev/null 2>&1 || true
}

# Path unit: KWin's binary was replaced. Session start: an update happened while logged out.
REBUILD_UNITS=(kosmic-rebuild.path kosmic-rebuild.service)

write_rebuild_units() {
  local dir="$1" kwin
  kwin="$(readlink -f "$(command -v kwin_wayland 2>/dev/null)" 2>/dev/null)"
  [ -n "$kwin" ] || return 1
  mkdir -p "$dir"
  cat > "$dir/kosmic-rebuild.service" <<UNIT
[Unit]
Description=KOSMIC: rebuild the KWin plugins for the installed KWin
After=graphical-session.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash "$SRC/install.sh" --rebuild
Nice=10

[Install]
WantedBy=graphical-session.target
UNIT
  cat > "$dir/kosmic-rebuild.path" <<UNIT
[Unit]
Description=KOSMIC: watch KWin for an update

[Path]
PathChanged=$kwin
Unit=kosmic-rebuild.service

[Install]
WantedBy=graphical-session.target
UNIT
}

# Only the plugins, and silent when KWin is unchanged.
rebuild_plugins() {
  local was now c tries=0 built=() failed=()
  [ "$NIXOS" = 0 ] || return 0
  was="$(sed -n 's/^kwin=//p' "$STATE" 2>/dev/null)"
  [ -n "$was" ] || return 0
  [ "$was" != "$(kwin_version)" ] || return 0

  until update_settled; do
    tries=$((tries + 1))
    if [ "$tries" -gt 360 ]; then
      warn "KWin is $(kwin_version) but its headers say $(kwin_header_version) -- not rebuilding"
      notify "KOSMIC plugins not rebuilt" \
        "KWin's development headers do not match KWin $(kwin_version). Update them, then run $SRC/install.sh."
      return 1
    fi
    sleep 10
  done
  now="$(kwin_version)"
  [ "$was" != "$now" ] || return 0

  preflight
  if [ "${#BUILD_MISSING[@]}" -gt 0 ]; then
    print_deps_report
    notify "KOSMIC plugins not rebuilt" "Build dependencies are missing. Run $SRC/install.sh to see which."
    return 1
  fi

  say "KWin changed from $was to $now -- rebuilding the plugins"
  BUILD="$SRC/build-rebuild"
  rm -rf "$BUILD"
  mkdir -p "$BUILD"
  for c in chordhold outline swipe; do
    [ -n "$(find "$PREFIX/lib" "$PREFIX/lib64" -type f -name "kosmic-$c.so" 2>/dev/null)" ] || continue
    if build_component "$c"; then
      built+=("kosmic-$c"); say "rebuilt kosmic-$c"
    else
      failed+=("kosmic-$c"); warn "could not rebuild kosmic-$c -- see $BUILD/$c.log"
    fi
  done

  if [ "${#failed[@]}" -gt 0 ]; then
    notify "KOSMIC plugins not rebuilt" "${failed[*]} failed to build for $now. Logs in $BUILD."
    return 1
  fi
  printf 'kwin=%s\n' "$now" > "$STATE"
  [ "${#built[@]}" -eq 0 ] \
    || notify "KOSMIC rebuilt for $now" "Log out and back in to load ${built[*]}."
}

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
  systemctl --user disable --now kosmic-stated "${REBUILD_UNITS[@]}" 2>/dev/null || true
  for u in "${REBUILD_UNITS[@]}"; do rm -f "$UNIT_DIR/$u"; done
  rm -rf "$SRC/build-rebuild"
  rm -f "$UNIT_DIR/kosmic-stated.service" "$PREFIX/bin/kosmic-stated"
  # Read from the manifest: the plugin dir differs between distributions.
  find "$PREFIX/lib" -type f \
    \( -name kosmic-chordhold.so -o -name kosmic-outline.so -o -name kosmic-swipe.so \) -delete 2>/dev/null || true
  rm -f "$ENV_D"
  rmdir "$(dirname "$ENV_D")" 2>/dev/null || true
  for i in kosmic-tiling-symbolic kosmic-tiling-on-symbolic kosmic-tiling-off-symbolic; do
    rm -f "$ICON_DIR/$i.svg"
  done
  for k in kosmic-tilingEnabled kosmic-tiling-animEnabled kosmic-focusdimEnabled \
           kosmic-chordholdEnabled kosmic-outlineEnabled kosmic-swipeEnabled; do
    kwriteconfig6 --file kwinrc --group Plugins --key "$k" --delete 2>/dev/null || true
  done
  apply_ini "$CHORD_INI" delete || true
  if [ "$(kreadconfig6 --file kwinrc --group Effect-slide --key SlideBackground 2>/dev/null)" = false ]; then
    kwriteconfig6 --file kwinrc --group Effect-slide --key SlideBackground --delete 2>/dev/null || true
  fi

  # Deleted rather than restored, so the component's registered default applies again.
  apply_silenced delete || true
  unassign_native

  # Only entries still holding what the install wrote; anything else is the user's choice.
  for spec in "${CONFLICTING[@]}"; do
    IFS=: read -r component key label dflt <<<"$spec"
    current="$(kreadconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" 2>/dev/null || true)"
    # The active field is what the install set, and the only field it is safe to judge by: the
    # other two are the component's and may have been rewritten by kglobalaccel since.
    if [ -n "$current" ] && [ "${current%%,*}" = none ]; then
      kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" --delete \
        2>/dev/null || true
      live_restore "$component" "$key"
      say "restored \"$key\" -- it comes back at the next login"
    fi
  done

  if [ -f "$UNBOUND_LOG" ]; then
    while IFS='|' read -r component key; do
      current="$(rc_read "$component" "$key")"
      if [ -n "$current" ] && [ "${current%%,*}" = none ]; then
        rc_delete "$component" "$key"
        live_restore "$component" "$key"
      fi
    done < "$UNBOUND_LOG"
    rm -f "$UNBOUND_LOG"
  fi

  reconfigure_kwin || true
  rm -f "$STATE"
  say "uninstalled"
  exit 0
fi

# KWin's plugin API has no binary compatibility: after a KWin update old plugins silently fail to load.
if [ -f "$STATE" ] && [ "$ACTION" = install ]; then
  was="$(sed -n 's/^kwin=//p' "$STATE")"
  now="$(kwin_version)"
  if [ -n "$was" ] && [ "$was" != "$now" ]; then
    warn "KWin changed since the last install:"
    warn "  built against  $was"
    warn "  running now    $now"
    warn "rebuilding the plugins, which is what this run is for"
  fi
fi

# All missing dependencies are found before writing and reported together. Build deps are probed
# through cmake's find_package, since install locations differ per distro.
BUILD_MISSING=()
RUNTIME_MISSING=()

# probe_cmake BODY: output kept in PROBE_OUT; a Qt failing on Vulkan names the package only there.
PROBE_OUT=""
probe_cmake() {
  local d rc
  d="$(mktemp -d)" || return 1
  printf 'cmake_minimum_required(VERSION 3.20)\nproject(probe LANGUAGES CXX)\n%s\n' "$1" >"$d/CMakeLists.txt"
  PROBE_OUT="$(cmake -S "$d" -B "$d/b" 2>&1)"; rc=$?
  rm -rf "$d"
  return $rc
}

runtime_deps_cmd() {
  local id="" like=""
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-}")"
    like="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID_LIKE:-}")"
  fi
  case " $id $like " in
    *" arch "*|*" cachyos "*|*" manjaro "*) echo "pacman -S kpackage kconfig systemd" ;;
    # A bare openSUSE image has no awk; a desktop install does, so this only names the one gap.
    *" opensuse "*|*" suse "*) echo "zypper install gawk" ;;
    *) echo "" ;;
  esac
}

preflight() {
  local t cmd
  for t in kpackagetool6 kwriteconfig6 kreadconfig6 busctl awk; do
    command -v "$t" >/dev/null 2>&1 || RUNTIME_MISSING+=("$t")
  done
  if [ "${#RUNTIME_MISSING[@]}" -gt 0 ]; then
    warn "missing tools: ${RUNTIME_MISSING[*]} -- a Plasma 6 session and the base system ship them"
    cmd="$(runtime_deps_cmd)"
    [ -z "$cmd" ] || warn "  sudo $cmd"
  fi

  [ "$WANT_CPP" = 1 ] || return 0

  command -v cmake >/dev/null 2>&1 || BUILD_MISSING+=("cmake")
  command -v make >/dev/null 2>&1 || command -v ninja >/dev/null 2>&1 || BUILD_MISSING+=("make")
  command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1 \
    || command -v clang++ >/dev/null 2>&1 || BUILD_MISSING+=("a C++ compiler")

  # The probes need cmake and a compiler to mean anything; without them they would all fail for
  # that one reason and name packages that are not the cause.
  if [ "${#BUILD_MISSING[@]}" -eq 0 ]; then
    local ecm=1 qt=1
    if ! probe_cmake 'find_package(ECM REQUIRED NO_MODULE)'; then
      BUILD_MISSING+=("extra-cmake-modules"); ecm=0
    fi
    if ! probe_cmake 'find_package(Qt6 CONFIG REQUIRED COMPONENTS Core DBus Gui Widgets)'; then
      qt=0
      case "$PROBE_OUT" in
        *Vulkan*) BUILD_MISSING+=("Vulkan headers (Qt's cmake files ask for them)") ;;
        *)        BUILD_MISSING+=("Qt 6 development files") ;;
      esac
    fi
    # KWin's config pulls in ECM and Qt, so asking it before those are there would report them
    # as KWin's absence.
    if [ "$ecm" = 1 ] && [ "$qt" = 1 ]; then
      if ! probe_cmake 'find_package(ECM REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})
find_package(Qt6 CONFIG REQUIRED COMPONENTS Core DBus Widgets)
find_package(KF6 REQUIRED COMPONENTS Config)
find_package(KWin REQUIRED COMPONENTS kwin)'; then
        BUILD_MISSING+=("KWin and KDE Frameworks development files")
      fi
    fi
  fi

  [ "${#BUILD_MISSING[@]}" -eq 0 ] || DEPS_REPORT=1
}
if [ "$ACTION" = rebuild ]; then
  if rebuild_plugins; then exit 0; else exit 1; fi
fi

preflight
if [ "${#RUNTIME_MISSING[@]}" -gt 0 ] && [ "$ACTION" = install ]; then
  exit 1
fi
# Nothing is written until the build dependencies are here.
if [ "${#BUILD_MISSING[@]}" -gt 0 ] && [ "$ACTION" = install ]; then
  print_deps_report
  warn "Nothing was installed. Run this script again after that, or pass --no-cpp to install without the compiled half."
  exit 1
fi

need kpackagetool6
need kwriteconfig6
need kreadconfig6

# Regenerating when Node is present catches a keybindings.json edit never run through gen.mjs.
if command -v node >/dev/null 2>&1; then
  node "$SRC/tools/gen.mjs" >/dev/null
else
  for f in "$SRC/src/comp/script/contents/code/keymap.mjs" \
           "$SRC/src/comp/script/contents/config/main.xml" \
           "$CHORD_INI" "$SILENCED"; do
    [ -f "$f" ] || { echo "missing generated file $f and no node to write it" >&2; exit 1; }
  done
fi

# --install before --upgrade: `--show` sees system-wide copies, and `--upgrade` then fails removing
# one it does not own; `--install` is prefix-local.
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

# The plasmoid dir is not on the icon search path; without this the widget is a blank square.
mkdir -p "$ICON_DIR"
install -m 644 "$SRC"/src/applet/contents/icons/kosmic-tiling*.svg "$ICON_DIR/"
command -v gtk-update-icon-cache >/dev/null 2>&1 \
  && gtk-update-icon-cache -qtf "$(dirname "$(dirname "$(dirname "$ICON_DIR")")")" 2>/dev/null || true
say "installed 3 icons into $ICON_DIR"

# Built one at a time so one failing component does not take the others down.
HAVE_STATED=0
HAVE_CHORDHOLD=0
HAVE_OUTLINE=0
HAVE_SWIPE=0

if [ "$WANT_CPP" = 1 ]; then
  if [ "${#BUILD_MISSING[@]}" -gt 0 ]; then
    # Reported at the end, with the command. Building anyway would only repeat it as a cmake error.
    warn "skipping kosmic-stated, chordhold, outline and swipe until the build dependencies are installed (listed at the end)"
  else
    say "building the compiled components"
    rm -rf "$BUILD"
    mkdir -p "$BUILD"
    hint_shown=0

    if build_component stated; then
      HAVE_STATED=1
      say "built and installed kosmic-stated"
    else
      warn "could not build kosmic-stated -- see $BUILD/stated.log; the applet's tiling switch will stay disabled"
    fi

    if build_component chordhold; then
      HAVE_CHORDHOLD=1
      say "built and installed kosmic-chordhold"
      plugin_dir_from_manifest "$BUILD/chordhold" || true
    else
      warn "could not build kosmic-chordhold -- see $BUILD/chordhold.log"
      warn "Meta+X and Meta+R stay toggles instead of holds."
      if grep -q 'a11ykeyboardmonitor.h' "$BUILD/chordhold.log" 2>/dev/null; then
        warn "KWin's development headers before 6.5 ship a keyboard_input.h that includes"
        warn "a11ykeyboardmonitor.h and do not install that header. It has to be taken from a"
        warn "KWin 6.4 source tree and put on CXXFLAGS=-I<dir>; the README shows how."
      fi
      build_deps_hint
      hint_shown=1
    fi

    # OutlinedBorderItem exists from KWin 6.5.0; a KWin whose version cannot be read is tried anyway.
    kwin_min="$(kwin_minor)"
    if [ -n "$kwin_min" ] && [ "$kwin_min" -lt 605 ]; then
      say "skipping kosmic-outline: it needs KWin 6.5 or later, this is $(kwin_version)"
    elif build_component outline; then
      HAVE_OUTLINE=1
      say "built and installed kosmic-outline"
      [ -n "$PLUGIN_ROOT" ] || plugin_dir_from_manifest "$BUILD/outline" || true
    else
      warn "could not build kosmic-outline -- see $BUILD/outline.log"
      [ "$hint_shown" = 1 ] || { build_deps_hint; hint_shown=1; }
    fi

    if build_component swipe; then
      HAVE_SWIPE=1
      say "built and installed kosmic-swipe"
      [ -n "$PLUGIN_ROOT" ] || plugin_dir_from_manifest "$BUILD/swipe" || true
    else
      warn "could not build kosmic-swipe -- see $BUILD/swipe.log"
      warn "the touchpad's swipe stops at the first and last workspace instead of making a new one."
      [ "$hint_shown" = 1 ] || build_deps_hint
    fi
  fi
fi

# The flake's package may be in the system, Home Manager or `nix profile` profile.
if [ "$NIXOS" = 1 ] && [ "${WANT_NIX_PKG:-0}" = 1 ]; then
  for root in /run/current-system/sw "/etc/profiles/per-user/$USER" "$HOME/.nix-profile"; do
    [ -x "$root/bin/kosmic-stated" ] && HAVE_STATED=1
    [ -e "$root/lib/qt-6/plugins/kwin/plugins/kosmic-chordhold.so" ] && HAVE_CHORDHOLD=1
    [ -e "$root/lib/qt-6/plugins/kwin/plugins/kosmic-outline.so" ] && HAVE_OUTLINE=1
    [ -e "$root/lib/qt-6/plugins/kwin/plugins/kosmic-swipe.so" ] && HAVE_SWIPE=1
  done
  if [ "$HAVE_STATED" = 1 ] || [ "$HAVE_CHORDHOLD" = 1 ] || [ "$HAVE_OUTLINE" = 1 ] || [ "$HAVE_SWIPE" = 1 ]; then
    say "found KOSMIC's compiled components in the NixOS profile"
  else
    warn "this is NixOS, where the compiled components come from the flake. The module does all"
    warn "of this declaratively and is the better answer here -- what this script writes, a"
    warn "rebuild overwrites. Add it to the system configuration and rebuild:"
    warn ""
    warn "  inputs.kosmic.url = \"github:eduresser/kosmic\";"
    warn "  inputs.kosmic.inputs.nixpkgs.follows = \"nixpkgs\";   # the plugins must match your KWin"
    warn ""
    warn "  imports = [ inputs.kosmic.nixosModules.default ];"
    warn "  programs.kosmic.enable = true;"
    warn ""
    warn "To keep using this script instead, take the package alone:"
    warn ""
    warn "  environment.systemPackages = [ inputs.kosmic.packages.\${pkgs.stdenv.hostPlatform.system}.default ];"
    warn "  systemd.packages           = [ inputs.kosmic.packages.\${pkgs.stdenv.hostPlatform.system}.default ];"
    warn ""
    warn "Everything that does not need them is installed below."
  fi
fi

say "enabling"
set_plugin() { kwriteconfig6 --file kwinrc --group Plugins --key "$1" "$2"; }
set_script() { kwriteconfig6 --file kwinrc --group Script-kosmic-tiling --key "$1" "$2"; }

set_plugin kosmic-tilingEnabled true
set_plugin kosmic-tiling-animEnabled true
set_plugin kosmic-focusdimEnabled true
# KWin's own dims by active window where focusdim dims by selection. Running both multiplies the
# two brightness factors and disagrees about what is selected.
set_plugin diminactiveEnabled false

# ChordHold makes the script drop its Meta+X/Meta+R toggles, so it is only set when the plugin's
# chords are written (Count > 0); otherwise both modes become dead keys.
CHORDHOLD_ON=0
if [ "$HAVE_CHORDHOLD" = 1 ]; then
  chords="$(sed -n 's/^Count=//p' "$CHORD_INI" 2>/dev/null | head -1)"
  case "${chords:-0}" in
    ''|*[!0-9]*) chords=0 ;;
  esac
  # A .so outside KWin's search path never answers, and Meta+X would be dead.
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
# Every built plugin needs the path; the chordhold branch writes it only when configured.
if { [ "$HAVE_OUTLINE" = 1 ] || [ "$HAVE_SWIPE" = 1 ]; } && [ -n "$PLUGIN_ROOT" ]; then write_plugin_path || true; fi
if [ "$HAVE_OUTLINE" = 1 ]; then set_plugin kosmic-outlineEnabled true
else set_plugin kosmic-outlineEnabled false; fi
if [ "$HAVE_SWIPE" = 1 ]; then set_plugin kosmic-swipeEnabled true
else set_plugin kosmic-swipeEnabled false; fi

# kglobalshortcutsrc wins over the script's placeholders on a machine that ran this before.
apply_silenced write "$CHORDHOLD_ON" || warn "missing $SILENCED -- shortcuts left as they were"

# KWin's edge tiling would take the drop away from KOSMIC's own placement.
kwriteconfig6 --file kwinrc --group Windows --key ElectricBorderMaximize false
kwriteconfig6 --file kwinrc --group Windows --key ElectricBorderTiling false

# The slide moves the wallpaper too, making translucent windows briefly lighter.
kwriteconfig6 --file kwinrc --group Effect-slide --key SlideBackground false

# Absent means unbind: kglobalshortcutsrc is written lazily, so the component's default (a claimed
# chord) would apply at next login. Only a present key holding an unclaimed chord is left alone.
unbound=0
for spec in "${CONFLICTING[@]}"; do
  IFS=: read -r component key label dflt <<<"$spec"
  current="$(kreadconfig6 --file kglobalshortcutsrc --group "$component" --key "$key" 2>/dev/null || true)"
  active="${current%%,*}"
  # An existing entry keeps its default and friendly name verbatim (spelling varies per machine);
  # the table's default is only for entries not there yet.
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
assign_native
install_commands

if [ "$HAVE_STATED" = 1 ]; then
  systemctl --user daemon-reload 2>/dev/null || true
  systemctl --user enable --now kosmic-stated 2>/dev/null \
    && say "kosmic-stated running" \
    || warn "could not start kosmic-stated -- the applet's tiling switch will stay disabled"
fi

reconfigure_kwin || true

# Lets the next run detect a KWin update, which needs a rebuild.
if [ "$HAVE_CHORDHOLD" = 1 ] || [ "$HAVE_OUTLINE" = 1 ] || [ "$HAVE_SWIPE" = 1 ]; then
  printf 'kwin=%s\n' "$(kwin_version)" > "$STATE"
  if [ "$NIXOS" = 0 ] && write_rebuild_units "$UNIT_DIR"; then
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable kosmic-rebuild.service 2>/dev/null || true
    systemctl --user enable --now kosmic-rebuild.path 2>/dev/null \
      && say "the plugins rebuild themselves when KWin is updated" \
      || warn "could not start kosmic-rebuild.path -- rerun this script after each KWin update"
  fi
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
if [ "$HAVE_STATED" != 1 ] || [ "$HAVE_CHORDHOLD" != 1 ] || [ "$HAVE_OUTLINE" != 1 ] || [ "$HAVE_SWIPE" != 1 ]; then
  echo "Installed without part of the compiled half. What that costs:"
  echo
  [ "$HAVE_CHORDHOLD" = 1 ] || echo "  kosmic-chordhold   Meta+X and Meta+R are toggles rather than holds -- a second press leaves the mode"
  [ "$HAVE_OUTLINE" = 1 ]   || echo "  kosmic-outline     no line around the selection; the dimming shows it instead"
  [ "$HAVE_SWIPE" = 1 ]     || echo "  kosmic-swipe       the touchpad's swipe stops at the first and last workspace"
  [ "$HAVE_STATED" = 1 ]    || echo "  kosmic-stated      the applet's tiling switch stays disabled"
  echo
fi
print_deps_report
