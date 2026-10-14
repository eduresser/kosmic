{
  description = "KOSMIC: COSMIC's window management for KDE Plasma 6";

  # KWin's plugin API has no binary compatibility, so chordhold and outline are built against the
  # KWin of the nixpkgs that is evaluating this. A configuration that imports this flake has to
  # make it use its own nixpkgs, or the plugins are built for one KWin and loaded by another:
  #
  #   inputs.kosmic.url = "github:eduresser/kosmic";
  #   inputs.kosmic.inputs.nixpkgs.follows = "nixpkgs";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # One derivation for all five parts. CMakeLists.txt already installs every one of them, which
      # is what keeps this and install.sh from describing two different builds.
      packages = forAll (pkgs: rec {
        kosmic = pkgs.stdenv.mkDerivation {
          pname = "kosmic";
          version = lib.removeSuffix "\n" (builtins.readFile ./VERSION);
          src = lib.cleanSource ./.;

          nativeBuildInputs = with pkgs; [
            cmake
            pkg-config
            kdePackages.extra-cmake-modules
            kdePackages.wrapQtAppsHook
          ];
          buildInputs = with pkgs; [
            kdePackages.kwin
            kdePackages.qtbase
            kdePackages.qtdeclarative
            kdePackages.kconfig
            kdePackages.kcoreaddons
            kdePackages.kwindowsystem
            libepoxy
            libdrm
            libxkbcommon
          ];

          meta = {
            description = "COSMIC's window management for KDE Plasma 6";
            homepage = "https://github.com/eduresser/kosmic";
            license = lib.licenses.gpl3Only;
            platforms = lib.platforms.linux;
            mainProgram = "kosmic-stated";
          };
        };
        default = kosmic;
      });

      # The declarative half of install.sh, for a configuration that cannot run it: everything a
      # NixOS install needs written is written from the configuration instead. It reads the same
      # install.d/ files install.sh does -- nix/module.nix says which, and why the per-user half
      # is deliberately not in it.
      #
      #   imports = [ inputs.kosmic.nixosModules.default ];
      #   programs.kosmic.enable = true;
      nixosModules.default = import ./nix/module.nix { inherit self; };

      # What the module writes, asserted against what KWin has to read. Nothing here needs a
      # session, a Plasma or the compiled components:
      #
      #     nix build .#checks.x86_64-linux.module
      checks = forAll (pkgs: import ./nix/checks.nix { inherit self nixpkgs pkgs; });
    };
}
