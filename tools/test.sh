#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only
#
# Everything that can be asked about KOSMIC without a session.
#
#   tools/test.sh                   run it
#   KOSMIC_TEST_STRICT=1 …          a missing tool is a failure rather than a skip
#   KOSMIC_QML_IMPORT_PATH=a:b …    extra QML import roots, for a layout qml cannot find alone
#
# It does not compile anything. The three C++ components build against KWin's internal headers,
# which most machines do not have installed -- the README says so, it is the dependency that is
# missing most often -- and a suite that fails there would be failing for a reason that has
# nothing to do with what it is meant to prove. `cmake` builds them; the CI canary catches the
# header changes.
#
# Locally a check whose tool is absent says so and is skipped, because a developer without
# `reuse` installed should still get the simulators. In CI that is exactly wrong -- a green run
# proving less than it claims is the one failure mode a suite must not have -- so the workflow
# sets KOSMIC_TEST_STRICT=1 and every skip becomes a failure.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMP="$ROOT/comp"
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

# Qt 6 keeps its tools off PATH on the Debian family, which is what KDE Neon is built on, so the
# plain name is only the first guess. qtpaths6 is asked before the hardcoded directories because
# it is the answer that stays right on a layout nobody here has seen.
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
REUSE="$(command -v reuse 2>/dev/null || true)"

# Node is the one tool with no fallback: it runs the generator check, the parity check and all
# thirty-odd simulators, which is most of the suite. Carrying on without it would report a pass
# for a run that did almost nothing.
if [ -z "$NODE" ]; then
  echo "node not found -- it runs the generated-file check, the parity check and every simulator" >&2
  exit 1
fi

# ---------------------------------------------------------------- generated files
# First, because every check after this one reads them. They are committed so that a clone, a
# release tarball and whatever the KDE Store unpacks all carry a working package; this is what
# keeps the committed copy equal to what the generator would write today.
say "generated files"
"$NODE" "$ROOT/tools/gen.mjs" --check || bad "generated files are out of date"

# ---------------------------------------------------------------- settings parity
say "settings parity"
"$NODE" "$ROOT/tools/parity.mjs" || bad "settings.json parity"

# ---------------------------------------------------------------- the simulators
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
# A glob that matches nothing would leave this check passing while proving nothing, which is the
# one failure mode a test suite must not have.
if [ "$n" -eq 0 ]; then bad "no sims found"; else ok "$n sims"; fi

# ---------------------------------------------------------------- the QML
# The sims run in Node, and Node is a far more forgiving engine than the one a KWin script
# actually runs in. QJSEngine is Qt's V4 and stops at roughly ES7, so a construct Node swallows --
# object spread in a literal is the one that got through -- passes every sim and then fails to
# load in a live session, which costs a logout to find out. This loads the modules through the
# real engine, the same way contents/ui/main.qml does.
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

  # The overlays, which are QML rather than JavaScript. Qt.createComponent fails at run time and
  # hands back null, so a broken one costs a line in the journal and the feature silently not
  # appearing -- indistinguishable from it never having been written. main.qml is not in here: it
  # imports org.kde.kwin, which exists only inside KWin.
  say "qml components"
  "$QML" "$COMP/tests/qml/components.qml" || bad "qml components"

  say "qml applet"
  "$QML" "$COMP/tests/qml/applet.qml" -- "$ROOT/applet/contents/ui/main.qml" || bad "qml applet"
fi

# The same file through qmllint, which asks a different question. applet.qml only compiles the
# component -- it cannot instantiate one, because PlasmoidItem needs the Plasmoid attached object
# and that exists only inside plasmashell -- so a property that does not exist on the type it is
# set on, or an id that resolves to nothing, parses perfectly and fails at run time, in a popup,
# with one line in the journal. qmllint resolves every type against the real modules and says so.
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
  "$QMLLINT" "${lintargs[@]+"${lintargs[@]}"}" "$ROOT/applet/contents/ui/main.qml" \
    || bad "qmllint applet"
