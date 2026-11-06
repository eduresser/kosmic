# Must be built against the session's exact KWin: its plugin API has no binary compatibility
# (effect/effect.h:967), and a mismatched plugin is refused silently.
cmake_minimum_required(VERSION 3.20)
project(kosmic-swipe)

# KWin's headers (window.h, workspace.h) use C++20/23; KDECompilerSettings would otherwise pick 17.
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(KF6_MIN_VERSION "6.0.0")

find_package(ECM ${KF6_MIN_VERSION} REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECMakeSettings)
include(KDECompilerSettings NO_POLICY_SCOPE)

# Widgets is unused, but KWin::kwin's link interface names it (KWinTargets.cmake:55).
find_package(Qt6 CONFIG REQUIRED COMPONENTS Core Widgets)
find_package(KWin REQUIRED COMPONENTS kwin)

# KWin's xkb.h includes <xkbcommon/xkbcommon.h> without an include path; openSUSE keeps it under
# /usr/include/libxkbcommon, which only pkg-config knows.
find_package(PkgConfig REQUIRED)
pkg_check_modules(XKBCOMMON REQUIRED IMPORTED_TARGET xkbcommon)

kcoreaddons_add_plugin(kosmic-swipe INSTALL_NAMESPACE "kwin/plugins")
target_sources(kosmic-swipe PRIVATE
    main.cpp
    swipe.cpp
)
target_link_libraries(kosmic-swipe PRIVATE
    KWin::kwin
    PkgConfig::XKBCOMMON
)
