# KOSMIC's NixOS module: the declarative half of install.sh.
#
# This is one install path of three and not the project's centre of gravity. `install.sh` is what
# a KDE user runs, the KDE Store delivers the same packages by copying, and this exists because a
# NixOS configuration cannot use either: the files it would write -- kwinrc, kglobalshortcutsrc, a
# user unit -- are generated from the configuration at build time and replaced on every rebuild,
# so a script that writes them imperatively is overwritten by the next `nixos-rebuild`.
#
# It therefore writes exactly what `install.sh` writes under "enabling", and from the same files:
# the kcfg defaults and the keymap are already in the package, `install.d/chordhold.ini` is the
# chord table verbatim, `install.d/silenced.txt` is the list of names that must hold no key, and
# `install.d/conflicting.txt` is KDE's own defaults whose chords KOSMIC claims. Nothing here
# restates data that lives somewhere else in this repository, which is what keeps the two install
# paths from drifting apart.
#
# What it deliberately leaves alone is the per-user half: `install.d/assign.txt` (the chords that
# go to KWin's own actions) and `install.d/commands.txt` (the launcher shortcuts). On NixOS those
# belong to whatever writes kglobalshortcutsrc for the user -- plasma-manager, usually -- and that
# file is per-user state a system module has no business owning. `programs.kosmic.keybindingsFile`
# is here so such a configuration can generate them from this repository's own keymap.
{ self }:

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.kosmic;
  b = v: if v then "true" else "false";

  # Every configuration key KOSMIC reads, with its type, as settings.json declares it. `group` is
  # the kwinrc group the component reads it from, which is what `settings` below is keyed by.
  schema = lib.mapAttrs'
    (_: c: lib.nameValuePair c.group (lib.mapAttrs (_: e: e.type) c.entries))
    (lib.importJSON "${self}/settings.json").components;

  typeCheck = { Bool = lib.isBool; Int = lib.isInt; String = lib.isString; };

  # A wrong group, a wrong key or a wrong type fails the build instead of landing in kwinrc as a
  # line nothing reads. kconfig has no notion of an unknown key, so without this the only symptom
  # of a typo is the setting silently keeping its default.
  render = group: key: value:
    let
      keys = schema.${group} or (throw
        "programs.kosmic.settings: KOSMIC reads no group '${group}' (${lib.concatStringsSep ", " (lib.attrNames schema)})");
      type = keys.${key} or (throw
        "programs.kosmic.settings.\"${group}\": KOSMIC reads no key '${key}' (${lib.concatStringsSep ", " (lib.attrNames keys)})");
    in
    if !(typeCheck.${type} value)
    then throw "programs.kosmic.settings.\"${group}\".${key}: KOSMIC declares this ${type}"
    else if type == "Bool" then b value
    else toString value;

  iniGroup = name: entries: lib.optionalString (entries != { }) ''

    [${name}]
    ${lib.concatStringsSep "\n" (lib.mapAttrsToList (k: v: "${k}=${render name k v}") entries)}
  '';

  # The install.d/ data files, which carry comments and blank lines for the human reading them.
  rows = file: lib.filter (l: l != "" && !(lib.hasPrefix "#" l))
    (map (lib.removeSuffix "\r") (lib.splitString "\n" (builtins.readFile "${self}/install.d/${file}")));

  field = n: parts: lib.elemAt parts n;

  # <when>|<component>|<name>|<friendly name>: the shortcut names that must hold no key. The
  # script registers unpressable placeholders for these, and kglobalshortcutsrc wins over what a
  # script declares, so on a machine that has ever been written for KOSMIC the file has to say so
  # too. A `chordhold` row applies only where the plugin took the chord over.
  silenced = map (l: let p = lib.splitString "|" l; in {
    when = field 0 p; component = field 1 p; name = field 2 p; label = field 3 p;
  }) (rows "silenced.txt");

  # <component>:<key>:<friendly name>:<default chord>. The fourth field is load-bearing: see the
  # file's own header -- kglobalaccel resets a shortcut whose stored default differs from the one
  # the component registers, so `none,none,...` unbinds a key for exactly one session.
  conflicting = map (l: let p = lib.splitString ":" l; in {
    component = field 0 p; key = field 1 p; label = field 2 p; default = field 3 p;
  }) (rows "conflicting.txt");

  chordHold = cfg.components.kosmic-chordhold.enable;

  # Two keys that follow a component rather than a preference, which is why they are defaults here
  # and not left to the caller:
  #
  # ChordHold is what makes the tiler stand its own Meta+X and Meta+R toggles down and register
  # them on unpressable placeholders instead. The plugin has to *see* those keys -- it sits after
  # InputFilterOrder::GlobalShortcut -- so with the plugin loaded and this off, the toggle fires
  # alongside the gesture; with this on and the plugin absent, both modes are dead keys.
  #
  # SelectionMarker builds the window focusdim reads the selection from. A scripted effect cannot
  # be told anything over D-Bus, so dimming only learns what is selected by seeing a window parked
  # over it; the outline plugin takes a call instead and needs no such window. With focusdim off
  # the marker is a window KWin's Overview lists for nothing, and no filter can be asked to skip
  # it -- every window a KWin script opens is a Normal window to the compositor.
  settings = lib.recursiveUpdate
    {
      "Script-kosmic-tiling" = {
        ChordHold = chordHold;
        SelectionMarker = cfg.components.kosmic-focusdim.enable;
      };
    }
    cfg.settings;

  # The six things KWin has to be told to load, by the name it loads them under: `<name>Enabled`
  # in kwinrc's [Plugins] is the key, so the attribute is spelled the way the key is and there is
  # no table in between.
  #
  # The compiled plugins are off by default, unlike the rest. They build against KWin's plugin
  # API, which provides no binary compatibility -- effect/effect.h:967 says so -- and outline goes
  # further and uses the scene graph, which is internals rather than an API. On NixOS that is a
  # failed `nixos-rebuild` rather than a plugin the compositor silently refuses to load, and
  # turning the component off is the whole fallback.
  components = {
    kosmic-tiling = {
      default = true;
      description = "The tiler: the KWin script that lays the windows out.";
    };
    kosmic-tiling-anim = {
      default = true;
      description = "Animate the geometry the tiler writes.";
    };
    kosmic-focusdim = {
      default = true;
      description = "Dim every window outside the tiler's selection, which is how the selection is shown.";
    };
    kosmic-outline = {
      default = false;
      description = ''
        Draw COSMIC's active hint -- a line around the selection -- inside the compositor. Compiled
        against KWin's scene graph, which carries neither binary nor source compatibility, so a
        Plasma update that moves `OutlinedBorderItem` fails the build until this is fixed. Only the
        OpenGL renderer draws it: a software-rendered session gets no line and no error.
      '';
    };
    kosmic-chordhold = {
      default = false;
      description = ''
        Make the mode chords holds, as COSMIC has them: Meta+X and Meta+R arm while they are down
        and end on the release, trading in the swap's case. Compiled against KWin's input API.
        Off, both are toggles, and a mode left armed silently changes what the arrows do.
      '';
    };
    kosmic-swipe = {
      default = false;
      description = ''
        Make the empty workspace past the first or last one when the touchpad's three- or
        four-finger swipe reaches for it, as the keys do. Compiled against KWin's input API. Off,
        the swipe stops at the first and last workspace.
      '';
    };
  };