fi

# ---------------------------------------------------------------- the config dialogs
# KWin builds each from contents/ui/config.ui, and a malformed one does not announce itself: the
# gear button opens an empty dialog. Well-formedness is what is checked here, not the pairing -- a
# widget named kcfg_<key> whose <key> is not in the generated main.xml still parses, and still
# silently configures nothing.
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

  # The applet's icons, which are XML too and were not being asked. An SVG that is not well-formed
  # is refused outright by a strict renderer -- librsvg and Qt's both -- so the panel widget takes
  # its slot and draws nothing, with not one line in any journal to say why.
  #
  # The way in is this repository's own comment style: `--` stands in for an em dash everywhere,
  # and `--` inside an XML comment is illegal. One of them in a licence header was enough to make
  # `kosmic-tiling-symbolic.svg` unparseable while the two beside it stayed fine, which is as
  # quiet as a failure gets -- the icon that broke is the one shown before the applet learns what
  # the workspace is doing, so it is what every install shows first and what a session with no
  # kosmic-stated shows forever.
  say "icon svgs"
  n=0
  for s in "$ROOT"/applet/contents/icons/*.svg; do
    [ -e "$s" ] || continue
    if "$XMLLINT" --noout "$s"; then ok "$(basename "$s")"; else bad "$s is not well-formed XML"; fi
    n=$((n + 1))
  done
  [ "$n" -gt 0 ] || bad "no icon svgs found"
fi

# The tiler has none, and that is deliberate rather than missing. Every key it exposed is written
# to kwinrc by something else -- the applet, or install.sh -- and the dialog wrote a second copy
# into ~/.config/kwinrc that shadows it. So the dialog did not fail: it won, silently and
# permanently, and a setting changed afterwards had no effect with nothing on screen to say why.
#
# Two things have to stay gone for the gear to stay out of the KWin Scripts list, and only one of
# them is the file: the list reads X-KDE-ConfigModule, so deleting the .ui alone would leave the
# button there opening an empty dialog.
say "tiler has no config dialog"
if [ -e "$COMP/script/contents/ui/config.ui" ]; then
  bad "the tiler has a config.ui again"
elif grep -q X-KDE-ConfigModule "$COMP/script/metadata.json"; then
  bad "the tiler declares X-KDE-ConfigModule again"
else
  ok "still none"
fi

# ---------------------------------------------------------------- licensing
# Two licences in one tree, which is not something one declaration can state precisely: it says
# the tree contains GPL-3.0 and CC BY-SA 4.0 and not which file is which. REUSE does say which,
# file by file, and this keeps it true -- a new file with no SPDX header fails here rather than
# quietly making the tree non-compliant on the day somebody packages it.
if [ -z "$REUSE" ]; then
  skip "reuse not found (pipx install reuse)"
else
  say "reuse"
  if "$REUSE" --root "$ROOT" lint --quiet; then ok "compliant"; else bad "reuse lint"; fi
fi

# ---------------------------------------------------------------- the D-Bus contract
# The one contract in here that nothing else can check. The tiler tells the outline plugin where
# the selection is over D-Bus, and both ends name the interface and the object path as string
# literals in different languages, in different files, built by different toolchains. Nothing
# links them.
#
# Worse, getting it wrong is silent in both directions: DBusCall reads no reply, so a call to a
# name nobody answers is indistinguishable from a call that worked, and the only symptom is that
# the hint never appears.
say "dbus contract"
iface="$(sed -n 's/.*Q_CLASSINFO("D-Bus Interface", "\([^"]*\)").*/\1/p' "$ROOT/outline/outline.h")"
dpath="$(sed -n 's/.*s_dbusPath("\([^"]*\)").*/\1/p' "$ROOT/outline/outline.cpp")"
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

# ----------------------------------------------------------------
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
