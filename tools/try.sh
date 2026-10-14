#!/bin/sh
# Loads the KWin script from this checkout into the running session, or unloads it again, without
# installing anything.
#
#   tools/try.sh           load
#   tools/try.sh --stop    unload
#
# Disable the installed kosmic-tiling first if there is one: two copies would register the same
# shortcuts. Goes through busctl for the reason the applet does -- it ships with systemd.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
QML="$ROOT/src/comp/script/contents/ui/main.qml"
NAME="kosmic-tiling-try"

command -v busctl >/dev/null 2>&1 || { echo "busctl not found" >&2; exit 1; }

case "${1:-}" in
  --stop)
    busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting unloadScript s "$NAME"
    ;;
  "")
    [ -r "$QML" ] || { echo "cannot read $QML" >&2; exit 1; }
    id="$(busctl --user call org.kde.KWin /Scripting org.kde.kwin.Scripting \
            loadDeclarativeScript ss "$QML" "$NAME" | awk '{print $2}')"
    busctl --user call org.kde.KWin "/Scripting/Script$id" org.kde.kwin.Script run
    ;;
  *)
    echo "usage: tools/try.sh [--stop]" >&2
    exit 2
    ;;
esac
