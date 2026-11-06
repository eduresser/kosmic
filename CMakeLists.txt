# KWin's plugin API has no binary compatibility (effect/effect.h:967): the plugins must be rebuilt on
# every KWin update and need its development headers, hence one option per component.
#
#   cmake -B build -DCMAKE_INSTALL_PREFIX=$HOME/.local
#   cmake --build build
#   cmake --install build
cmake_minimum_required(VERSION 3.20)

file(STRINGS VERSION KOSMIC_VERSION LIMIT_COUNT 1)
project(kosmic VERSION ${KOSMIC_VERSION} LANGUAGES CXX)

include(GNUInstallDirs)

option(INSTALL_PACKAGES "Install the KWin script, the two effects, the applet and its icons" ON)
option(BUILD_STATED    "Build kosmic-stated, the session service behind the applet's switch" ON)
option(BUILD_CHORDHOLD "Build the chordhold KWin plugin (needs KWin development headers)" ON)
option(BUILD_OUTLINE   "Build the outline KWin plugin (needs KWin development headers)" ON)
option(BUILD_SWIPE     "Build the swipe KWin plugin (needs KWin development headers)" ON)

if(INSTALL_PACKAGES)
    install(DIRECTORY src/comp/script/ DESTINATION "${CMAKE_INSTALL_DATADIR}/kwin/scripts/kosmic-tiling")
    install(DIRECTORY src/comp/effect/ DESTINATION "${CMAKE_INSTALL_DATADIR}/kwin/effects/kosmic-tiling-anim")
    install(DIRECTORY src/comp/focusdim/ DESTINATION "${CMAKE_INSTALL_DATADIR}/kwin/effects/kosmic-focusdim")
    install(DIRECTORY src/applet/ DESTINATION "${CMAKE_INSTALL_DATADIR}/plasma/plasmoids/io.github.eduresser.kosmic-tiling")

    # Also in hicolor: the plasmoid dir is not on the icon search path, and a path-given icon skips
    # the recolouring needed on a dark panel.
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
if(BUILD_SWIPE)
    add_subdirectory(src/swipe)
endif()
