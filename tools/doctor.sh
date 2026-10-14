#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only
#
# What KOSMIC looks like on this machine, in one paste.
#
#   tools/doctor.sh
#
# Reads only. Everything it prints is something that has already been the cause of a bug report:
# which copy of each package is loaded, whether the compiled half is there, what kglobalaccel
# actually holds for each chord, and what the session said about it all. Run it after install.sh
# and after the next login -- the two answers differ, and the difference is usually the answer.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
row() { printf '  %-34s %s\n' "$1" "${2:-}"; }
have() { command -v "$1" >/dev/null 2>&1 && command -v "$1" || echo "ABSENT"; }

hdr "session"
row "session type" "${XDG_SESSION_TYPE:-?}"
# Not `plasmashell --version`: on Plasma 6.7 it needs a display even to print a version and
# aborts with a core dump without one, which over SSH raised a crash report on the desktop.
# KWin ships in step with Plasma, so its number is the one that matters here anyway.
row "plasma (as kwin)" "$(kwin_wayland --version 2>/dev/null | awk '{print $2}')"
row "kwin" "$(kwin_wayland --version 2>/dev/null | awk '{print $2}')"
row "distro" "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"

# Each of these has been the whole cause of a failure: no cmake means no compiled half, and on the
# Debian family qdbus is a package of its own installed under another name.
hdr "tools"
for t in kpackagetool6 kwriteconfig6 kreadconfig6 busctl qdbus qdbus6 cmake node \
         gtk-update-icon-cache xmllint; do
  row "$t" "$(have "$t")"
done

# Which copy answers matters more than whether one exists: a distribution package and a per-user
# install can both be present, and KWin reads the user one.
hdr "packages"
while IFS=: read -r type id; do
  p="$(kpackagetool6 --type "$type" --show "$id" 2>/dev/null \
       | sed -n 's/^[[:space:]]*\(Path\|Caminho\)[[:space:]]*:[[:space:]]*//p' | head -1)"
  row "$id" "${p:-NOT INSTALLED}"
done <<'EOF'
KWin/Script:kosmic-tiling
KWin/Effect:kosmic-tiling-anim
KWin/Effect:kosmic-focusdim
Plasma/Applet:io.github.eduresser.kosmic-tiling
EOF

# The plugin directory is `lib/qt6/plugins` on some distributions and `lib/<triplet>/qt6/plugins`
# on the Debian family, so it is searched for rather than named -- naming it reported ABSENT for
# two files that were installed, which sent a whole evening the wrong way.
#
# Being on disk is only half of it. Qt searches its own plugin directory and QT_PLUGIN_PATH, and a
# prefix under $HOME is in neither, so a per-user plugin can be installed and never loaded. What
# KWin has actually loaded is the answer, and it is asked here directly.
hdr "compiled half"
row "kosmic-stated" "$([ -e "$HOME/.local/bin/kosmic-stated" ] && echo "$HOME/.local/bin/kosmic-stated" || echo ABSENT)"
for n in kosmic-chordhold kosmic-outline; do
  f="$(find "$HOME/.local/lib" -type f -name "$n.so" 2>/dev/null | head -1)"
  row "$n.so" "${f:-ABSENT}"
done
row "kosmic-stated (unit)" "$(systemctl --user is-active kosmic-stated 2>/dev/null)"
# Printed as a count and a verdict rather than in full: on a distribution that wraps its Qt
# applications this is dozens of entries and scrolls the rest of the report off the screen. The
# only question being asked of it is whether the directory the plugins went into is on it.
#
# Read out of the running kwin_wayland, not out of this shell. environment.d reaches the session's
# own processes; a terminal started some other way may never see it, and reporting this shell's
# copy said "0 entries" on a machine where KWin had both plugins loaded.
kwin_pid="$(pgrep -u "$(id -u)" -f kwin_wayland 2>/dev/null | head -1)"
qpp=""
if [ -n "$kwin_pid" ] && [ -r "/proc/$kwin_pid/environ" ]; then
  qpp="$(tr '\0' '\n' < "/proc/$kwin_pid/environ" | sed -n 's/^QT_PLUGIN_PATH=//p' | head -1)"
