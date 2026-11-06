# Evaluated, not built: config.environment.etc exercises the whole module without KWin or Plasma.
# The negative cases guard the settings validation; valid-only inputs would pass with it deleted.
{ self, nixpkgs, pkgs }:

let
  lib = nixpkgs.lib;

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
    programs.kosmic.components.kosmic-swipe.enable = true;
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
    "kosmic-tilingEnabled=true"
    "kosmic-chordholdEnabled=true"
    "kosmic-outlineEnabled=true"
    "kosmic-swipeEnabled=true"
    "kosmic-focusdimEnabled=false"
    "diminactiveEnabled=false"
    "ChordHold=true"
    "SelectionMarker=false"
    "[Plugin-kosmic-outline]"
    "Thickness=2"
    "[Plugin-kosmic-chordhold]"
    "Arm0=KosmicResizeArm"
    "ElectricBorderTiling=false"
    "[Effect-slide]"
    "SlideBackground=false"
  ];

  expectedShortcuts = [
    "KosmicSwapArm=none,none,KOSMIC: Arm the Swap (held chord)"
    "KosmicSwapWindow=none,none,KOSMIC: Swap Window"
    # Real default in the second field: `none` there unbinds for one session only.
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
