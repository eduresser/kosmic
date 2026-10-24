#!/bin/sh
# Builds the compiled components for the KWin that is installed now, and arms the units that do it
# again when KWin changes. Neither may fail the install: a build that cannot be made is only logged.
/usr/bin/kosmic-rebuild || true
if [ -d /run/systemd/system ]; then
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable kosmic-rebuild.path kosmic-rebuild.service >/dev/null 2>&1 || true
  systemctl start kosmic-rebuild.path >/dev/null 2>&1 || true
fi
exit 0
