# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only

# KOSMIC: COSMIC's window management for KDE Plasma 6.
#
# COSMIC is System76's desktop environment, and the part of it this module follows is cosmic-comp,
# its compositor -- which is where COSMIC keeps tiling, since COSMIC Epoch has no shell extension
# layer to put it in. On KWin the nearest thing is a script, so that is what this is: the tiler plus
# two effects beside it: one animates the geometry it writes, and one dims every window outside the
# selection, which is how the selection is shown.
#
# The tree underneath is still the binary fork tree inherited from pop-os/shell, which COSMIC
# replaced with an N-ary group tree.
#
# GPL-3.0, as both pop-os/shell and cosmic-comp are.
{ config, lib, pkgs, ... }:

let
  cfg = config.programs.kosmic;
  b = v: if v then "true" else "false";

  # settings.json is the one source for both halves of the configuration: the kcfg entries the
  # script and the effects declare their defaults in, and the kwinrc keys this module writes. A
  # key on only one side would silently fall back to its default, and a default that differed
  # between the two would make a session installed through this module behave differently from one
  # installed by hand -- which is most of them.
  settings = builtins.fromJSON (builtins.readFile ./settings.json);

  settingEntries = lib.concatLists (lib.mapAttrsToList
    (_: c: lib.mapAttrsToList (key: e: e // { inherit key; }) c.entries)
    settings.components);

  # The default an option declares is the default its kcfg entry declares, read rather than
  # repeated. An option with no key in settings.json is one that has no kwinrc key either.
  dflt = path:
    let m = lib.filter (e: (e.option or "") == path) settingEntries;
    in if m == [ ]
       then throw "settings.json declares no key for programs.kosmic.${path}"
       else (lib.head m).default;

  # The value side: what the option is set to now, spelled the way kwinrc spells it.
  settingsOf = component:
    lib.mapAttrs
      (_: e: { value = let v = lib.getAttrFromPath (lib.splitString "." e.option) cfg;
                       in if lib.isBool v then b v else toString v; })
      settings.components.${component}.entries;

  ini = entries: lib.concatStringsSep "\n" (lib.mapAttrsToList (n: e: "${n}=${e.value}") entries);

  # ---- the keymap ----
  #
  # keybindings.json is the one copy every reader reads: this file, the module tools/gen.mjs
  # writes for the script, and the simulator that checks the whole thing against COSMIC's own
  # keybindings.ron. A chord spelled twice is a chord that drifts.
  #
  # The script gets a generated module rather than the JSON because a KWin script runs in
  # QJSEngine and cannot open a file.
  keymap = builtins.fromJSON (builtins.readFile ./keybindings.json);

  kosmicKeys =
    (lib.filter (e: e.owner or "" == "kosmic") keymap.bindings) ++ keymap.additions;

  # The names that must not hold a key, and the chordhold half is the load-bearing one: with the
  # toggle still registered on the chord, kglobalaccel matches it first and fires the toggle
  # alongside the gesture the plugin is holding. The script registers those names with a
  # placeholder of its own for the same reason, which is what makes the plugin work on an install
  # that has no kglobalshortcutsrc written for it; this is for the machine that already has entries
  # in that file, where the file wins over a QML default.
  #
  # The invoke-only names are the other half: they exist to be called by name, and carry a
  # placeholder chord only because ShortcutHandler will not register without a sequence.
  holdToggles = lib.filter (t: t != "")
    (map (m: (m.hold or { }).toggle or "") (lib.attrValues (keymap.modes or { })));
  silencedKeys =
    (lib.filter (e: e.invokeOnly or false) kosmicKeys)
    ++ lib.optionals cfg.chordHold.enable
      (lib.filter (e: lib.elem (e.handler or "") holdToggles) kosmicKeys);


  # ---- the swap-hold plugin ----
  #
  # The chord it watches comes from the same keybindings.json everything else does. Its *key* is
  # translated to an evdev scan code because a KWin plugin reads the keyboard below any layout:
  # the codes in linux/input-event-codes.h name *positions*, not letters. The table is QWERTY
  # positions, which is what the letters in keybindings.json mean; a chord using anything not in
  # it fails the build rather than producing a plugin that silently watches nothing.
  #
  # The *modifier* is deliberately not in the table: the plugin asks xkb whether the modifier is
  # held rather than watching a position, so every key the layout makes a Super answers it. A scan
  # code would watch one key and ignore every other the layout gives the same meaning, which is the
  # opposite of what has to run on any keyboard.
  scancodes = {
    Q = 16; W = 17; E = 18; R = 19; T = 20; Y = 21; U = 22; I = 23; O = 24; P = 25;
    A = 30; S = 31; D = 32; F = 33; G = 34; H = 35; J = 36; K = 37; L = 38;
    Z = 44; X = 45; C = 46; V = 47; B = 48; N = 49; M = 50;
  };
  modifierNames = [ "Meta" "Ctrl" "Alt" "Shift" ];

  codeOf = part:
    if scancodes ? ${part} then toString scancodes.${part}
    else throw "programs.kosmic.chordHold: no scan code known for '${part}'";

  # The modes that can be held, declared beside the mode itself in keybindings.json so that this
  # and the script cannot disagree about which chords the plugin takes over. Each names the handler
  # of its *toggle* -- that toggle is where the chord is written, and reading it from anywhere else
  # would let the two drift apart. The toggle then gives the chord up entirely, through
  # `silencedKeys` above: with it still registered, kglobalaccel would match the chord and fire the
  # toggle alongside the gesture.
  #
  # attrValues orders by mode name, which is what fixes each chord's index in the plugin's config.
  holdModes = map (m: m.hold) (lib.filter (m: m ? hold) (lib.attrValues keymap.modes));

  chordOfHandler = handler:
    let e = lib.findFirst (x: x.handler or "" == handler) null (keymap.bindings ++ keymap.additions);
    in if e == null
       then throw "programs.kosmic.chordHold: no '${handler}' binding in keybindings.json"
       else e.chord;

  # One modifier and one key, which is the only shape the plugin implements and the only shape
  # upstream's modes have. Anything else is a chord this cannot hold, and saying so here beats
  # finding out from a gesture that never arms.
  chordEntry = i: m:
    let
      chord = chordOfHandler m.toggle;
      parts = lib.splitString "+" chord;
      mods = lib.filter (p: lib.elem p modifierNames) parts;
      keys = lib.filter (p: !(lib.elem p modifierNames)) parts;
    in
    if lib.length mods != 1 || lib.length keys != 1
    then throw "programs.kosmic.chordHold: '${chord}' is not one modifier plus one key"
    else {
      "Modifier${toString i}" = { value = lib.head mods; };
      "Key${toString i}"      = { value = codeOf (lib.head keys); };
      "Arm${toString i}"      = { value = m.arm; };
      "Commit${toString i}"   = { value = m.commit; };
    };

  chordHoldSettings =
    { Count = { value = toString (lib.length holdModes); };
      Component = { value = "kwin"; };
    }
    // lib.foldl' (a: b: a // b) { } (lib.imap0 chordEntry holdModes);

  # Built by packages.nix, which the flake exposes directly as well.
  inherit (import ./packages.nix { inherit pkgs lib; })
    package applet chordHold outline stated;
in
{
  options.programs.kosmic = {
    enable = lib.mkEnableOption "KOSMIC, COSMIC's window management for KDE Plasma 6";

    debug = lib.mkOption {
      type = lib.types.bool;
      default = dflt "debug";
      description = ''
        Trace every geometry the layout writes, and every one it decides not to write, to the journal
        (`journalctl --user -b | grep kosmic-tiling`). Errors are reported there whether this is on or not.
      '';
    };

    tiling = {
      gaps = {
        inner = lib.mkOption { type = lib.types.ints.unsigned; default = dflt "tiling.gaps.inner"; description = "Gap between windows, in logical pixels."; };
        # Added to the inner gap on an outside edge, not used instead of it: cosmic-comp insets the
        # work area by `outer` and then gives every side of a window without a neighbour a whole
        # `inner`, so an edge is outer + inner wide and a seam between two windows is one inner.
        # The pair is upstream's -- cosmic-theme's `gaps: (0, 8)`, commented there as
        # "(outer, inner)" -- and 8 here would make the screen edge twice the gap between tiles.
        outer = lib.mkOption { type = lib.types.ints.unsigned; default = dflt "tiling.gaps.outer"; description = "Extra gap at the screen edges, on top of the inner gap, in logical pixels."; };
      };

      dropPreview = lib.mkOption {
        type = lib.types.bool;
        default = dflt "tiling.dropPreview";
        description = ''
          While a window is being dragged, lay out the slot it would land in for real, so its
          neighbours move as the pointer goes -- which is what COSMIC does. The placeholder is drawn
          by the script's own dialog, not by KWin's outline: that one opens a window on every call
          and flashes instead of staying put.
        '';
      };

      stacking = {
        tabBar = lib.mkOption {
          type = lib.types.bool;
          default = dflt "tiling.stacking.tabBar";
          description = ''
            Draw a tab bar over the top of a stacked slot, one tab per window, and take the decoration
            off the windows in it -- which is where KDE 4.4 put window tabs before Plasma 5 dropped them.
            Turning this off leaves the stack invisible; pair it with `osd`.
          '';
        };

        barHeight = lib.mkOption {
          type = lib.types.ints.positive;
          default = dflt "tiling.stacking.barHeight";
          description = "Height of the tab bar in logical pixels. The stacked windows give up this much of their slot.";
        };

        osd = lib.mkOption {
          type = lib.types.bool;
          default = dflt "tiling.stacking.osd";
          description = ''
            Show Plasma's on-screen display naming the window brought to the front of a stack, and its
            position in it. Redundant while the tab bar is on, and the fallback for when it is off.
          '';
        };
      };

      modeOsd = lib.mkOption {
        type = lib.types.bool;
        default = dflt "tiling.modeOsd";
        description = ''
          Show Plasma's on-screen display naming the keys a mode took, when a mode is armed.
          On because the keys are not upstream's and nothing else on the screen can say so:
          cosmic-comp's swap grab holds the seat's keyboard and matches a Focus binding on its
          key alone, so a bare arrow moves the selection there. A KWin script receives no key
          except through a registered chord, so the arrows keep their Meta here.
        '';
      };

      newWorkspaceTiled = lib.mkOption {
        type = lib.types.bool;
        default = dflt "tiling.newWorkspaceTiled";
        description = ''
          Whether a workspace that has just been created tiles. This is the default the session
          starts with; the panel applet carries the same control, where COSMIC keeps it, and what
          it writes to ~/.config/kwinrc wins over this until the key is removed there. The
          per-workspace toggle is a different thing and does not write this: that is Meta+Y and
          the applet's button.
        '';
      };

      animation = {
        enable = lib.mkOption { type = lib.types.bool; default = true; description = "Animate geometry changes of tiled windows."; };
        duration = lib.mkOption { type = lib.types.ints.positive; default = dflt "tiling.animation.duration"; description = "Animation duration in ms (scaled by Plasma's animation speed)."; };
      };

      disableScreenEdgeTiling = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Stop KWin offering to tile a window by half or by quarter when it is dragged to a screen edge
          (`ElectricBorderMaximize`, `ElectricBorderTiling`). It takes the drop away from KOSMIC, which
          has its own answer for where the window goes and has been showing it the whole drag.
        '';
      };

      unbindConflictingShortcuts = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Unbind the KDE shortcuts that collide with KOSMIC's keys (Quick Tile Meta+arrows,
          Grid View Meta+G, Lock Session Meta+L) as system-wide defaults. Existing per-user
          bindings in ~/.config/kglobalshortcutsrc take precedence.
        '';
      };
    };


    workspaces = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = dflt "workspaces.enable";
        description = ''
          Remove a workspace once its last window leaves and keep an empty one past the end, so
          workspaces are created by being walked into rather than by being configured. COSMIC binds
          a workspace to one output and matches it back to that monitor by name and EDID; KWin has
          no per-output virtual desktop, so here they stay global.

          This was a KWin script of its own; it is now a branch in the tiler, written to
          `[Script-kosmic-tiling] DynamicWorkspaces`. Turning it off leaves the two workspace keys
          bound and stepping through the desktops KDE already has, rather than handing the chords
          back to nothing.
        '';
      };
    };
    focusDim = {
      # What says which tile the keyboard is pointing at. It replaced an outline drawn by the
      # script -- COSMIC's own indicator, which cosmic-comp draws inside the compositor and a KWin
      # script cannot: an overlay from a script is an internal window, internal windows are in
      # OverlayLayer, and the line therefore crossed every menu that opened under it. Dimming is
      # applied to the windows themselves, so it has no stacking order to lose.
      #
      # Not KWin's own `diminactive`, which reads the active window and so cannot show a selected
      # *group* -- the thing Focus(Out) creates and the only reason an indicator is needed at all.
      # The module turns that one off; see the kwinrc below.
      enable = lib.mkOption {
        type = lib.types.bool;
        default = dflt "focusDim.enable";
        description = ''
          Dim every window outside the tiler's selection, which is how the selection is shown.
          Turning this off leaves nothing on the screen saying what the next resize or move will
          act on -- `Focus(Out)` selects a whole group without changing the active window --
          unless `outline.enable` is on, which says the same thing as a line.

          This also decides whether the tiler builds its marker window. A scripted effect cannot
          be told anything over D-Bus, so dimming only knows what the selection is by seeing a
          window moved over it; the `outline` plugin is told directly and needs no such window.
          The cost of that window is that KWin's Overview lists it, which no setting can prevent.
        '';
      };
      strength = lib.mkOption {
        type = lib.types.ints.between 0 100;
        default = dflt "focusDim.strength";
        description = ''
          How far an unselected window is dimmed, 0-100. One number for both attributes: brightness
          is `1 - strength/100` and saturation `1 - strength/200`, so colour drains at half the rate
          light does. Tune it without a rebuild first, then write the number you settled on here:

          ```
          kwriteconfig6 --file kwinrc --group Effect-kosmic-focusdim --key Strength N
          qdbus org.kde.KWin /Effects org.kde.kwin.Effects.reconfigureEffect kosmic-focusdim
          ```

          `qdbus org.kde.KWin /KWin reconfigure` does **not** work here, measured rather than
          assumed: it reaches the scripts but not the effects, because `reconfigureEffects()` is connected
          only to `Options::animationSpeedChanged` (`effecthandler.cpp:159`). Remember to delete
          the key from `~/.config/kwinrc` afterwards -- it outranks the one this module writes.
        '';
      };
      duration = lib.mkOption {
        type = lib.types.ints.unsigned;
        default = dflt "focusDim.duration";
        description = ''
          How long the fade takes, in milliseconds, before Plasma's global animation speed scales
          it. Shorter than the geometry animation on purpose: the selection should arrive before
          the layout has finished settling under it.
        '';
      };
    };
    # COSMIC's own indicator, taken back. The line cannot be drawn from the script side: a KWin
    # script can only draw by opening a window, and `belongsToLayer` answers
    # `if (isUnmanaged() || isInternal()) return OverlayLayer;` before it looks at a window type,
    # so the line sits above every menu that opens under it. `focusDim` exists because of that --
    # dimming is a compositing operation and has no stacking order to lose.
    #
    # A plugin has the door the script does not. KWin draws a decoration's own outline by putting
    # an `OutlinedBorderItem` in the scene graph (scene/decorationitem.cpp:466), rendered with a
    # dedicated antialiased, rounded-corner shader (`ShaderTrait::Border`,
    # scene/itemrenderer_opengl.cpp:271). `outline/` hangs one of those off the selected
    # window's own `WindowItem`, so the scene stacks the line exactly where that window is and a
    # menu opening above it covers it without either side knowing the other exists.
    #
    # The two learn what is selected in different ways, and that is a recent split. Both used to
    # read one window the tiler kept parked over the selected rect; the Overview listed it, because
    # every window a KWin script opens is a Normal window to the compositor and the Overview's
    # filter has no lever that reaches it. The plugin is C++ and can take a D-Bus call, so it does,
    # and the window is now built only when `focusDim` is on -- a scripted effect has no way to be
    # called. Either one can still run alone; with both on the window exists and the Overview shows
    # it, which is what the fallback costs.
    outline = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Draw COSMIC's active hint -- a line around the selected tile -- inside the compositor.

          This compiles a KWin plugin against the running compositor, and it uses the scene graph
          rather than the effects API: compositor internals, with no binary compatibility and no
          source compatibility either. A Plasma update that moves `OutlinedBorderItem` will fail
          `nixos-rebuild` until this is fixed, and turning it off is the whole fallback --
          `focusDim` says the same thing without compiling anything.

          Only the OpenGL renderer draws this. A software-rendered session gets no line and no
          error, which is the one failure here that is silent.
        '';
      };
      thickness = lib.mkOption {
        type = lib.types.ints.unsigned;
        default = dflt "outline.thickness";
        description = ''
          Width of the line in logical pixels. 3 is upstream's: cosmic-theme's `active_hint`,
          used as the outline width at `backend/render/mod.rs:801`.

          The line is drawn immediately outside the selected rect, which puts it in the gap
          around the slot -- where two neighbours' lines meet in the seam instead of overlapping.
          That holds while this is no more than half of `tiling.gaps.inner`; above that the lines
          of adjacent tiles meet, and where `tiling.gaps.outer` is 0 the line on a screen edge is
          drawn off it.
        '';
      };
      radius = lib.mkOption {
        type = lib.types.int;
        default = dflt "outline.radius";
        description = ''
          Corner radius of the line, in logical pixels. `-1` follows the corner the selected
          window itself has: `Window::borderRadius()`, which is the same number KWin rounds the
          window's own contents with (`scene/windowitem.cpp:246`). The radius a `BorderOutline`
          carries is the *inner* one, so the outer curve comes out one thickness wider on its own
          and the line stays concentric with the corner. Change the decoration's rounding and the
          line follows with nothing set here.

          The exception is a window with no server-side decoration -- VS Code, Vivaldi, most GTK
          applications. `updateDecorationBorderRadius` sets the radius to zero when `isDecorated()`
          is false, and Wayland has no protocol for a client to declare the corner it drew, so
          there is nothing to read: the line goes square around a window that may be rounded. Set
          a number here to force one for every window instead.
        '';
      };
      opacity = lib.mkOption {
        type = lib.types.ints.between 0 100;
        default = dflt "outline.opacity";
        description = "How opaque the line is, 0-100.";
      };
      color = lib.mkOption {
        type = lib.types.str;
        default = dflt "outline.color";
        example = "#3daee9";
        description = ''
          The line's colour, as `#rrggbb`, `#aarrggbb` or `r,g,b`. Empty is upstream's answer and
          the one to prefer: `cosmic-comp` resolves an unset hint to the theme's accent
          (`src/theme.rs:15`), so the line is the colour scheme's accent and moves with it. The
          plugin reads `AccentColor` from `kdeglobals`' General group first and the scheme's
          `Colors:Selection/BackgroundNormal` second, which between them is what
          `Kirigami.Theme.highlightColor` resolves to, and it watches that file -- so switching
          scheme recolours the line without a reload.

          Setting this freezes the line at one colour, exactly as `cosmic-settings` does when its
          "use theme accent" toggle is off. The applet writes the same key, so a session may
          diverge from what is declared here; the applet's undo arrow clears it back to empty.
        '';
      };
    };
    # The one piece of this module that is compiled, and the one thing that buys back COSMIC's
    # mode gestures.
    #
    # Upstream's Meta+X and Meta+R are holds: a mode ends the instant a modifier of the binding or
    # its key goes up, and whatever it owed runs on that same release (input/mod.rs:2407-2426 for
    # the swap). A KWin script is delivered an activation and never a release -- `registerShortcut`
    # is the whole of its key input -- so a chord there is a toggle and leaving it takes a second
    # press. Every door inside the scripting API was measured shut: no key state on a
    # ShortcutHandler, no keyboard call on a scripted effect, and no repeat stream to stand in for
    # a release, because the kernel and KWin both
    # repeat exactly one key.
    #
    # A toggle is not merely less faithful, it is a trap. A mode left armed outlives the work that
    # armed it, so the next Meta+R disarms when its user means to arm and the arrows move the focus
    # instead of resizing -- a state nobody can see, flipped by the only key that reports it, which
    # is indistinguishable from a broken key. Held, there is no state to get wrong.
    #
    # `chordhold/` is a KWin plugin that keeps the key *state* and calls the tiler's own
    # shortcuts by name -- KosmicSwapArm/KosmicResizeArm when a chord closes, and the matching
    # Commit or Release when it opens. The tiler still decides what a mode does; this only says
    # when it is on.
    chordHold = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = dflt "chordHold.enable";
        description = ''
          Make KOSMIC's mode chords holds, as COSMIC has them: `Meta+X` and `Meta+R` arm while
          they are down, the arrows act, and letting go of either key ends the mode -- trading, in
          the swap's case. Off, both are toggles: leaving a mode takes a second press, and a mode
          left armed silently changes what the arrows do until it is pressed again.

          This compiles a KWin plugin against the running compositor. KWin's plugin API provides
          no binary compatibility -- `effect/effect.h:967` says so -- which Nix turns into a build
          error rather than a silent refusal to load, but a Plasma update that changes the input
          API will fail `nixos-rebuild` until this is fixed. Turning it off is the whole fallback.

          While this is on, `KosmicSwapWindow` and `KosmicResize` give up their chords: the plugin
          must see the keys, so KWin cannot be holding a shortcut on them. The script registers
          those two names with an unpressable placeholder instead, which is what makes the gesture
          work on an install that has no shortcuts file written for it; this module writes the same
          `none` into kglobalshortcutsrc, for the session that already has entries there.
        '';
      };
    };

    # The panel applet, following cosmic-applets/cosmic-applet-tiling: a switch for tiling on the
    # focused workspace, the default for new ones, the three navigation chords read from
    # kglobalaccel, a switch for the active hint, and a way into KWin's script list.
    #
    # On by default, unlike the two compiled plugins. Those are off because they build against
    # KWin's plugin API, which has no binary compatibility; this is QML and a Plasma update can
    # only ever make it look wrong, not fail to build.
    #
    # Turning it off does not take it off the panel, and whatever manages the panel layout has to
    # read this option for that reason -- a panel still naming a widget that is no longer installed
    # shows a blank square.
    applet = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Install KOSMIC's panel applet: the popup cosmic-applet-tiling has, with the controls it
          has. The tiling switch acts on the focused workspace -- which with two monitors is not
          necessarily the one this panel is on -- and reads its state back through
          `stateService` below; the active-hint switch loads or unloads the effect and the plugin
          that draw it, neither of which outlives the session.
          The new-workspace control does: it writes `NewWorkspaceTiled` to ~/.config/kwinrc, which
          is read after the copy this module writes and therefore wins over
          `tiling.newWorkspaceTiled` above. The popup also carries the inner gap and the active
          hint's thickness and colour. The two effects have dialogs of their own under System
          Settings, Desktop Effects. Everything else -- the outer gap, the tab bar, the on-screen
          displays -- is set by the options here, or by writing the `[Script-kosmic-tiling]` group
          of kwinrc directly: the script carries no configuration dialog.
        '';
      };
    };

    # Separate from applet.enable, and visible, because it is the one thing KOSMIC adds to the
    # session that is a process rather than a plugin. Anyone who would rather not run it can say
    # so; the cost is that the applet's tiling switch greys out, which is what it is built to do
    # when nothing answers.
    stateService = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = cfg.applet.enable;
        defaultText = lib.literalExpression "config.programs.kosmic.applet.enable";
        description = ''
          Run `kosmic-stated`, the session service that holds which workspace is tiling so the
          panel applet can show it. The tiler pushes the value over D-Bus and the applet reads it
          back; nothing else uses it, and nothing in the window management depends on it. The
          value expires a few seconds after it is published, so a reading that comes back at all
          is one the tiler produced just then -- which is how the applet tells "tiling is off"
          from "the tiler is not running".
        '';
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.services.desktopManager.plasma6.enable;
        message = "programs.kosmic requires services.desktopManager.plasma6.enable";
      }
    ];

    environment.systemPackages = [ package ]
      ++ lib.optional cfg.chordHold.enable chordHold
      ++ lib.optional cfg.outline.enable outline
      ++ lib.optional cfg.applet.enable applet
      ++ lib.optional cfg.stateService.enable stated;

    # Started with the session rather than activated on demand, so the value is there to be
    # refreshed the first time anybody opens the popup. It owns a bus name, so a second copy would
    # answer nothing and exit; Restart covers the case where the first one died instead.
    systemd.user.services.kosmic-stated = lib.mkIf cfg.stateService.enable {
      description = "KOSMIC tiling state";
      partOf = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      wantedBy = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStart = lib.getExe stated;
        Restart = "on-failure";
        RestartSec = 2;
      };
    };

    # Qt validates its compiled-QML cache only by file mtime, and every file in the Nix store has the same mtime.
    # Without this KWin keeps loading a stale compiled copy of the script after each rebuild.
    systemd.user.services.plasma-kwin_wayland = {
      overrideStrategy = "asDropin";   # keep the unit shipped by Plasma (it has the ExecStart); only add to it
      environment.QML_DISABLE_DISK_CACHE = "1";
      path = lib.mkForce [ ];          # do not let NixOS inject its own PATH into the unit
    };

    # System-wide defaults (/etc/xdg); ~/.config/kwinrc still overrides.
    environment.etc."xdg/kwinrc".text = ''
      [Plugins]
      kosmic-tilingEnabled=true
      kosmic-tiling-animEnabled=${b cfg.tiling.animation.enable}
      kosmic-focusdimEnabled=${b cfg.focusDim.enable}
      kosmic-chordholdEnabled=${b cfg.chordHold.enable}
      kosmic-outlineEnabled=${b cfg.outline.enable}
      # Off unconditionally, and not an option. It dims by active window where focusdim dims by
      # selection, so the two do not disagree about *whether* to dim -- they disagree about what
      # is selected, and a window in a selected group would be dimmed by one and lit by the other.
      # Running both also multiplies the two brightness factors together. Anyone who wants KWin's
      # own can turn focusdim off and this one on in ~/.config/kwinrc, which is read after this.
      diminactiveEnabled=false

      [Script-kosmic-tiling]
      ${ini (settingsOf "kosmic-tiling")}

      [Effect-kosmic-tiling-anim]
      ${ini (settingsOf "kosmic-tiling-anim")}

      [Effect-kosmic-focusdim]
      ${ini (settingsOf "kosmic-focusdim")}

      # The chord the plugin watches -- its modifier by name, its key as an evdev scan code -- plus
      # the two shortcut names it calls. Derived from keybindings.json so the chord is spelled
      # once; a key with no scan code in the table fails the build rather than producing a plugin
      # that watches nothing. The modifier is a name because the plugin asks xkb whether it is
      # held, so whichever key the layout makes a Super arms the mode.
      [Plugin-kosmic-chordhold]
      ${ini chordHoldSettings}

      # The line around the selection. No kcfg beside it: a plugin has no `contents/config`, so
      # these are read straight out of this group, and the plugin carries the same defaults in C++
      # for anyone installing it without this module.
      [Plugin-kosmic-outline]
      ${ini (settingsOf "kosmic-outline")}

      [Windows]
      ElectricBorderMaximize=${b (!cfg.tiling.disableScreenEdgeTiling)}
      ElectricBorderTiling=${b (!cfg.tiling.disableScreenEdgeTiling)}
    '';

    # Two separate jobs in one group. The KOSMIC names are set to `none` so they do not hold a
    # key; the KDE names are the ones whose defaults collide with KOSMIC's. System-wide defaults
    # either way, and ~/.config/kglobalshortcutsrc still overrides.
    environment.etc."xdg/kglobalshortcutsrc".text =
      let
        silenced = map (e: "${e.name}=none,none,KOSMIC: ${e.text}") silencedKeys;
        conflicting = lib.optionals cfg.tiling.unbindConflictingShortcuts [
          "Grid View=none,none,Grid View"
          "Window Quick Tile Bottom=none,none,Quick Tile Window to the Bottom"
          "Window Quick Tile Left=none,none,Quick Tile Window to the Left"
          "Window Quick Tile Right=none,none,Quick Tile Window to the Right"
          "Window Quick Tile Top=none,none,Quick Tile Window to the Top"
        ];
        session = lib.optionals cfg.tiling.unbindConflictingShortcuts [
          ""
          "[ksmserver]"
          "Lock Session=none,none,Lock Session"
        ];
      in
      lib.concatStringsSep "\n" ([ "[kwin]" ] ++ silenced ++ conflicting ++ session) + "\n";
  };
}
