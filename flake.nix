# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only
{
  description = "KOSMIC: COSMIC's window management for KDE Plasma 6";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;

      # Every Linux system nixpkgs actually exposes. Filtering against legacyPackages rather than
      # taking lib.platforms.linux whole keeps the ones nixpkgs does not build for from turning
      # `nix flake check` into a missing-attribute error.
      forAllSystems =
        f: lib.genAttrs (lib.filter (s: nixpkgs.legacyPackages ? ${s}) lib.platforms.linux) f;
    in
    {
      nixosModules.default = ./default.nix;
      nixosModules.kosmic = ./default.nix;

      packages = forAllSystems (system:
        let kosmic = import ./packages.nix { pkgs = nixpkgs.legacyPackages.${system}; };
        in {
          default = kosmic.package;
          kwin = kosmic.package;
          applet = kosmic.applet;
          outline = kosmic.outline;
          chordhold = kosmic.chordHold;
          stated = kosmic.stated;
        });

      # The tiler's simulator suite and everything else that can be asked without a session. Pure,
      # so it runs anywhere:
      #
      #     nix build .#checks.x86_64-linux.kosmic
      #
      # Each sim takes the tiler as its argument and asserts against fake windows.
      checks = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          kosmic = pkgs.runCommand "kosmic-tests"
            {
              nativeBuildInputs = [
                pkgs.nodejs pkgs.qt6.qtdeclarative pkgs.kdePackages.libplasma
                pkgs.kdePackages.kirigami pkgs.libxml2 pkgs.reuse
              ];
            }
            ''
              src=${./.}
              comp=$src/comp
              tiler=$comp/script/contents/code/kosmic-tiling.mjs
              keymap=$src/keybindings.json

              # The generated files first, because every check after this one reads them. They are
              # committed so that a clone, a release tarball and whatever the KDE Store unpacks all
              # carry a working package; this is what keeps the committed copy equal to what the
              # generator would write today.
              echo "-- generated files"
              node $src/tools/gen.mjs --check

              # Both directions of the settings contract: every kwinrc key names an option, and
              # every option that reads its default from settings.json has a key there to read.
              # The second direction throws during evaluation, which is in the middle of somebody's
              # rebuild; this says it here instead.
              echo "-- settings parity"
              node -e '
                const fs = require("fs");
                const root = process.argv[1];
                const s = JSON.parse(fs.readFileSync(root + "/settings.json", "utf8"));
                const nix = fs.readFileSync(root + "/default.nix", "utf8");
                const want = new Set();
                for (const c of Object.values(s.components))
                  for (const e of Object.values(c.entries)) if (e.option) want.add(e.option);
                const have = new Set([...nix.matchAll(/dflt "([^"]+)"/g)].map((m) => m[1]));
                const missing = [...want].filter((o) => !have.has(o));
                const extra = [...have].filter((o) => !want.has(o));
                if (missing.length) {
                  console.error("settings.json keys whose option does not read dflt:\n  "
                    + missing.join("\n  "));
                }
                if (extra.length) {
                  console.error("options reading dflt with no key in settings.json:\n  "
                    + extra.join("\n  "));
                }
                if (missing.length || extra.length) process.exit(1);
                console.log("   " + want.size + " keys paired");
              ' $src

              echo "-- sims"
              n=0
              for t in $comp/tests/*.mjs; do
                echo "   $(basename "$t")"
                node "$t" "$tiler" "$keymap"
                n=$((n + 1))
              done
              # A glob that matches nothing would leave this check passing while proving nothing,
              # which is the one failure mode a test suite must not have.
              if [ "$n" -eq 0 ]; then echo "no sims found" >&2; exit 1; fi
              echo "   $n sims passed"

              # The sims run in Node, and Node is a far more forgiving engine than the one a KWin
              # script actually runs in. QJSEngine is Qt's V4 and stops at roughly ES7, so a
              # construct Node swallows -- object spread in a literal is the one that got through --
              # passes every sim and then fails to load in a live session, which costs a logout to
              # find out. This loads the modules through the real engine, the same way
              # contents/ui/main.qml does.
              #
              # QT_FORCE_STDERR_LOGGING is not optional: without it the parse error is swallowed
              # and all that is left is a bare exit code.
              echo "-- qml load"
              export HOME=$TMPDIR XDG_RUNTIME_DIR=$TMPDIR QT_QPA_PLATFORM=offscreen
              export QT_FORCE_STDERR_LOGGING=1
              # Nothing sets this up in a sandbox the way a session does, and without it the only
              # error is "module QtQml is not installed", which says nothing about the files under
              # test. `.unwrapped` because the KDE packages here are wrappers that carry nothing but
              # nix-support; the QML modules are in the package they wrap. plasma5support is listed
              # separately because it is not part of libplasma: it carries
              # org.kde.plasma.plasma5support, which is how the applet reaches busctl -- QML has no
              # D-Bus binding of its own.
              export QML2_IMPORT_PATH=${pkgs.qt6.qtdeclarative}/lib/qt-6/qml:${pkgs.kdePackages.libplasma.unwrapped or pkgs.kdePackages.libplasma}/lib/qt-6/qml:${pkgs.kdePackages.kirigami.unwrapped or pkgs.kdePackages.kirigami}/lib/qt-6/qml:${pkgs.kdePackages.ksvg.unwrapped or pkgs.kdePackages.ksvg}/lib/qt-6/qml:${pkgs.kdePackages.kirigami-addons.unwrapped or pkgs.kdePackages.kirigami-addons}/lib/qt-6/qml:${pkgs.kdePackages.plasma5support.unwrapped or pkgs.kdePackages.plasma5support}/lib/qt-6/qml:${pkgs.kdePackages.kdeclarative.unwrapped or pkgs.kdePackages.kdeclarative}/lib/qt-6/qml
              export QML_IMPORT_PATH=$QML2_IMPORT_PATH
              qml $comp/tests/qml/load.qml

              # And the overlays, which are QML rather than JavaScript. Qt.createComponent fails at
              # run time and hands back null, so a broken one costs a line in the journal and the
              # feature silently not appearing -- indistinguishable from it never having been
              # written. main.qml is not in here: it imports org.kde.kwin, which exists only inside
              # KWin.
              echo "-- qml components"
              qml $comp/tests/qml/components.qml

              echo "-- qml applet"
              qml $comp/tests/qml/applet.qml -- $src/applet/contents/ui/main.qml

              # The same file through qmllint, which asks a different question. applet.qml only
              # compiles the component -- it cannot instantiate one, because PlasmoidItem needs the
              # Plasmoid attached object and that exists only inside plasmashell -- so a property
              # that does not exist on the type it is set on, or an id that resolves to nothing,
              # parses perfectly and fails at run time, in a popup, with one line in the journal.
              # qmllint resolves every type against the real modules and says so instead.
              #
              # -I rather than the QML2_IMPORT_PATH above: qmllint does not read that variable.
              echo "-- qmllint applet"
              lintimports=""
              for d in $(echo "$QML2_IMPORT_PATH" | tr ':' ' '); do
                lintimports="$lintimports -I $d"
              done
              qmllint $lintimports $src/applet/contents/ui/main.qml

              # The two configuration dialogs. KWin builds each from contents/ui/config.ui, and a
              # malformed one does not announce itself: the gear button opens an empty dialog.
              # Well-formedness is what is checked here, not the pairing -- a widget named
              # kcfg_<key> whose <key> is not in the generated main.xml still parses, and still
              # silently configures nothing.
              echo "-- config dialogs"
              for u in $comp/effect/contents/ui/config.ui \
                       $comp/focusdim/contents/ui/config.ui; do
                echo "   $(basename "$(dirname "$(dirname "$(dirname "$u")")")")"
                xmllint --noout "$u"
              done
              # The tiler has none, and that is deliberate rather than missing. Every key it exposed
              # is a programs.kosmic option, and the two paths wrote to different files: the module
              # writes /etc/xdg/kwinrc, the dialog wrote ~/.config/kwinrc, and the second shadows
              # the first. So the dialog did not fail -- it won, silently and permanently, and an
              # option changed afterwards had no effect with nothing on screen to say why.
              #
              # Two things have to stay gone for the gear to stay out of the KWin Scripts list, and
              # only one of them is the file: the list reads X-KDE-ConfigModule, so deleting the
              # .ui alone would leave the button there opening an empty dialog.
              if [ -e "$comp/script/contents/ui/config.ui" ]; then
                echo "the tiler has a config.ui again" >&2; exit 1
              fi
              if grep -q X-KDE-ConfigModule "$comp/script/metadata.json"; then
                echo "the tiler declares X-KDE-ConfigModule again" >&2; exit 1
              fi

              # Two licences in one tree, which is not something a meta.license list can state
              # precisely: it says the package contains GPL-3.0 and CC BY-SA 4.0 and not which file
              # is which. REUSE does say which, file by file, and this keeps it true -- a new file
              # with no SPDX header fails the build rather than quietly making the tree
              # non-compliant on the day somebody packages it.
              echo "-- reuse"
              reuse --root $src lint --quiet \
                || { echo "reuse lint failed; run: reuse lint" >&2; exit 1; }
              echo "   compliant"

              # The one contract in here that nothing else can check. The tiler tells the outline
              # plugin where the selection is over D-Bus, and both ends name the interface and the
              # object path as string literals in different languages, in different files, built by
              # different toolchains. Nothing links them.
              #
              # Worse, getting it wrong is silent in both directions: DBusCall reads no reply, so a
              # call to a name nobody answers is indistinguishable from a call that worked, and the
              # only symptom is that the hint never appears.
              echo "-- dbus contract"
              outline=$src/outline
              tilerui=$comp/script/contents/ui/main.qml
              iface=$(sed -n 's/.*Q_CLASSINFO("D-Bus Interface", "\([^"]*\)").*/\1/p' "$outline/outline.h")
              dpath=$(sed -n 's/.*s_dbusPath("\([^"]*\)").*/\1/p' "$outline/outline.cpp")
              if [ -z "$iface" ]; then
                echo "outline.h declares no D-Bus interface name: Qt will derive one from the host process" >&2
                exit 1
              fi
              if [ -z "$dpath" ]; then
                echo "outline.cpp declares no s_dbusPath" >&2
                exit 1
              fi
              if ! grep -qF "dbusInterface: \"$iface\"" "$tilerui"; then
                echo "the tiler calls no interface named $iface" >&2
                exit 1
              fi
              if ! grep -qF "path: \"$dpath\"" "$tilerui"; then
                echo "the tiler calls no object at $dpath" >&2
                exit 1
              fi
              echo "   $iface at $dpath"

              touch $out
            '';
        });
    };
}
