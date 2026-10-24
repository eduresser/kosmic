#!/bin/sh
# Acts only when the package goes for good. An upgrade must leave the built files alone: deb passes
# upgrade (or deconfigure), rpm passes the number of copies that will remain, 1 or more. Removal is
# everything else: deb remove/purge, rpm 0, and pacman, whose pre_remove runs only on removal and
# is given the package version.
case "${1:-}" in
  upgrade|failed-upgrade|deconfigure|[1-9]|[1-9][0-9]) ;;
  *)
    if [ -d /run/systemd/system ]; then
      systemctl disable --now kosmic-rebuild.path kosmic-rebuild.service >/dev/null 2>&1 || true
    fi
    /usr/bin/kosmic-rebuild --remove || true
    ;;
esac
exit 0
