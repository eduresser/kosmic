# Has to be built against the same kwin the session runs, which is not a preference: KWin's effect
# and plugin API provides no binary compatibility, and the header says so (effect/effect.h:967).
# Nothing enforces that at run time -- a plugin built against a different KWin is refused by the
# compositor silently -- so install.sh records the version it built against and says so when that
# changes, and the CI canary builds against KDE's master.
cmake_minimum_required(VERSION 3.20)
project(kosmic-swipe)

# KWin's own standard, and not a choice: workspace.h and window.h use C++20 and C++23, the same
# reason outline sets it.
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(KF6_MIN_VERSION "6.0.0")

find_package(ECM ${KF6_MIN_VERSION} REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECMakeSettings)
include(KDECompilerSettings NO_POLICY_SCOPE)

# Widgets is not used here, but KWin::kwin names it in its link interface (KWinTargets.cmake:55)
# and CMake refuses to resolve the imported target without it.
find_package(Qt6 CONFIG REQUIRED COMPONENTS Core Widgets)
find_package(KWin REQUIRED COMPONENTS kwin)

# input.h reaches keyboard_input.h and xkb.h, which include <xkbcommon/xkbcommon.h> without saying
# where it is; openSUSE keeps it under /usr/include/libxkbcommon, which only pkg-config knows.
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
