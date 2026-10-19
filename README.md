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

https://github.com/user-attachments/assets/af1e7284-f01b-40ee-b9b8-1fb98c2ad793

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
  new ones, the gaps, and the hint's thickness, corner radius and colour

## What it runs on

Plasma 6 on Wayland, with a systemd user session. Any distribution shipping a KDE close to KDE's
own — Arch, CachyOS, BigLinux, Fedora KDE, openSUSE, Kubuntu, KDE Neon. Developed against Plasma
6.6 and tested in CI against KDE Neon.

**Supported: KWin 6.5 and later.** `kosmic-outline` needs `OutlinedBorderItem`, which first appears
in KWin 6.5.0. Older Plasma 6 is not a target: the KWin script, the two effects, the applet and
`kosmic-stated` install there, and are not verified on screen; `kosmic-outline` does not build and
`kosmic-chordhold` may not (see the note below). Plasma 5 is not supported at all.

Tested, each system at the Plasma its release ships, by building the three compiled components
from the commands `install.sh` prints, in a bare container:

- **All three build** on Arch Linux, openSUSE Tumbleweed and KDE Neon (KWin 6.7.5), Fedora 44 and
  Ubuntu 26.04 LTS (6.6), and, through the flake, NixOS 25.11 (6.5.6), 26.05 (6.6.6) and unstable
  (6.7.5).
- **Only `kosmic-stated` builds** on Debian 13 (6.3.6), Ubuntu 25.10 (6.4.5) and Fedora 43 (6.4.5),
  which are below the floor.
- **Not supported:** Plasma 5, which Debian 12 and Ubuntu 24.04 ship.

A distribution not listed is expected to work if it ships a KWin of 6.5 or later with its
development headers. Below the floor, updating Plasma and running `./install.sh` again is the way
up.

The compiled plugins only work with the exact KWin they were built against; see "Rebuilding after
a KWin update" below.

Three things are outside that and not pretended otherwise:

- **X11.** `kosmic-chordhold` reads the keyboard inside the Wayland compositor, and kglobalaccel
  behaves differently on the other session.
- **Sessions without systemd** (Artix, Devuan, Void). `kosmic-stated` is a `systemctl --user`
  unit, so the applet's tiling switch opens disabled; everything else works.
- **Atomic distributions** (Kinoite, Aeon, SteamOS). The KPackages install normally; the three
  compiled components need a container with KWin's development headers.

The applet needs nothing beyond what a Plasma session already guarantees. The two controls that
once came from `kirigami-addons` and `kdeclarative` are vendored under
`src/applet/contents/ui/vendor/`, so `org.kde.kirigami` is the only external QML import left.

## Components

Five pieces. The two QML packages work on their own; the three compiled ones add the parts a
KWin script cannot reach.

| Component | What | Needed for |
|---|---|---|
| `kosmic-tiling` | KWin script | everything |
| `io.github.eduresser.kosmic-tiling` | Plasma applet | the panel widget |
| `kosmic-tiling-anim`, `kosmic-focusdim` | KWin scripted effects | animation, dimming |
| `kosmic-stated` | session service (C++) | the applet's tiling switch reading its state |
| `kosmic-chordhold` | KWin plugin (C++) | `Meta+X` and `Meta+R` as **holds** rather than toggles |
| `kosmic-outline` | KWin plugin (C++) | the line around the selection |

Build the compiled three or do not — both are whole states, and `install.sh` picks one and
configures for it. Without them the mode chords are toggles rather than holds, the applet's switch
opens disabled, and the dimming shows the selection instead of a line. What is not a state is
building `kosmic-chordhold` without writing the chords it watches: the plugin then watches nothing
while the script has already given `Meta+X` and `Meta+R` up, and both modes become dead keys.
`install.sh` will not leave it there — `ChordHold` follows the configuration it wrote, not the
build it ran — and the manual route below has to write them too.

KOSMIC is installed from this repository with `install.sh`, not from the KDE Store: the compiled
components cannot be delivered that way, and the KWin plugins have to be built against the KWin
they will run in.

## Install

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

### On NixOS

`./install.sh` writes kwinrc, kglobalshortcutsrc and a user unit, and a NixOS configuration
generates all three from itself and replaces them on the next rebuild. So the flake carries the
same work as a module. It builds the compiled components against the KWin of *your* nixpkgs,
enables every component, writes their configuration, unbinds the KDE defaults whose chords KOSMIC
claims and runs `kosmic-stated`:

```nix
# flake.nix
inputs.kosmic.url = "github:eduresser/kosmic";
inputs.kosmic.inputs.nixpkgs.follows = "nixpkgs";   # the plugins must match your KWin

# configuration.nix
imports = [ inputs.kosmic.nixosModules.default ];

programs.kosmic.enable = true;
programs.kosmic.components.kosmic-chordhold.enable = true;   # the mode chords as holds
programs.kosmic.components.kosmic-outline.enable = true;     # the line around the selection
programs.kosmic.settings."Script-kosmic-tiling".GapInner = 8;
```

