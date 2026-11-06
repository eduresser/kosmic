{
  description = "KOSMIC: COSMIC's window management for KDE Plasma 6";

  # KWin's plugin API has no binary compatibility: importers must make this follow their nixpkgs.
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

      #   imports = [ inputs.kosmic.nixosModules.default ];
      #   programs.kosmic.enable = true;
      nixosModules.default = import ./nix/module.nix { inherit self; };

      #     nix build .#checks.x86_64-linux.module
      checks = forAll (pkgs: import ./nix/checks.nix { inherit self nixpkgs pkgs; });
    };
}
