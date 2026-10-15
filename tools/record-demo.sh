#!/bin/sh
# Records a walk through everything KOSMIC does, on the libvirt test VM, at the screen's own
# size and rate. The keys and the mouse are sent from this host through QEMU, so the guest sees a real keyboard and tablet; the recording is made inside the guest from the DRM framebuffer, so
# it is the compositor's output, not a capture of a window.
#
#   tools/record-demo.sh                 rehearse nothing: record the whole tour
#   tools/record-demo.sh --rehearse      the same tour without recording
#   tools/record-demo.sh --scene NAME    one scene, without recording (see SCENES below)
#   tools/record-demo.sh --shot FILE     save a screenshot of the guest
#   tools/record-demo.sh --list          list the scenes
#
# Needs, once, on the guest: `sudo setcap cap_sys_admin+ep "$(readlink -f "$(which ffmpeg)")"`
# (kmsgrab refuses to read the framebuffer without it), KOSMIC installed and the session logged in.
# On this host virsh lives outside the Flatpak sandbox, hence the flatpak-spawn fallback.
#
# Overrides: VM_NAME, VM_HOST, VM_USER, OUT_DIR, DRM_DEVICE, FPS, PACE (a multiplier on every pause).
set -eu

VM_NAME="${VM_NAME:-kde-neon}"
VM_HOST="${VM_HOST:-192.168.122.163}"
VM_USER="${VM_USER:-eduresser}"
OUT_DIR="${OUT_DIR:-$HOME/Downloads}"
DRM_DEVICE="${DRM_DEVICE:-/dev/dri/card1}"
FPS="${FPS:-60}"
PACE="${PACE:-1}"

SCENES="intro focus move swap resize orientation stacking focusinout float tiling kde workspaces applet"

if command -v virsh >/dev/null 2>&1; then
  VIRSH="virsh -c qemu:///system"
else
  VIRSH="flatpak-spawn --host virsh -c qemu:///system"
fi
SSH_CTL="/tmp/kosmic-demo-ssh-$$"
SSH="ssh -o ControlMaster=auto -o ControlPath=$SSH_CTL -o ControlPersist=120 -o BatchMode=yes $VM_USER@$VM_HOST"
GUEST_ENV='export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus WAYLAND_DISPLAY=wayland-0 XDG_SESSION_TYPE=wayland;'

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# cd away from the sandbox's private scratch directory, which flatpak-spawn cannot enter
cd "$HOME"

guest() { $SSH "$GUEST_ENV $*"; }

pause() { sleep "$(awk -v s="$1" -v p="$PACE" 'BEGIN { printf "%.3f", s * p }')"; }

# ---- keyboard -------------------------------------------------------------------------

qmp_raw() {
  $VIRSH qemu-monitor-command "$VM_NAME" "{\"execute\":\"input-send-event\",\"arguments\":{\"events\":[$1]}}" >/dev/null
}
key_events() { # DOWN(true|false) KEY...
  down="$1"; shift
  out=""
  for k in "$@"; do
    out="$out${out:+,}{\"type\":\"key\",\"data\":{\"down\":$down,\"key\":{\"type\":\"qcode\",\"data\":\"$k\"}}}"
  done
  printf '%s' "$out"
}
reverse() { r=""; for a in "$@"; do r="$a $r"; done; printf '%s' "$r"; }

hold()    { qmp_raw "$(key_events true "$@")"; }
release() { qmp_raw "$(key_events false $(reverse "$@"))"; }
# chord KEY...: press them together, release in reverse
chord() { hold "$@"; sleep 0.09; release "$@"; }