The `follows` line matters: without it the plugins are built for the KWin of this flake's pinned
nixpkgs and refused by yours. Rebuilding after a KWin update is then `nixos-rebuild`, not this
script.

`programs.kosmic.settings` takes KOSMIC's own kwinrc groups and is checked against `settings.json`:
a group, a key or a type KOSMIC does not read fails the build rather than writing a line nothing
reads. A key left out keeps the default the package carries. The two compiled components are off
by default and are switched off at the *build* when they are, so a Plasma update that breaks one
cannot break a rebuild that does not use it.

What the module deliberately leaves alone is the per-user half: the chords that go to KWin's own
actions (`install.d/assign.txt`) and the launcher shortcuts (`install.d/commands.txt`).
kglobalshortcutsrc is per-user state, and on NixOS it usually belongs to plasma-manager;
`programs.kosmic.keybindingsFile` points at this repository's keymap so those entries can be
generated from it rather than hand-copied.

Without the module, `./install.sh` still works and does the whole per-user half itself, but it
builds nothing -- the compiled components have to come from the package:

```nix
environment.systemPackages = [ inputs.kosmic.packages.${pkgs.stdenv.hostPlatform.system}.default ];
systemd.packages           = [ inputs.kosmic.packages.${pkgs.stdenv.hostPlatform.system}.default ];
```

Run on its own, `./install.sh` on NixOS prints those two lines. Built in a container against
nixpkgs 25.11 (KWin 6.5.6) and 26.05; the module is checked by `nix build
.#checks.x86_64-linux.module`, which asserts what it writes without needing a NixOS machine to
write it on. Not yet run on a NixOS session.

### Build dependencies

Only the three compiled components need these. The package that is most often missing is KWin's
own development headers.

`install.sh` checks for them before it writes anything and lists every one that is missing, with the
command for this distribution, so there is no need to find out one failed build at a time.

| | |
|---|---|
| Arch, CachyOS, BigLinux | `pacman -S base-devel cmake extra-cmake-modules vulkan-headers kwin qt6-base kconfig` |
| Fedora KDE | `dnf install gcc-c++ make cmake extra-cmake-modules kwin-devel qt6-qtbase-devel kf6-kconfig-devel libepoxy-devel libdrm-devel wayland-devel` |
| openSUSE | `zypper install gcc-c++ make cmake kf6-extra-cmake-modules kwin6-devel qt6-base-devel qt6-declarative-devel kf6-kconfig-devel kf6-kcoreaddons-devel kf6-kwindowsystem-devel libxkbcommon-devel` |
| KDE Neon | `apt install build-essential pkgconf cmake extra-cmake-modules kwin-dev qt6-base-dev kf6-kconfig-dev` |
| Debian, Ubuntu, Zorin | `apt install build-essential pkgconf cmake extra-cmake-modules kwin-dev qt6-base-dev libkf6config-dev libxkbcommon-dev libdrm-dev` |

`install.sh` builds the three components one at a time. One that cannot be built is skipped with a
message and a reason, and the others are installed regardless; `kosmic-outline` is skipped without
trying on a KWin older than 6.5.

**KWin below 6.5 and `kosmic-chordhold`.** On Debian 13 (6.3.6), Ubuntu 25.10 (6.4.5) and Fedora 43
(6.4.5) the installed `keyboard_input.h` includes `a11ykeyboardmonitor.h`, and the development
package does not install that header; Fedora 44 and Ubuntu 26.04, with KWin 6.6, do not have the
problem. Take it from a KWin 6.4 source tarball and pass its directory on the compiler flags:

```sh
mkdir -p ~/kwin-inc && curl -fsSL https://download.kde.org/stable/plasma/6.4.0/kwin-6.4.0.tar.xz \
  | tar -xJ --strip-components=2 -C ~/kwin-inc kwin-6.4.0/src/a11ykeyboardmonitor.h
CXXFLAGS="-I$HOME/kwin-inc" ./install.sh
```

