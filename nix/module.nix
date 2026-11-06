# NixOS rebuilds overwrite kwinrc/kglobalshortcutsrc, so install.sh's "enabling" half is declared
# here from the same install.d/ files; the per-user shortcuts are left to plasma-manager.
{ self }:

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.kosmic;
  b = v: if v then "true" else "false";

  schema = lib.mapAttrs'
    (_: c: lib.nameValuePair c.group (lib.mapAttrs (_: e: e.type) c.entries))
    (lib.importJSON "${self}/settings.json").components;

  typeCheck = { Bool = lib.isBool; Int = lib.isInt; String = lib.isString; };

  # kconfig ignores unknown keys, so a typo would otherwise silently keep the default.
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

  rows = file: lib.filter (l: l != "" && !(lib.hasPrefix "#" l))
    (map (lib.removeSuffix "\r") (lib.splitString "\n" (builtins.readFile "${self}/install.d/${file}")));

  field = n: parts: lib.elemAt parts n;

  # <when>|<component>|<name>|<friendly name>; kglobalshortcutsrc wins over what the script declares.
  silenced = map (l: let p = lib.splitString "|" l; in {
    when = field 0 p; component = field 1 p; name = field 2 p; label = field 3 p;
  }) (rows "silenced.txt");

  # <component>:<key>:<friendly name>:<default chord>. kglobalaccel resets a shortcut whose stored
  # default differs from the registered one, so `none,none,...` unbinds for one session only.
  conflicting = map (l: let p = lib.splitString ":" l; in {
    component = field 0 p; key = field 1 p; label = field 2 p; default = field 3 p;
  }) (rows "conflicting.txt");

  chordHold = cfg.components.kosmic-chordhold.enable;

  # Must track the components: ChordHold without the plugin leaves both modes as dead keys, and
  # SelectionMarker without focusdim is a stray window in Overview.
  settings = lib.recursiveUpdate
    {
      "Script-kosmic-tiling" = {
        ChordHold = chordHold;
        SelectionMarker = cfg.components.kosmic-focusdim.enable;
      };
    }
    cfg.settings;

  # Attribute names are kwinrc's `<name>Enabled` keys. Compiled plugins default off: KWin's plugin
  # API has no binary compatibility, and on NixOS a break fails `nixos-rebuild`.
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
        # Disabled components are not built, so a KWin update breaking one cannot break the rebuild.
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

    # Restated: NixOS ignores [Install] of user units from `systemd.packages`, so it would never start.
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

    # Qt validates its QML cache by mtime, which is constant in the Nix store: stale script after rebuild.
    systemd.user.services.plasma-kwin_wayland = {
      overrideStrategy = "asDropin";   # keep the unit Plasma ships (it has the ExecStart); only add to it
      environment.QML_DISABLE_DISK_CACHE = "1";
      path = lib.mkForce [ ];          # do not let NixOS inject its own PATH into the unit
    };

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
      # The desktop-switch slide moves the wallpaper too, and a translucent window over a moving
      # wallpaper comes out lighter than it settles at once the slide lands. Only the windows slide.
      [Effect-slide]
      SlideBackground=false
    '';

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