# mouse_pos X Y: put the pointer on a screen pixel. The tablet is absolute, 0..32767 over the whole screen.
# This only works while no SPICE viewer is attached: a viewer keeps sending its own pointer position.
SCREEN_W=1920
SCREEN_H=1200
MOUSE_X=960; MOUSE_Y=600
mouse_pos() {
  ax=$(( $1 * 32767 / SCREEN_W )); ay=$(( $2 * 32767 / SCREEN_H ))
  qmp_raw "{\"type\":\"abs\",\"data\":{\"axis\":\"x\",\"value\":$ax}},{\"type\":\"abs\",\"data\":{\"axis\":\"y\",\"value\":$ay}}"
}
# mouse_to X Y: glide in a few steps, so the pointer reads as a hand and not a teleport. Every step is one
# virsh call, which costs about a quarter of a second through the Flatpak bridge, so there are few of them,
# and none when the pointer is already there.
mouse_to() {
  [ "$1" = "$MOUSE_X" ] && [ "$2" = "$MOUSE_Y" ] && return 0
  n=4; i=1
  while [ "$i" -le "$n" ]; do
    mouse_pos $(( MOUSE_X + ($1 - MOUSE_X) * i / n )) $(( MOUSE_Y + ($2 - MOUSE_Y) * i / n ))
    i=$((i + 1))
  done
  MOUSE_X=$1; MOUSE_Y=$2
}
# press: one click where the pointer already is
press() {
  qmp_raw '{"type":"btn","data":{"down":true,"button":"left"}}'; sleep 0.08
  qmp_raw '{"type":"btn","data":{"down":false,"button":"left"}}'
}
click() { mouse_to "$1" "$2"; sleep 0.15; press; }

# caption TEXT [SECONDS]: a passive popup naming what is about to happen
caption() {
  guest "setsid -f kdialog --passivepopup '$1' ${2:-2} >/dev/null 2>&1" || true
}

# ---- windows ------------------------------------------------------------------------------------

# open_window N COLOUR: a terminal filled with one ANSI background colour so each window is told apart
open_window() {
  guest "setsid -f konsole --separate --hide-menubar --hide-tabbar -e sh -c 'printf \"\\033[4$2m\\033[2J\\033[H\\n\\n   WINDOW $1\\n\"; exec sleep 100000' >/dev/null 2>&1"
  pause 1.4
}
close_windows() { guest 'pkill konsole; pkill systemsettings; true' >/dev/null 2>&1 || true; sleep 1; }
shot() { guest 'spectacle -b -n -f -p -o /tmp/kosmic-demo-shot.png' && scp -q -o ControlPath="$SSH_CTL" "$VM_USER@$VM_HOST:/tmp/kosmic-demo-shot.png" "$1"; }

# ---- scenes -------------------------------------------------------------------------------------
# Each scene assumes the previous ones' windows are still open, as the tour runs them in order.
# One caption per scene, naming the chords it is about to show; the keys themselves are not captioned,
# so the popups never pile up. `tap` presses a chord and waits for the animation and the viewer.

tap() { wait="$1"; shift; chord "$@"; pause "$wait"; }

scene_intro() {
  caption "KOSMIC: COSMIC window management on KDE Plasma" 3
  pause 3.4
  caption "Automatic tiling: each new window takes a slot" 3
  open_window 1 4; pause 0.8
  open_window 2 1; pause 0.8
  open_window 3 2; pause 0.8
  open_window 4 5; pause 1.4
}

scene_focus() {
  caption "Focus by direction: Meta + arrows, or H J K L" 3.5; pause 1.6
  tap 1.1 meta_l left
  tap 1.1 meta_l up
  tap 1.1 meta_l right
  tap 1.1 meta_l down
  tap 0.9 meta_l h
  tap 0.9 meta_l k
  tap 0.9 meta_l l
  tap 1.2 meta_l j
}

scene_move() {
  caption "Move the window: Meta + Shift + arrows" 3.5; pause 1.6
  tap 1.4 meta_l shift left
  tap 1.4 meta_l shift up
  tap 1.4 meta_l shift right
  tap 1.6 meta_l shift down
}

scene_swap() {
  caption "Swap mode: hold Meta+X, pick a window, release" 4; pause 2.4
  hold meta_l x; pause 0.8
  chord left; pause 1.2
  chord up; pause 1.2
  release meta_l x; pause 1.6
}

scene_resize() {
  caption "Resize mode: hold Meta+R and use the arrows" 4; pause 2.4
  hold meta_l r; pause 0.6
  chord right; pause 0.45; chord right; pause 0.45; chord right; pause 0.9
  chord left; pause 0.45; chord left; pause 0.45; chord left; pause 0.45; chord left; pause 0.9
  chord down; pause 0.45; chord down; pause 0.45; chord down; pause 0.9
  chord up; pause 0.45; chord up; pause 0.45; chord up; pause 0.9
  release meta_l r; pause 1.2
}

scene_orientation() {
  caption "Meta+O: flip the orientation of the group" 3; pause 1.6
  tap 2 meta_l o
  tap 2 meta_l o
}