The plugin only calls functions KWin exports, so the missing header's layout does not matter to it.

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
kpackagetool6 --type KWin/Script  --install src/comp/script
kpackagetool6 --type KWin/Effect  --install src/comp/effect
kpackagetool6 --type KWin/Effect  --install src/comp/focusdim
kpackagetool6 --type Plasma/Applet --install applet
install -Dm644 src/applet/contents/icons/kosmic-tiling*.svg -t ~/.local/share/icons/hicolor/scalable/apps/
cmake -B build -DCMAKE_INSTALL_PREFIX=$HOME/.local -DINSTALL_PACKAGES=OFF
cmake --build build && cmake --install build
```

Then enable `kosmic-tilingEnabled`, `kosmic-tiling-animEnabled` and `kosmic-focusdimEnabled` under
`[Plugins]` in `kwinrc`, and `kosmic-chordholdEnabled` and `kosmic-outlineEnabled` if the plugins
were built.

Two generated fragments still have to be applied, and skipping the first is what turns `Meta+X`
and `Meta+R` into dead keys:

```sh
# the chords kosmic-chordhold watches -- only if the plugin was built and enabled
awk -F= '/^\[/{g=substr($0,2,length($0)-2)} /^[A-Za-z]/{system("kwriteconfig6 --file kwinrc --group "g" --key "$1" "$2)}' \
  install.d/chordhold.ini
kwriteconfig6 --file kwinrc --group Script-kosmic-tiling --key ChordHold true

# the shortcut names that must not hold a key; drop the `chordhold` lines if it is not enabled
while IFS='|' read -r when component name label; do
  case "$when" in ''|'#'*) continue ;; esac
  kwriteconfig6 --file kglobalshortcutsrc --group "$component" --key "$name" "none,none,$label"
done < install.d/silenced.txt
```

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

`Meta+0` and `Meta+Shift+0` go to the last workspace and send the window there. The rest of the
COSMIC keymap that KDE can answer is answered by KDE, and `install.sh` gives it the chords:

| Chord | Action | Answered by |
|---|---|---|
| `Meta+Q` `Alt+F4` | Close | KWin "Window Close" |
| `Meta+M` / `Meta+F11` | Maximise / fullscreen | KWin |
| `Meta+1`…`Meta+9` | Go to that workspace | KWin "Switch to Desktop N" |
| `Meta+Shift+1`…`9` | Move the window there | KWin "Window to Desktop N" |
| `Meta+Alt+` arrows or `HJKL` | Go to the output in that direction | KWin "Switch to Screen …" |
| `Meta+Shift+Alt+` arrows or `HJKL` | Move the window to that output | KWin "Window One Screen …" |
| `Meta+Esc` / `Meta+Shift+Esc` | Lock / log out | ksmserver |
| `Meta+Space` | Next keyboard layout | the layout switcher |
| `Meta+W` | Overview | KWin |
| `Alt+Tab` `Meta+Tab` (+`Shift`) | Window switcher | KWin "Walk Through Windows" |
| `Meta+B` `Meta+F` `Meta+T` | Browser, home folder, terminal | command shortcuts |
| `Meta+/` `Meta+A` `Print` | Launcher (KRunner), application menu, screenshot | command shortcuts |

Whatever else held one of these chords is unbound, and `./install.sh --uninstall` puts it back. A
chord with Shift and a digit reaches KWin on Wayland as the symbol the layout gives it, so
`Meta+Shift+1` is also written as `Meta+!`; the symbols are a US layout's, and a layout that puts
something else there rebinds those in System Settings. The media, brightness and power keys are
left to Plasma, which binds them itself.

With `kosmic-chordhold` installed, `Meta+X` and `Meta+R` are **held**: the mode lasts as long as
the chord is down and ends on release, which is what cosmic-comp does. Without it they are toggles
and a second press leaves the mode.

The keymap is `keybindings.json`, checked against a verbatim copy of COSMIC's own
`data/keybindings.ron` by the test suite — a chord upstream adds or moves fails the tests rather
than drifting quietly.

## Configuration

Everything is read from `kwinrc` at runtime. The panel applet carries the controls that have to
apply at once — tiling, the inner gap, the hint's thickness, corner radius and colour, the default for new
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
node src/comp/tests/sim13.mjs src/comp/script/contents/code/kosmic-tiling.mjs keybindings.json
```

The suite runs 37 simulators against the tiler with fake windows, loads every module through the
real QJSEngine the way KWin does, lints the applet's QML, checks both effect dialogs, verifies the
keymap against COSMIC's `keybindings.ron`, checks that every default in `settings.json` still
matches the ones restated in C++ and in the applet, asserts the D-Bus interface names on both ends
of the outline contract.

It compiles nothing — the three C++ components are `cmake`'s job. A check whose tool is missing is
skipped with a message; `KOSMIC_TEST_STRICT=1` turns every skip into a failure, which is what CI
sets.

`keymap.mjs` and the three `contents/config/main.xml` files are generated by `tools/gen.mjs` from
`keybindings.json` and `settings.json`, and are committed — a KWin script has no build step, so a
clone has to be a working package. Edit the sources, run `node tools/gen.mjs`, and the tests check
the committed copies still match.

## Licence

GPL-3.0-only, as `pop-os/shell` and `cosmic-comp` are, except for the applet's two state icons,
which are System76's under CC BY-SA 4.0 and are attributed in the files themselves.
