# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only

# Has to be built against the same kwin the session runs, which is not a preference: KWin's effect
# and plugin API provides no binary compatibility, and the header says so (effect/effect.h:967).
# Nothing enforces that at run time -- a plugin built against a different KWin is refused by the
# compositor silently -- so install.sh records the version it built against and says so when that
# changes, and the CI canary builds against KDE's master.
cmake_minimum_required(VERSION 3.20)
project(kosmic-chordhold)

set(KF6_MIN_VERSION "6.0.0")

find_package(ECM ${KF6_MIN_VERSION} REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECMakeSettings)
include(KDECompilerSettings NO_POLICY_SCOPE)

# Widgets is not used here, but KWin::kwin names it in its link interface (KWinTargets.cmake:55)
# and CMake refuses to resolve the imported target without it.
find_package(Qt6 CONFIG REQUIRED COMPONENTS Core DBus Widgets)
find_package(KF6 ${KF6_MIN_VERSION} REQUIRED COMPONENTS Config)
find_package(KWin REQUIRED COMPONENTS kwin)

kcoreaddons_add_plugin(kosmic-chordhold INSTALL_NAMESPACE "kwin/plugins")
target_sources(kosmic-chordhold PRIVATE
    main.cpp
    chordhold.cpp
)
target_link_libraries(kosmic-chordhold PRIVATE
    KWin::kwin
    Qt6::DBus
    KF6::ConfigCore
)