scene_stacking() {
  caption "Stacking: Meta+S puts windows in one slot behind a tab bar" 4; pause 2.6
  tap 2 meta_l s
  caption "Meta+Period and Meta+Comma walk the stack" 3; pause 0.8
  tap 1.4 meta_l dot
  tap 1.4 meta_l dot
  tap 1.4 meta_l comma
  caption "Meta+Shift+S dissolves it" 2.5; pause 0.6
  tap 2 meta_l shift s
}

scene_focusinout() {
  caption "Meta+U selects the enclosing group, Meta+I goes back in" 4; pause 2.6
  tap 1.8 meta_l u
  tap 1.8 meta_l u
  tap 1.6 meta_l i
  tap 1.6 meta_l i
}

scene_float() {
  caption "Meta+G floats a window, again to tile it" 3; pause 1.6
  tap 2.2 meta_l g
  tap 2.2 meta_l g
}

scene_tiling() {
  caption "Meta+Y turns tiling off and on for this workspace" 3.5; pause 1.8
  tap 2.4 meta_l y
  tap 2.4 meta_l y
}

scene_kde() {
  caption "KDE answers the rest: Meta+M maximise, Meta+F11 fullscreen" 4; pause 2.6
  tap 1.8 meta_l m
  tap 1.8 meta_l m
  tap 1.8 meta_l f11
  tap 1.8 meta_l f11
}

scene_workspaces() {
  caption "Dynamic workspaces: there is always an empty one past the last" 4; pause 2.8
  tap 1.6 meta_l 2
  open_window 5 3; pause 0.6
  open_window 6 6; pause 1
  caption "Meta+Ctrl+arrows switch workspace, adding Shift carries the window" 4; pause 1
  tap 1.6 meta_l ctrl left
  tap 1.6 meta_l ctrl right
  tap 2 meta_l ctrl shift right
  tap 1.6 meta_l ctrl left
  caption "Meta+0 goes to the last workspace" 3; pause 0.6
  tap 1.6 meta_l 0
  caption "Meta+Q closes; the last window out removes the workspace" 4; pause 0.8
  tap 1.6 meta_l q
  tap 2.2 meta_l q
  tap 1.8 meta_l 1
}

# The popup's controls, in screen pixels. The popup sits 20 px higher once the windows no longer touch the
# panel, which a bigger gap causes, so every y here is a point that is on the control in both positions.
# clicks X Y N: N clicks a beat apart, for a spin box. The applet writes 400 ms after the last click.
clicks() { mouse_to "$1" "$2"; n="$3"; while [ "$n" -gt 0 ]; do press; pause 0.4; n=$((n - 1)); done; }

# The popup opens through the global shortcut Plasma registers for a widget that has one (see
# applet_shortcut), which does not depend on where the panel icon sits.
applet_shortcut() {
  guest "qdbus6 org.kde.plasmashell /PlasmaShell org.kde.PlasmaShell.evaluateScript 'panels().forEach(function(p){ p.widgetIds.forEach(function(i){ var w = p.widgetById(i); if (w.type.indexOf(\"kosmic\") >= 0) w.globalShortcut = \"Ctrl+Alt+Shift+F9\" }) })' >/dev/null 2>&1; true"
}
applet_open() {
  id="$(guest "qdbus6 org.kde.kglobalaccel /component/plasmashell org.kde.kglobalaccel.Component.shortcutNames | sed -n 's/^activate widget //p' | head -1")"
  guest "busctl --user call org.kde.kglobalaccel /component/plasmashell org.kde.kglobalaccel.Component invokeShortcut s 'activate widget $id' >/dev/null"
}

scene_applet() {
  caption "The panel applet: tiling and the active hint, applied at once" 4
  pause 1.2
  applet_open; pause 2
  mouse_to 1736 418; pause 0.8
  click 1736 418; pause 3.2         # tiling on this workspace: off, then on
  click 1736 418; pause 3.2
  click 1726 492; pause 1.6         # the default for new workspaces: floating, then tiled
  click 1662 492; pause 1.6
  caption "Active hint: switch, thickness, radius, colour" 4; pause 0.6
  click 1736 714; pause 2         # the hint off, then on
  click 1736 714; pause 2
  clicks 1745 768 5; pause 0.8
  clicks 1671 768 5; pause 0.8
  clicks 1745 826 6; pause 0.8
  clicks 1671 826 6; pause 0.8
  caption "Gaps between windows and at the screen edges" 4; pause 0.6
  clicks 1745 958 6; pause 1
  clicks 1671 958 6; pause 1
  clicks 1745 1016 6; pause 1
  clicks 1671 1016 6; pause 1.2
  click 1735 881; pause 2.8         # the colour dialog; Escape closes it and the popup with it
  chord esc; pause 1.6
}

