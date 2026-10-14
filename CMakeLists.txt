# KOSMIC has five deliverables and only three of them are compiled. The KWin script, the two
# effects and the panel applet are QML and JavaScript: they are installed by copying, which is what
# the KDE Store does too. The other three are C++ against KWin's own headers.
#
# Each component is a separate option because they fail separately. outline and chordhold build
# against KWin's plugin API, which provides no binary compatibility -- effect/effect.h:967 says so
# -- so they have to be rebuilt whenever KWin is updated, and a distribution that ships no KWin
# development headers cannot build them at all. Everything else here works regardless.
#
#   cmake -B build -DCMAKE_INSTALL_PREFIX=$HOME/.local
#   cmake --build build
#   cmake --install build
cmake_minimum_required(VERSION 3.20)

# VERSION is the one place the version is written. tools/gen.mjs stamps it into the metadata.json
# files and the tests check they agree.
file(STRINGS VERSION KOSMIC_VERSION LIMIT_COUNT 1)
project(kosmic VERSION ${KOSMIC_VERSION} LANGUAGES CXX)

include(GNUInstallDirs)

option(INSTALL_PACKAGES "Install the KWin script, the two effects, the applet and its icons" ON)
option(BUILD_STATED    "Build kosmic-stated, the session service behind the applet's switch" ON)
option(BUILD_CHORDHOLD "Build the chordhold KWin plugin (needs KWin development headers)" ON)
option(BUILD_OUTLINE   "Build the outline KWin plugin (needs KWin development headers)" ON)

if(INSTALL_PACKAGES)
    install(DIRECTORY src/comp/script/ DESTINATION "${CMAKE_INSTALL_DATADIR}/kwin/scripts/kosmic-tiling")
    install(DIRECTORY src/comp/effect/ DESTINATION "${CMAKE_INSTALL_DATADIR}/kwin/effects/kosmic-tiling-anim")
    install(DIRECTORY src/comp/focusdim/ DESTINATION "${CMAKE_INSTALL_DATADIR}/kwin/effects/kosmic-focusdim")
    install(DIRECTORY src/applet/ DESTINATION "${CMAKE_INSTALL_DATADIR}/plasma/plasmoids/io.github.eduresser.kosmic-tiling")

    # The same three files twice, and both copies earn their place. The one inside the plasmoid
    # keeps it self-contained; the one in hicolor is what makes the *name* resolve, which is what
    # metadata.json and Plasmoid.icon both use -- a plasmoid's own directory is not on the icon
    # theme's search path, and an icon given as a path skips the recolouring that makes it visible
    # on a dark panel.
    install(FILES
        src/applet/contents/icons/kosmic-tiling-symbolic.svg
        src/applet/contents/icons/kosmic-tiling-on-symbolic.svg
        src/applet/contents/icons/kosmic-tiling-off-symbolic.svg
        DESTINATION "${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps")
endif()

if(BUILD_STATED)
    add_subdirectory(src/state)
endif()
if(BUILD_CHORDHOLD)
    add_subdirectory(src/chordhold)
endif()
if(BUILD_OUTLINE)
    add_subdirectory(src/outline)
endif()
