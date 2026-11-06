# Must be built against the session's exact KWin: its plugin API has no binary compatibility
# (effect/effect.h:967), and a mismatched plugin is refused silently.
# Uses scene-graph internals, so this is the plugin most likely to break on a Plasma update.
cmake_minimum_required(VERSION 3.20)
project(kosmic-outline)

# KWin's headers (window.h, workspace.h) use C++20/23; KDECompilerSettings would otherwise pick 17.
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(KF6_MIN_VERSION "6.0.0")

find_package(ECM ${KF6_MIN_VERSION} REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECMakeSettings)
include(KDECompilerSettings NO_POLICY_SCOPE)

# Widgets is unused, but KWin::kwin's link interface names it (KWinTargets.cmake:57).
find_package(Qt6 CONFIG REQUIRED COMPONENTS Core DBus Gui Widgets)
find_package(KF6 ${KF6_MIN_VERSION} REQUIRED COMPONENTS Config)
find_package(KWin REQUIRED COMPONENTS kwin)

kcoreaddons_add_plugin(kosmic-outline INSTALL_NAMESPACE "kwin/plugins")
target_sources(kosmic-outline PRIVATE
    main.cpp
    outline.cpp
)
target_link_libraries(kosmic-outline PRIVATE
    KWin::kwin
    Qt6::DBus
    Qt6::Gui
    KF6::ConfigCore
)