# ---- recording ----------------------------------------------------------------------------------

REC_PID_FILE=/tmp/kosmic-demo-ffmpeg.pid
rec_start() {
  guest "rm -f /tmp/kosmic-demo.mp4; nohup ffmpeg -y -loglevel warning -f kmsgrab -device $DRM_DEVICE -framerate $FPS -i - \
    -vf 'hwmap=derive_device=vaapi,hwdownload,format=bgr0' \
    -c:v libx264 -preset veryfast -crf 17 -pix_fmt yuv420p -t 900 /tmp/kosmic-demo.mp4 >/tmp/kosmic-demo-ffmpeg.log 2>&1 &
    echo \$! >$REC_PID_FILE"
  sleep 2
  guest "kill -0 \$(cat $REC_PID_FILE)" || { guest 'cat /tmp/kosmic-demo-ffmpeg.log'; echo "recorder did not start" >&2; exit 1; }
}
rec_stop() {
  guest "kill -INT \$(cat $REC_PID_FILE) 2>/dev/null; while kill -0 \$(cat $REC_PID_FILE) 2>/dev/null; do sleep 0.3; done; cat /tmp/kosmic-demo-ffmpeg.log" || true
}

# reset_settings: back to the defaults the applet's controls write, so every take starts alike
reset_settings() {
  guest 'g=Script-kosmic-tiling; o=Plugin-kosmic-outline
    kwriteconfig6 --file kwinrc --group $g --key GapInner 8
    kwriteconfig6 --file kwinrc --group $g --key GapOuter 0
    kwriteconfig6 --file kwinrc --group $g --key NewWorkspaceTiled true
    kwriteconfig6 --file kwinrc --group $o --key Thickness 3
    for k in Radius Color; do kwriteconfig6 --file kwinrc --group $o --key $k --delete; done
    inv="busctl --user call org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component invokeShortcut s"
    busctl --user call org.kde.KWin /KWin org.kde.KWin reconfigure >/dev/null
    busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins UnloadPlugin s kosmic-outline >/dev/null
    busctl --user call org.kde.KWin /Plugins org.kde.KWin.Plugins LoadPlugin s kosmic-outline >/dev/null
    $inv KosmicReloadSettings >/dev/null; $inv KosmicNewWorkspaceTiled >/dev/null; true'
  sleep 1.5
}

prepare() {
  reset_settings
  applet_shortcut
  mouse_pos 960 700; MOUSE_X=960; MOUSE_Y=700
  close_windows
  guest "qdbus6 org.kde.KWin /KWin setCurrentDesktop 1 >/dev/null 2>&1; true"
  pause 1
}

run_scenes() { for s in $SCENES; do "scene_$s"; done; }

usage() { sed -n '2,19p' "$ROOT/tools/record-demo.sh" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }

case "${1:-}" in
  --list)     for s in $SCENES; do echo "$s"; done ;;
  --shot)     [ -n "${2:-}" ] || usage; shot "$2" ;;
  --scene)    [ -n "${2:-}" ] || usage; "scene_$2" ;;
  --prepare)  prepare ;;
  --click)    click "$2" "$3" ;;
  --keys)     shift; chord "$@" ;;
  --rehearse) prepare; run_scenes; pause 2; close_windows; reset_settings ;;
  "")
    mkdir -p "$OUT_DIR"
    sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)"
    out="$OUT_DIR/kosmic-demo-$sha.mp4"
    prepare
    rec_start
    trap 'rec_stop' EXIT
    run_scenes
    pause 2
    close_windows
    reset_settings
    pause 1
    trap - EXIT
    rec_stop
    scp -q -o ControlPath="$SSH_CTL" "$VM_USER@$VM_HOST:/tmp/kosmic-demo.mp4" "$out"
    echo "$out"
    ;;
  -h|--help)  usage 0 ;;
  *)          usage ;;
esac
