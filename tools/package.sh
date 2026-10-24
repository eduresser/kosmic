#!/usr/bin/env bash
# Builds the distribution packages of the architecture-independent half: the KWin script, the two
# effects, the applet and kosmic-setup. Compiled nothing, so one set serves every distribution.
#
#   tools/package.sh              version from VERSION
#   tools/package.sh 1.0.4        an explicit version
#
# The three KWin plugins and kosmic-stated are not here. They link KWin's internal headers, which
# carry no binary compatibility, so each distribution has to build them against its own KWin.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${1:-$(head -1 "$REPO/VERSION")}"
VERSION="${VERSION#v}"
STAGE="$REPO/dist/stage"

command -v nfpm >/dev/null 2>&1 || { echo "nfpm not found: https://nfpm.goreleaser.com/install/" >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo "cmake not found" >&2; exit 1; }

rm -rf "$STAGE" "$REPO"/dist/*.deb "$REPO"/dist/*.rpm "$REPO"/dist/*.pkg.tar.zst
cmake -S "$REPO" -B "$REPO/dist/cmake" \
      -DCMAKE_INSTALL_PREFIX=/usr \
      -DINSTALL_PACKAGES=ON -DINSTALL_SETUP=ON \
      -DBUILD_STATED=OFF -DBUILD_CHORDHOLD=OFF -DBUILD_OUTLINE=OFF -DBUILD_SWIPE=OFF >/dev/null
DESTDIR="$STAGE" cmake --install "$REPO/dist/cmake" >/dev/null

cd "$REPO"
for format in deb rpm archlinux; do
  VERSION="$VERSION" nfpm package --config packaging/nfpm.yaml --packager "$format" --target dist/
done
(cd dist && sha256sum ./*.deb ./*.rpm ./*.pkg.tar.zst > SHA256SUMS)
ls -lh dist/*.deb dist/*.rpm dist/*.pkg.tar.zst
