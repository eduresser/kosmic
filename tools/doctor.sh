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
row "plasma" "$(plasmashell --version 2>/dev/null | awk '{print $2}')"
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

hdr "compiled half"
for f in "$HOME/.local/bin/kosmic-stated" \
         "$HOME/.local/lib/kwin/plugins/kosmic-chordhold.so" \
         "$HOME/.local/lib/kwin/plugins/kosmic-outline.so"; do
  row "$(basename "$f")" "$([ -e "$f" ] && echo "$f" || echo ABSENT)"
done
row "kosmic-stated (unit)" "$(systemctl --user is-active kosmic-stated 2>/dev/null)"

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
