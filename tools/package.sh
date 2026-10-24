#!/usr/bin/env bash
# Builds the distribution packages, one per target in packaging/targets/. Nothing is compiled here:
# a package carries the KWin script, the two effects, the applet, kosmic-setup, the sources of the
# four compiled components and kosmic-rebuild. KWin loads a plugin only if it was built for exactly
# its own version, so the plugins cannot be shipped as binaries; kosmic-rebuild compiles them on the
# machine, when the package is installed and again when KWin changes (see packaging/kosmic-rebuild).
# What differs between targets is only the package format and the names of the dependencies.
#
#   tools/package.sh                  every target
#   tools/package.sh deb arch         the named targets
#   VERSION=1.1.1 tools/package.sh    an explicit version (default: the VERSION file)
#
# Needs cmake and nfpm (https://nfpm.goreleaser.com).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${VERSION:-$(head -1 "$REPO/VERSION")}"
VERSION="${VERSION#v}"
export VERSION

command -v nfpm >/dev/null 2>&1 || { echo "nfpm not found: https://nfpm.goreleaser.com/install/" >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo "cmake not found" >&2; exit 1; }

if [ "$#" -gt 0 ]; then targets=("$@"); else
  targets=(); for f in "$REPO"/packaging/targets/*.env; do targets+=("$(basename "$f" .env)"); done
fi

STAGE="$REPO/dist/stage"
rm -rf "$STAGE"
cmake -S "$REPO" -B "$REPO/dist/cmake" -DCMAKE_INSTALL_PREFIX=/usr \
      -DINSTALL_PACKAGES=ON -DINSTALL_SETUP=ON -DINSTALL_SOURCES=ON \
      -DBUILD_STATED=OFF -DBUILD_CHORDHOLD=OFF -DBUILD_OUTLINE=OFF -DBUILD_SWIPE=OFF >/dev/null
DESTDIR="$STAGE" cmake --install "$REPO/dist/cmake" >/dev/null

for target in "${targets[@]}"; do
  conf="$REPO/packaging/targets/$target.env"
  [ -f "$conf" ] || { echo "unknown target: $target" >&2; exit 1; }
  unset FORMAT DEPENDS
  # shellcheck disable=SC1090
  . "$conf"
  out="$REPO/dist/$target"
  rm -rf "$out"; mkdir -p "$out"

  deps=""
  for d in "${DEPENDS[@]}"; do deps+="  - \"$d\""$'\n'; done
  # nfpm expands the environment in most fields but not in a content's src, so that one is filled in here.
  awk -v deps="${deps%$'\n'}" -v stage="$STAGE" '
    $0 == "@DEPENDS@" { print deps; next }
    { gsub(/\$\{STAGE\}/, stage); print }' "$REPO/packaging/nfpm.yaml" > "$out/nfpm.yaml"
  echo "== $target ($FORMAT)"
  ( cd "$REPO" && nfpm package --config "$out/nfpm.yaml" --packager "$FORMAT" --target "$out/" )
done

( cd "$REPO/dist" && sha256sum ./*/*.deb ./*/*.rpm ./*/*.pkg.tar.zst 2>/dev/null > SHA256SUMS || true )
ls -lh "$REPO"/dist/*/*.deb "$REPO"/dist/*/*.rpm "$REPO"/dist/*/*.pkg.tar.zst 2>/dev/null || true