fi
qpp_n=0; qpp_has=no
if [ -n "$qpp" ]; then
  qpp_n="$(printf '%s' "$qpp" | tr ':' '\n' | grep -c .)"
  for d in $(printf '%s' "$qpp" | tr ':' ' '); do
    case "$d" in "$HOME"/*) [ -d "$d/kwin/plugins" ] && qpp_has=yes ;; esac
  done
fi
row "QT_PLUGIN_PATH (kwin's)" "$qpp_n entries, a user kwin/plugins dir among them: $qpp_has"
row "environment.d file" "$([ -e "$HOME/.config/environment.d/10-kosmic.conf" ] \
  && cat "$HOME/.config/environment.d/10-kosmic.conf" || echo ABSENT)"
row "KWin has loaded" "$(busctl --user get-property org.kde.KWin /Plugins org.kde.KWin.Plugins \
  LoadedPlugins 2>/dev/null | tr ' ' '\n' | grep -o '"kosmic[^"]*"' | tr -d '"' | tr '\n' ' ')"

hdr "kwinrc"
for k in kosmic-tilingEnabled kosmic-tiling-animEnabled kosmic-focusdimEnabled \
         kosmic-chordholdEnabled kosmic-outlineEnabled; do
  row "Plugins/$k" "$(kreadconfig6 --file kwinrc --group Plugins --key "$k" 2>/dev/null)"
done
for k in ChordHold GapInner GapOuter DynamicWorkspaces NewWorkspaceTiled SelectionMarker; do
  row "Script-kosmic-tiling/$k" \
      "$(kreadconfig6 --file kwinrc --group Script-kosmic-tiling --key "$k" 2>/dev/null)"
done
row "Plugin-kosmic-chordhold/Count" \
    "$(kreadconfig6 --file kwinrc --group Plugin-kosmic-chordhold --key Count 2>/dev/null)"

# The question that matters for "the shortcuts do nothing". A name with no entry is one
# kglobalaccel never registered; a name reading `none` is one deliberately silenced; a name
# holding a chord is live. Which of the three it is tells you where to look.
hdr "shortcuts kglobalaccel holds"
if [ -f "$SRC/install.d/claimed.txt" ]; then
  row "chords KOSMIC claims" "$(grep -cvE '^\s*(#|$)' "$SRC/install.d/claimed.txt")"
fi
reg=0; silent=0; missing=0
for n in $(grep -oE '"Kosmic[A-Za-z]+"' "$SRC/keybindings.json" 2>/dev/null | tr -d '"' | sort -u); do
  v="$(kreadconfig6 --file kglobalshortcutsrc --group kwin --key "$n" 2>/dev/null)"
  case "${v%%,*}" in
    "")     missing=$((missing + 1)) ;;
    none)   silent=$((silent + 1)) ;;
    *)      reg=$((reg + 1)) ;;
  esac
done
row "holding a chord" "$reg"
row "silenced (none)" "$silent"
row "no entry at all" "$missing"
for n in KosmicFocusLeft KosmicFocusLeftH KosmicSwapWindow KosmicResize KosmicTiling; do
  row "  $n" "$(kreadconfig6 --file kglobalshortcutsrc --group kwin --key "$n" 2>/dev/null)"
done

hdr "KDE defaults KOSMIC may have unbound"
for k in "Window Quick Tile Left" "Window Quick Tile Right" "Grid View"; do
  row "$k" "$(kreadconfig6 --file kglobalshortcutsrc --group kwin --key "$k" 2>/dev/null)"
done
row "Lock Session" "$(kreadconfig6 --file kglobalshortcutsrc --group ksmserver --key 'Lock Session' 2>/dev/null)"

# An icon that is not well-formed XML is refused whole by the renderer and the widget draws
# nothing, with no line in any journal. This has happened.
hdr "applet icons"
for i in kosmic-tiling-symbolic kosmic-tiling-on-symbolic kosmic-tiling-off-symbolic; do
  f="$HOME/.local/share/icons/hicolor/scalable/apps/$i.svg"
  if [ ! -e "$f" ]; then row "$i" "ABSENT"
  elif command -v xmllint >/dev/null 2>&1 && ! xmllint --noout "$f" 2>/dev/null; then
    row "$i" "PRESENT but MALFORMED XML"
  else row "$i" "ok"; fi
done

hdr "journal (this boot)"
journalctl --user -b 2>/dev/null \
  | grep -iE "kosmic|RangeError|Maximum call stack" \
  | grep -viE "used before its declaration" | tail -25 \
  || echo "  nothing"

printf '\n'
