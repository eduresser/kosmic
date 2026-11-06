#!/usr/bin/env bash
# Everything that can be asked about KOSMIC without a session.
#
#   tools/test.sh                   run it
#   KOSMIC_TEST_STRICT=1 …          a missing tool is a failure rather than a skip
#   KOSMIC_QML_IMPORT_PATH=a:b …    extra QML import roots, for a layout qml cannot find alone
#
# Compiles nothing: the C++ components need KWin's internal headers, which most machines lack.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMP="$ROOT/src/comp"
TILER="$COMP/script/contents/code/kosmic-tiling.mjs"
KEYMAP="$ROOT/keybindings.json"
STRICT="${KOSMIC_TEST_STRICT:-0}"

failed=0
skipped=0

say()  { printf '\033[1m--\033[0m %s\n' "$*"; }
ok()   { printf '   %s\n' "$*"; }
bad()  { printf '\033[1;31m!!\033[0m %s\n' "$*" >&2; failed=$((failed + 1)); }
skip() {
  if [ "$STRICT" = 1 ]; then
    bad "$1 -- required, because KOSMIC_TEST_STRICT is set"
  else
    printf '\033[1;33m~~\033[0m %s -- skipped\n' "$1" >&2
    skipped=$((skipped + 1))
  fi
}

# Debian-family Qt 6 keeps its tools off PATH; qtpaths6 first since it stays right on unknown layouts.
qt_tool() {
  local name="$1" dir
  for candidate in "${name}6" "$name"; do
    if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  done
  for q in qtpaths6 qtpaths; do
    if command -v "$q" >/dev/null 2>&1; then
      dir="$("$q" --query QT_INSTALL_BINS 2>/dev/null)"
      if [ -n "$dir" ] && [ -x "$dir/$name" ]; then echo "$dir/$name"; return 0; fi
    fi
  done
  for dir in /usr/lib/qt6/bin /usr/lib64/qt6/bin /usr/lib/x86_64-linux-gnu/qt6/bin \
             /usr/libexec/qt6/bin; do
    if [ -x "$dir/$name" ]; then echo "$dir/$name"; return 0; fi
  done
  return 1
}

NODE="$(command -v node 2>/dev/null || true)"
QML="$(qt_tool qml || true)"
QMLLINT="$(qt_tool qmllint || true)"
XMLLINT="$(command -v xmllint 2>/dev/null || true)"
# No skip for Node: it runs most of the suite, so skipping would report a near-empty pass.
if [ -z "$NODE" ]; then
  echo "node not found -- it runs the generated-file check, the parity check and every simulator" >&2
  exit 1
fi

# First: every later check reads the generated files.
say "generated files"
"$NODE" "$ROOT/tools/gen.mjs" --check || bad "generated files are out of date"

say "settings parity"
"$NODE" "$ROOT/tools/parity.mjs" || bad "settings.json parity"

# A chord `keycode` cannot encode is skipped at install time with only a warning.
say "shell scripts"
for f in "$ROOT/install.sh"; do
  bash -n "$f" && ok "$(basename "$f")" || bad "$(basename "$f") does not parse"
done
sh -n "$ROOT/install.d/kosmic-open" && ok "kosmic-open" || bad "kosmic-open does not parse"
(
  eval "$(sed -n '/^keycode() {/,/^}/p' "$ROOT/install.sh")"
  miss=0
  while IFS= read -r chord; do
    keycode "$chord" >/dev/null || { echo "   no key code for: $chord" >&2; miss=$((miss + 1)); }
  done < <(grep -hvE '^\s*(#|$)' "$ROOT/install.d/claimed.txt")
  exit "$miss"
) && ok "every claimed chord has a key code" || bad "install.sh cannot encode a claimed chord"
(
  eval "$(sed -n '/^kwin_header_version() {/,/^}/p' "$ROOT/install.sh")"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/kwin"
  printf '#define KWIN_VERSION_STRING "6.8.1"\n#define KWIN_PLUGIN_VERSION_STRING "6.8.1"\n' \
    > "$tmp/kwin/config-kwin.h"
  PREFIX="$tmp/none" KOSMIC_KWIN_INCLUDE="$tmp"
  [ "$(kwin_header_version)" = 6.8.1 ]
) && ok "the KWin headers' plugin version is read" || bad "install.sh misreads config-kwin.h"
(
  eval "$(sed -n '/^write_rebuild_units() {/,/^}/p' "$ROOT/install.sh")"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/bin"; printf '#!/bin/sh\n' > "$tmp/bin/kwin_wayland"; chmod +x "$tmp/bin/kwin_wayland"
  SRC="/opt/a dir/kosmic" PATH="$tmp/bin:$PATH"
  write_rebuild_units "$tmp/units" || exit 1
  grep -qxF "ExecStart=/usr/bin/env bash \"$SRC/install.sh\" --rebuild" "$tmp/units/kosmic-rebuild.service" \
    && grep -qxF "PathChanged=$(readlink -f "$tmp/bin/kwin_wayland")" "$tmp/units/kosmic-rebuild.path" \
    && grep -qxF "Unit=kosmic-rebuild.service" "$tmp/units/kosmic-rebuild.path" || exit 1
  if command -v systemd-analyze >/dev/null 2>&1; then
    systemd-analyze --user verify "$tmp/units/kosmic-rebuild.path" "$tmp/units/kosmic-rebuild.service" \
      2>&1 | grep -vE 'Command .* is not executable|Failed to connect to (system|user) bus' | grep -q . && exit 1
  fi
  exit 0
) && ok "the rebuild units run --rebuild when kwin_wayland changes" || bad "install.sh writes broken rebuild units"