in
{
  options.programs.kosmic = {
    enable = lib.mkEnableOption "KOSMIC, COSMIC's window management for KDE Plasma 6";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (old: {
        # The components that are off are switched off at the build, not merely left unloaded.
        # That is what keeps a KWin update breaking `kosmic-outline` from breaking a rebuild of a
        # configuration that does not use it.
        cmakeFlags = (old.cmakeFlags or [ ]) ++ [
          (lib.cmakeBool "BUILD_CHORDHOLD" cfg.components.kosmic-chordhold.enable)
          (lib.cmakeBool "BUILD_OUTLINE" cfg.components.kosmic-outline.enable)
          (lib.cmakeBool "BUILD_SWIPE" cfg.components.kosmic-swipe.enable)
          (lib.cmakeBool "BUILD_STATED" cfg.stateService.enable)
        ];
      });
      defaultText = lib.literalExpression
        "kosmic.packages.\${system}.default, with the disabled components switched off at the build";
      description = "The KOSMIC package: the tiler, the two effects, the applet and the compiled components.";
    };

    components = lib.mapAttrs
      (_: c: {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = c.default;
          description = c.description;
        };
      })
      components;

    stateService.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Run `kosmic-stated`, the session service that holds which workspace is tiling so the panel
        applet can show it. The tiler pushes the value over D-Bus and the applet reads it back;
        nothing in the window management depends on it, and without it the applet's tiling switch
        greys out -- which is what it is built to do when nothing answers.
      '';
    };

    unbindConflictingShortcuts = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Unbind the KDE shortcuts whose chords KOSMIC claims -- Quick Tile on Meta+arrows, Switch
        One Desktop on Meta+Ctrl+arrows, Grid View on Meta+G, Lock Session on Meta+L and the rest
        of `install.d/conflicting.txt` -- as system-wide defaults in /etc/xdg. An entry in the
        user's own kglobalshortcutsrc is read after this and wins, so a chord moved deliberately
        stays where it was put.

        Off, a stock Plasma keeps most of the keys COSMIC's map wants and the matching KOSMIC
        chords never arrive.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf (lib.types.oneOf [
        lib.types.bool
        lib.types.int
        lib.types.str
      ]));
      default = { };
      example = lib.literalExpression ''
        {
          "Script-kosmic-tiling".GapInner = 8;
          "Plugin-kosmic-outline".Thickness = 2;
        }
      '';
      description = ''
        KOSMIC's own kwinrc groups, written to /etc/xdg/kwinrc. Every key, its type and its
        default are declared in the package's `settings.json`, which this is checked against: a
        group, a key or a type KOSMIC does not read fails the build. A key left out keeps the
        default the package carries, so only what differs belongs here.

        ~/.config/kwinrc is read after this and wins over it, which is how the panel applet's own
        controls outrank what is declared here until the key is removed there.
      '';
    };

    keybindingsFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = "${self}/keybindings.json";
      defaultText = lib.literalExpression "\${kosmic}/keybindings.json";
      description = ''
        KOSMIC's keymap: every chord it owns, the mode each one belongs to, and the COSMIC action
        it comes from. Read-only, and here for a configuration that writes kglobalshortcutsrc
        itself -- plasma-manager, typically -- which is the half of `install.sh` this module does
        not do. Generating those entries from this file is what keeps them from drifting from the
        shortcuts the script registers.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.services.desktopManager.plasma6.enable;
        message = "programs.kosmic requires services.desktopManager.plasma6.enable";
      }
    ];

    environment.systemPackages = [ cfg.package ];

    # Started with the session rather than activated on demand, so the value is there to be
    # refreshed the first time anybody opens the popup. The package ships this unit as well; it is
    # restated here because NixOS does not act on the [Install] section of a user unit that
    # arrives through `systemd.packages`, so taken from there it would be installed and never
    # started.
    systemd.user.services.kosmic-stated = lib.mkIf cfg.stateService.enable {
      description = "KOSMIC tiling state";
      partOf = [ "graphical-session.target" ];
      after = [ "graphical-session.target" ];
      wantedBy = [ "graphical-session.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStart = lib.getExe' cfg.package "kosmic-stated";
        Restart = "on-failure";
        RestartSec = 2;
      };
    };

    # Qt validates its compiled-QML cache by file mtime, and every file in the Nix store carries
    # the same one. Without this KWin keeps loading a stale compiled copy of the script after each
    # rebuild -- a change that appears to do nothing at all, which is the most expensive kind.
    systemd.user.services.plasma-kwin_wayland = {
      overrideStrategy = "asDropin";   # keep the unit Plasma ships (it has the ExecStart); only add to it
      environment.QML_DISABLE_DISK_CACHE = "1";
      path = lib.mkForce [ ];          # do not let NixOS inject its own PATH into the unit
    };

    # System-wide defaults. ~/.config/kwinrc is read after this and still overrides.
    environment.etc."xdg/kwinrc".text = ''
      [Plugins]
      ${lib.concatStringsSep "\n"
        (map (n: "${n}Enabled=${b cfg.components.${n}.enable}") (lib.attrNames components))}
      # Off unconditionally, and not an option. KWin's own dims by active window where focusdim
      # dims by the tiler's selection, so the two do not disagree about *whether* to dim -- they
      # disagree about what is selected, and a window in a selected group would be dimmed by one
      # and lit by the other. Running both also multiplies the two brightness factors together.
      # ~/.config/kwinrc is read after this for anyone who wants the opposite.
      diminactiveEnabled=false
      ${lib.concatStrings (lib.mapAttrsToList iniGroup settings)}
      # The chords kosmic-chordhold watches, verbatim from install.d/chordhold.ini: each modifier
      # by name, each key as an evdev scan code, and the two shortcut names the plugin calls as a
      # chord closes and opens. Generated from keybindings.json, which is where the tiler's copy of
      # those chords comes from too, so the plugin and the script cannot disagree about the keys.
      # Its own header follows.
      ${builtins.readFile "${self}/install.d/chordhold.ini"}
      # KWin's edge tiling takes the drop away from KOSMIC, which has its own answer for where a
      # dragged window goes and has been showing it for the whole drag.
      [Windows]
      ElectricBorderMaximize=false
      ElectricBorderTiling=false
    '';

    # Written in /etc/xdg rather than the user's own file, which is the whole reason a module can
    # do this at all: kglobalshortcutsrc is per-user state that the session rewrites, and a
    # defaults file is the one copy a system configuration owns outright.
    environment.etc."xdg/kglobalshortcutsrc".text =
      let
        rowsFor = component:
          (map (e: "${e.name}=none,none,${e.label}")
            (lib.filter (e: e.component == component && (e.when == "always" || chordHold)) silenced))
          ++ lib.optionals cfg.unbindConflictingShortcuts
            (map (e: "${e.key}=none,${e.default},${e.label}")
              (lib.filter (e: e.component == component) conflicting));
        componentNames = lib.unique ((map (e: e.component) silenced)
          ++ lib.optionals cfg.unbindConflictingShortcuts (map (e: e.component) conflicting));
      in
      lib.concatStringsSep "\n" (map
        (c: ''
          [${c}]
          ${lib.concatStringsSep "\n" (rowsFor c)}
        '')
        (lib.filter (c: rowsFor c != [ ]) componentNames));
  };
}
