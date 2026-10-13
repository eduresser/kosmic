# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only

# The five things KOSMIC installs.
#
# None of them reads configuration: the packages carry none, and everything is read at runtime from
# kwinrc -- which is what any other way of installing this would use. They are out here rather than
# inside the NixOS module so that `nix build .#outline` does not have to evaluate a whole system,
# and so that the module and the flake cannot describe two different builds.
{ pkgs, lib ? pkgs.lib }:

{
  chordHold = pkgs.stdenv.mkDerivation {
    pname = "kosmic-chordhold";
    version = "0.1.0";
    src = ./chordhold;
    nativeBuildInputs = [ pkgs.cmake pkgs.pkg-config pkgs.kdePackages.extra-cmake-modules pkgs.kdePackages.wrapQtAppsHook ];
    buildInputs = [ pkgs.kdePackages.kwin pkgs.kdePackages.kconfig pkgs.kdePackages.qtbase ];
    meta = {
      description = "KWin plugin that makes KOSMIC's swap chord a held gesture";
      license = lib.licenses.gpl3Only;
      platforms = lib.platforms.linux;
    };
  };

  # The second compiled component, and the one that reaches furthest in. chordhold uses the input
  # API; this one uses the scene graph -- `OutlinedBorderItem`, the item KWin builds for a
  # decoration's own outline (scene/decorationitem.cpp:466) and renders with `ShaderTrait::Border`
  # (scene/itemrenderer_opengl.cpp:271). That is compositor internals, not an exported API, so it
  # is the first thing a Plasma update will break. Nix turns that into a build failure here.
  outline = pkgs.stdenv.mkDerivation {
    pname = "kosmic-outline";
    version = "0.1.0";
    src = ./outline;
    nativeBuildInputs = [ pkgs.cmake pkgs.pkg-config pkgs.kdePackages.extra-cmake-modules pkgs.kdePackages.wrapQtAppsHook ];
    buildInputs = [ pkgs.kdePackages.kwin pkgs.kdePackages.kconfig pkgs.kdePackages.qtbase ];
    meta = {
      description = "KWin plugin that draws COSMIC's active hint inside the compositor";
      license = lib.licenses.gpl3Only;
      platforms = lib.platforms.linux;
    };
  };
  # No reference to cfg: the package is the same store path whatever the options say.
  package = pkgs.stdenvNoCC.mkDerivation {
    pname = "kosmic-kwin";
    version = "0.1.0";
    dontUnpack = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/kwin/scripts $out/share/kwin/effects
      cp -r ${./comp/script} $out/share/kwin/scripts/kosmic-tiling
      cp -r ${./comp/effect} $out/share/kwin/effects/kosmic-tiling-anim
      cp -r ${./comp/focusdim} $out/share/kwin/effects/kosmic-focusdim
      chmod -R u+w $out/share/kwin
      runHook postInstall
    '';
    meta = {
      description = "COSMIC's window management for KWin 6";
      # GPL-3.0, as pop-os/shell and cosmic-comp are. The workspace policy arrived under MIT from
      # an unrecorded source and used to be a package of its own with that licence; folded into
      # the tiler it is GPL-3.0 like the rest, and the notice stays at the code.
      license = lib.licenses.gpl3Only;
      platforms = lib.platforms.linux;
    };
  };

  # The third compiled component, and the only one that is not a KWin plugin -- a session service
  # that holds one value. It is here because of a measured gap: which workspace tiles is decided
  # inside the KWin script and a KWin script can publish nothing, so the applet's "Tile current
  # workspace" had no state to show and was a button where upstream has a toggler.
  #
  # The two other ways to close that gap were a KWin plugin, which would have put the applet's
  # switch behind an API with no binary compatibility, and a no-op scripted effect used as a bit,
  # which would have put an effect load on the workspace-change path that the animation work
  # already showed to be sensitive. This links against QtCore and QtDBus and nothing else, so a
  # Plasma update cannot reach it, and it costs one idle process.
  stated = pkgs.stdenv.mkDerivation {
    pname = "kosmic-stated";
    version = "0.1.0";
    src = ./state;
    nativeBuildInputs = [ pkgs.cmake pkgs.pkg-config pkgs.kdePackages.wrapQtAppsHook ];
    buildInputs = [ pkgs.kdePackages.qtbase ];
    meta = {
      description = "Session service holding KOSMIC's tiling state for the panel applet";
      license = lib.licenses.gpl3Only;
      platforms = lib.platforms.linux;
      mainProgram = "kosmic-stated";
    };
  };

  # The panel applet, following cosmic-applets/cosmic-applet-tiling. Its own derivation rather than
  # a directory inside `package` for the same reason chordhold and outline have theirs: it is
  # optional, and `package` is deliberately the same store path whatever the options say.
  #
  # Nothing is generated into it. It reads the chords from kglobalaccel and the state from KWin's
  # own D-Bus properties at run time, which is what lets it be installed by something other than
  # this module -- the property the rest of / already keeps.
  applet = pkgs.stdenvNoCC.mkDerivation {
    pname = "kosmic-applet";
    version = "0.1.0";
    dontUnpack = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/share/plasma/plasmoids
      cp -r ${./applet} $out/share/plasma/plasmoids/io.github.eduresser.kosmic-tiling
      chmod -R u+w $out/share/plasma

      # The same file twice, and both copies earn their place. The one inside the package keeps the
      # plasmoid self-contained; the one in hicolor is what makes the *name* resolve, which is what
      # metadata.json and Plasmoid.icon both use -- a plasmoid's own directory is not on the icon
      # theme's search path, and an icon given as a path skips the recolouring that makes it
      # visible on a dark panel.
      #
      # Three of them, which is upstream's count and upstream's division of labour: the plain one
      # names the applet and never appears in the bar, and the pair is what the bar swaps between
      # as the workspace tiles or does not (cosmic-applet-tiling/src/window.rs:246).
      for icon in kosmic-tiling-symbolic kosmic-tiling-on-symbolic kosmic-tiling-off-symbolic; do
        install -Dm444 ${./applet/contents/icons}/$icon.svg \
          $out/share/icons/hicolor/scalable/apps/$icon.svg
      done
      runHook postInstall
    '';
    meta = {
      description = "Panel applet for KOSMIC, following COSMIC's tiling applet";
      # The pair of state icons is System76's under CC BY-SA 4.0, declared in the originals' own
      # metadata and attributed in the files here. Creative Commons grants a one-way
      # compatibility from CC BY-SA 4.0 to GPLv3, so the adaptation ships under the GPL with that
      # attribution kept; both licences are named because only one of them is this module's.
      license = [ lib.licenses.gpl3Only lib.licenses.cc-by-sa-40 ];
      platforms = lib.platforms.linux;
    };
  };
}