say "sims"
n=0
for t in "$COMP"/tests/*.mjs; do
  [ -e "$t" ] || continue
  if "$NODE" "$t" "$TILER" "$KEYMAP"; then
    ok "$(basename "$t")"
  else
    bad "$(basename "$t")"
  fi
  n=$((n + 1))
done
# A glob matching nothing would pass while proving nothing.
if [ "$n" -eq 0 ]; then bad "no sims found"; else ok "$n sims"; fi

# Node is more forgiving than QJSEngine (~ES7): object spread in a literal passed every sim and
# failed in a live session.
if [ -z "$QML" ]; then
  skip "qml not found (qt6-declarative)"
else
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  export HOME="$TMP" XDG_RUNTIME_DIR="$TMP" QT_QPA_PLATFORM=offscreen
  # Not optional: without it the parse error is swallowed and all that is left is an exit code.
  export QT_FORCE_STDERR_LOGGING=1
  if [ -n "${KOSMIC_QML_IMPORT_PATH:-}" ]; then
    export QML_IMPORT_PATH="$KOSMIC_QML_IMPORT_PATH${QML_IMPORT_PATH:+:$QML_IMPORT_PATH}"
    export QML2_IMPORT_PATH="$QML_IMPORT_PATH"
  fi

  say "qml load"
  "$QML" "$COMP/tests/qml/load.qml" || bad "qml load"

  # Qt.createComponent returns null at run time, so a broken overlay silently never appears.
  # main.qml is excluded: org.kde.kwin exists only inside KWin.
  say "qml components"
  "$QML" "$COMP/tests/qml/components.qml" || bad "qml components"

  say "qml applet"
  "$QML" "$COMP/tests/qml/applet.qml" -- "$ROOT/src/applet/contents/ui/main.qml" || bad "qml applet"
fi

# applet.qml can only compile, not instantiate (Plasmoid exists only in plasmashell); qmllint
# resolves properties and ids against the real modules.
if [ -z "$QMLLINT" ]; then
  skip "qmllint not found (qt6-declarative)"
else
  say "qmllint applet"
  lintargs=()
  # -I rather than QML_IMPORT_PATH: qmllint does not read that variable.
  if [ -n "${KOSMIC_QML_IMPORT_PATH:-}" ]; then
    IFS=: read -ra dirs <<<"$KOSMIC_QML_IMPORT_PATH"
    for d in "${dirs[@]}"; do lintargs+=(-I "$d"); done
  fi
  "$QMLLINT" "${lintargs[@]+"${lintargs[@]}"}" "$ROOT/src/applet/contents/ui/main.qml" \
    || bad "qmllint applet"
fi

# A malformed config.ui silently opens an empty dialog. kcfg_<key> pairing is not checked.
if [ -z "$XMLLINT" ]; then
  skip "xmllint not found (libxml2)"
else
  say "config dialogs"
  for u in "$COMP"/effect/contents/ui/config.ui "$COMP"/focusdim/contents/ui/config.ui; do
    if "$XMLLINT" --noout "$u"; then
      ok "$(basename "$(dirname "$(dirname "$(dirname "$u")")")")"
    else
      bad "$u"
    fi
  done

  # A malformed SVG silently draws nothing. `--` (our em dash) is illegal inside an XML comment and
  # once broke kosmic-tiling-symbolic.svg.
  say "icon svgs"
  n=0
  for s in "$ROOT"/src/applet/contents/icons/*.svg; do
    [ -e "$s" ] || continue
    if "$XMLLINT" --noout "$s"; then ok "$(basename "$s")"; else bad "$s is not well-formed XML"; fi
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || bad "no icon svgs found"
fi

# Deliberately none: its dialog wrote a shadowing copy into ~/.config/kwinrc that silently won.
# X-KDE-ConfigModule must stay gone too, or the gear opens an empty dialog.
say "tiler has no config dialog"
if [ -e "$COMP/script/contents/ui/config.ui" ]; then
  bad "the tiler has a config.ui again"
elif grep -q X-KDE-ConfigModule "$COMP/script/metadata.json"; then
  bad "the tiler declares X-KDE-ConfigModule again"
else
  ok "still none"
fi

# Both ends name the interface and path as string literals, and DBusCall reads no reply, so a
# mismatch is silent.
say "dbus contract"
iface="$(sed -n 's/.*Q_CLASSINFO("D-Bus Interface", "\([^"]*\)").*/\1/p' "$ROOT/src/outline/outline.h")"
dpath="$(sed -n 's/.*s_dbusPath("\([^"]*\)").*/\1/p' "$ROOT/src/outline/outline.cpp")"
tilerui="$COMP/script/contents/ui/main.qml"
if [ -z "$iface" ]; then
  bad "outline.h declares no D-Bus interface name: Qt will derive one from the host process"
elif [ -z "$dpath" ]; then
  bad "outline.cpp declares no s_dbusPath"
elif ! grep -qF "dbusInterface: \"$iface\"" "$tilerui"; then
  bad "the tiler calls no interface named $iface"
elif ! grep -qF "path: \"$dpath\"" "$tilerui"; then
  bad "the tiler calls no object at $dpath"
else
  ok "$iface at $dpath"
fi

echo
if [ "$failed" -gt 0 ]; then
  printf '\033[1;31m%s check(s) failed\033[0m\n' "$failed" >&2
  exit 1
fi
if [ "$skipped" -gt 0 ]; then
  printf '\033[1;33mpassed, %s check(s) skipped for want of a tool\033[0m\n' "$skipped"
else
  printf '\033[1;32mpassed\033[0m\n'
fi
