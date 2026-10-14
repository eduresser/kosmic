# What the NixOS module writes, checked without a NixOS machine to write it on.
#
# `nixosSystem` is evaluated, not built: reading `config.environment.etc` runs the module and
# everything it derives, which is where every mistake this can catch lives -- a group spelled
# wrong, a component whose [Plugins] key does not follow its option, a data file under install.d/
# that changed shape. Building the real system would add KWin, Plasma and the three C++
# components to a check that is about seven strings.
#
# The negative cases matter as much as the positive ones. The point of validating `settings`
# against settings.json is that a typo fails the build, and a check that only ever evaluates
# valid configurations would pass just as happily with the validation deleted.
{ self, nixpkgs, pkgs }:

let
  lib = nixpkgs.lib;

  # Everything a NixOS evaluation insists on having, and nothing else. None of it is read by the
  # module; it is here so that `config` can be evaluated at all.
  bare = {
    boot.loader.grub.enable = false;
    fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
    services.desktopManager.plasma6.enable = true;
    nixpkgs.hostPlatform = pkgs.stdenv.hostPlatform.system;
    system.stateVersion = lib.trivial.release;
  };

  eval = module: (nixpkgs.lib.nixosSystem {
    modules = [ self.nixosModules.default bare module ];
  }).config;

  on = eval {
    programs.kosmic.enable = true;
    programs.kosmic.components.kosmic-chordhold.enable = true;
    programs.kosmic.components.kosmic-outline.enable = true;
    programs.kosmic.components.kosmic-focusdim.enable = false;
    programs.kosmic.settings."Plugin-kosmic-outline".Thickness = 2;
  };

  off = eval { programs.kosmic.enable = false; };

  # `builtins.tryEval` only sees a `throw` once something forces it, which `deepSeq` does.
  fails = cfg: !(builtins.tryEval
    (builtins.deepSeq (eval cfg).environment.etc."xdg/kwinrc".text null)).success;

  kwinrc = on.environment.etc."xdg/kwinrc".text;
  shortcuts = on.environment.etc."xdg/kglobalshortcutsrc".text;

  expected = [
    # Each component's [Plugins] key follows its option, in both directions.
    "kosmic-tilingEnabled=true"
    "kosmic-chordholdEnabled=true"
    "kosmic-outlineEnabled=true"
    "kosmic-focusdimEnabled=false"
    "diminactiveEnabled=false"
    # The two keys that follow a component rather than a preference.
    "ChordHold=true"
    "SelectionMarker=false"
    # What the caller asked for, in the group settings.json puts it in.
    "[Plugin-kosmic-outline]"
    "Thickness=2"
    # The chord table, carried over verbatim from install.d/chordhold.ini.
    "[Plugin-kosmic-chordhold]"
    "Arm0=KosmicResizeArm"
    "ElectricBorderTiling=false"
  ];

  expectedShortcuts = [
    # A name that must hold no key, from install.d/silenced.txt.
    "KosmicSwapArm=none,none,KOSMIC: Arm the Swap (held chord)"
    # A `chordhold` row, which only applies with the plugin on.
    "KosmicSwapWindow=none,none,KOSMIC: Swap Window"
    # A KDE default whose chord KOSMIC claims, with the real default in the second field --
    # writing `none` there unbinds the key for one session and kglobalaccel puts it back.
    "Window Quick Tile Left=none,Meta+Left,Quick Tile Window to the Left"
    "[ksmserver]"
    "Lock Session=none,Meta+L,Lock Session"
  ];

  assertions = [
    { name = "the module writes nothing while it is off";
      ok = !(off.environment.etc ? "xdg/kwinrc"); }
    { name = "a group KOSMIC does not read fails the build";
      ok = fails { programs.kosmic.enable = true; programs.kosmic.settings."Effect-nope".Duration = 1; }; }
    { name = "a key KOSMIC does not read fails the build";
      ok = fails { programs.kosmic.enable = true; programs.kosmic.settings."Script-kosmic-tiling".Nope = 1; }; }
    { name = "a value of the wrong type fails the build";
      ok = fails { programs.kosmic.enable = true; programs.kosmic.settings."Script-kosmic-tiling".GapInner = true; }; }
    { name = "a chordhold row is left out while the plugin is off";
      ok = !(lib.hasInfix "KosmicSwapWindow"
        (eval { programs.kosmic.enable = true; }).environment.etc."xdg/kglobalshortcutsrc".text); }
    { name = "the conflicting defaults can be left alone";
      ok = !(lib.hasInfix "Quick Tile" (eval {
        programs.kosmic.enable = true;
        programs.kosmic.unbindConflictingShortcuts = false;
      }).environment.etc."xdg/kglobalshortcutsrc".text); }
  ]
  ++ map (s: { name = "kwinrc carries ${s}"; ok = lib.hasInfix s kwinrc; }) expected
  ++ map (s: { name = "kglobalshortcutsrc carries ${s}"; ok = lib.hasInfix s shortcuts; }) expectedShortcuts;

  failures = lib.filter (a: !a.ok) assertions;
in
{
  module = if failures != [ ]
  then throw ("the NixOS module does not write what it should:\n  "
    + lib.concatStringsSep "\n  " (map (a: a.name) failures))
  else pkgs.runCommand "kosmic-module-check" { } ''
    echo "${toString (lib.length assertions)} assertions passed" > $out
  '';
}
