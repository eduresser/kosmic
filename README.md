<!--
SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>

SPDX-License-Identifier: GPL-3.0-only
-->

# KOSMIC

COSMIC's window management, on KDE Plasma 6.

**An unofficial port of [System76](https://system76.com)'s work.** The behaviour, the keymap and
the tiling model come from [`cosmic-comp`](https://github.com/pop-os/cosmic-comp),
[`pop-os/shell`](https://github.com/pop-os/shell) and
[`cosmic-applets`](https://github.com/pop-os/cosmic-applets). The panel applet's two state icons
are System76's, from the Pop Symbolic icon theme, under CC BY-SA 4.0. This project is not
affiliated with System76 and is not endorsed by them. Everything it gets right is theirs;
everything it gets wrong is the port's.

The presentation is KDE's: Plasma's on-screen display, Plasma's dialogs, the colour scheme's
accent. The rule throughout is that behaviour comes from cosmic-comp and presentation comes from
KDE.

## What it does

Automatic tiling with an N-ary group tree, the way COSMIC does it rather than the way a binary
fork tree does: windows in a group split along one axis, groups nest, and a group can be stacked so
its windows share one slot behind a tab bar.

- **Focus and move** by direction, with `Focus Out` selecting the enclosing group and `Focus In`
  walking back down into it
- **Swap mode** — mark a window, carry the selection anywhere, trade on the second press
- **Resize mode** — the arrows grow and shrink the slot, with the tree deciding which boundary moves
- **Stacking** — several windows in one slot, with a tab bar over the top
- **Dynamic workspaces** — a workspace disappears when its last window leaves, and there is always
  an empty one past the end
- **The active hint** — the selection shown by dimming everything outside it, by a line around it,
  or both
- **A panel applet** following `cosmic-applet-tiling`: tiling on this workspace, the default for
  new ones, the gaps, and the hint's thickness and colour

## Components

Five pieces. The two the KDE Store delivers work on their own; the three compiled ones add the
parts a KWin script cannot reach.

| Component | What | Needed for | From the Store |
|---|---|---|---|
| `kosmic-tiling` | KWin script | everything | yes |
| `io.github.eduresser.kosmic-tiling` | Plasma applet | the panel widget | yes |
| `kosmic-tiling-anim`, `kosmic-focusdim` | KWin scripted effects | animation, dimming | yes, with the script |
| `kosmic-stated` | session service (C++) | the applet's tiling switch reading its state | no |
| `kosmic-chordhold` | KWin plugin (C++) | `Meta+X` and `Meta+R` as **holds** rather than toggles | no |
| `kosmic-outline` | KWin plugin (C++) | the line around the selection | no |

Without the compiled three, nothing breaks: the modes become toggles, the applet's switch opens
disabled, and the dimming shows the selection instead of a line.

## Install

### From the KDE Store

"Get New Scripts" under System Settings → Window Management → KWin Scripts, and "Add Widgets" →
"Get New Widgets" on the panel. This installs the script, the effects and the applet. The three
compiled components are not distributable this way; use the script below for those.

### With the install script

Per user, no root:

```sh
git clone https://github.com/eduresser/kosmic
cd kosmic
./install.sh
```

It installs the two KPackages, the applet's icons into `hicolor` (without which the panel widget
shows a blank square), builds the compiled components when KWin's development headers are present,
starts `kosmic-stated`, and enables everything in `kwinrc`. `./install.sh --uninstall` reverses it.

Then **log out and back in**: on Wayland kglobalaccel lives inside `kwin_wayland` and reads the
shortcut file once, at the start of the session.

### Build dependencies

Only the three compiled components need these. The package that is most often missing is KWin's
own development headers.

| | |
|---|---|
| Arch, CachyOS, BigLinux | `pacman -S base-devel cmake extra-cmake-modules kwin qt6-base kconfig` |
| Fedora KDE | `dnf install cmake extra-cmake-modules kwin-devel qt6-qtbase-devel kf6-kconfig-devel` |
| openSUSE | `zypper install cmake extra-cmake-modules kwin6-devel qt6-base-devel kf6-kconfig-devel` |
| Debian, Ubuntu, Zorin | `apt install cmake extra-cmake-modules kwin-dev qt6-base-dev libkf6config-dev` |

`install.sh` skips the compiled half with a message when they are missing, and installs everything
else.

### Rebuilding after a KWin update

**`kosmic-chordhold` and `kosmic-outline` have to be rebuilt whenever KWin is updated.** They link
KWin's internal headers, which carry no binary compatibility — `effect/effect.h:967` says so — and
`kosmic-outline` goes further still and uses the scene graph. A plugin built against a different
KWin is refused by the compositor silently.

Re-run `./install.sh`; it records the KWin version it built against and says so when that changes.
On a rolling distribution this is a regular chore. The script, the effects and the applet are never
affected.

### Manual

```sh
kpackagetool6 --type KWin/Script  --install comp/script
kpackagetool6 --type KWin/Effect  --install comp/effect
kpackagetool6 --type KWin/Effect  --install comp/focusdim
kpackagetool6 --type Plasma/Applet --install applet
install -Dm644 applet/contents/icons/kosmic-tiling*.svg -t ~/.local/share/icons/hicolor/scalable/apps/
cmake -B build -DCMAKE_INSTALL_PREFIX=$HOME/.local -DINSTALL_PACKAGES=OFF
cmake --build build && cmake --install build
```

Then enable `kosmic-tilingEnabled`, `kosmic-tiling-animEnabled` and `kosmic-focusdimEnabled` under
`[Plugins]` in `kwinrc`, and `kosmic-chordholdEnabled` and `kosmic-outlineEnabled` if the plugins
were built.

## Shortcuts

Everything below is registered by the script itself and appears in System Settings → Shortcuts
under "KOSMIC". Rebind there; what is stored wins over what the script declares.

| Chord | Action |
|---|---|
| `Meta+Left` `Meta+Right` `Meta+Up` `Meta+Down` | Focus by direction |
| `Meta+H` `Meta+J` `Meta+K` `Meta+L` | the same, on the home row |
| `Meta+U` / `Meta+I` | Focus out to the group / back in |
| `Meta+Shift+` arrows or `HJKL` | Move the window by direction |
| `Meta+X` | Swap mode |
| `Meta+R` | Resize mode |
| `Meta+O` | Toggle orientation |
| `Meta+S` / `Meta+Shift+S` | Stack / dissolve the stack |
| `Meta+Comma` / `Meta+Period` | Previous / next in the stack |
| `Meta+Y` | Tiling on this workspace |
| `Meta+G` | Float this window |
| `Meta+Ctrl+` arrows or `HJKL` | Previous / next workspace |
| `Meta+Ctrl+Shift+` arrows or `HJKL` | Move the window to that workspace |
| `Meta+Shift+D` | Dump the layout tree to the journal |

With `kosmic-chordhold` installed, `Meta+X` and `Meta+R` are **held**: the mode lasts as long as
the chord is down and ends on release, which is what cosmic-comp does. Without it they are toggles
and a second press leaves the mode.

The keymap is `keybindings.json`, checked against a verbatim copy of COSMIC's own
`data/keybindings.ron` by the test suite — a chord upstream adds or moves fails the tests rather
than drifting quietly.

## Configuration

Everything is read from `kwinrc` at runtime. The panel applet carries the controls that have to
apply at once — tiling, the inner gap, the hint's thickness and colour, the default for new
workspaces. The two effects have their own dialogs under System Settings → Desktop Effects. The
rest is set by writing the keys:

```sh
kwriteconfig6 --file kwinrc --group Script-kosmic-tiling --key GapOuter 8
qdbus org.kde.KWin /KWin reconfigure
```

`settings.json` lists every key, its type and its default.

| `applet.enable` | `true` | The panel applet |
| `stateService.enable` | `applet.enable` | Run `kosmic-stated` |
| `debug` | `false` | Trace every geometry to the journal |

## Tests

```sh
tools/test.sh                              # everything below
node comp/tests/sim13.mjs comp/script/contents/code/kosmic-tiling.mjs keybindings.json
```

The suite runs 37 simulators against the tiler with fake windows, loads every module through the
real QJSEngine the way KWin does, lints the applet's QML, checks both effect dialogs, verifies the
keymap against COSMIC's `keybindings.ron`, checks that every default in `settings.json` still
matches the ones restated in C++ and in the applet, asserts the D-Bus interface names on both ends
of the outline contract, and runs `reuse lint`.

It compiles nothing — the three C++ components are `cmake`'s job. A check whose tool is missing is
skipped with a message; `KOSMIC_TEST_STRICT=1` turns every skip into a failure, which is what CI
sets.

`keymap.mjs` and the three `contents/config/main.xml` files are generated by `tools/gen.mjs` from
`keybindings.json` and `settings.json`, and are committed — a KWin script has no build step, so a
clone has to be a working package. Edit the sources, run `node tools/gen.mjs`, and the tests check
the committed copies still match.

## Licence

GPL-3.0-only, as `pop-os/shell` and `cosmic-comp` are, except for the applet's two state icons,
which are System76's under CC BY-SA 4.0 and are attributed in the files themselves. The tree is
[REUSE](https://reuse.software) compliant and the tests keep it that way.
