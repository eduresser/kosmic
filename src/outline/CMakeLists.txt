# Has to be built against the same kwin the session runs, which is not a preference: KWin's effect
# and plugin API provides no binary compatibility, and the header says so (effect/effect.h:967).
# This one reaches further in than chordhold does -- it uses the scene graph, which is compositor
# internals and not the effects API -- so it is the component most likely to need fixing after a
# Plasma update.
#
# Nothing enforces the lockstep at run time: a plugin built against a different KWin is refused by
# the compositor silently. install.sh records the version it built against and says so when that
# changes, and the CI canary builds against KDE's master so the breakage arrives before a release
# carries it.
cmake_minimum_required(VERSION 3.20)
project(kosmic-outline)

# KWin's own standard, and not a choice: its installed headers use C++20 and C++23 -- defaulted
# `operator<=>`, `std::weak_ordering` in utils/serial.h -- so anything that includes window.h or
# workspace.h has to be built at the same level kwin was. KDECompilerSettings otherwise leaves
# this at 17, which is how chordhold got away without it: the input headers need neither.
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(KF6_MIN_VERSION "6.0.0")

find_package(ECM ${KF6_MIN_VERSION} REQUIRED NO_MODULE)
set(CMAKE_MODULE_PATH ${ECM_MODULE_PATH})

include(KDEInstallDirs)
include(KDECMakeSettings)
include(KDECompilerSettings NO_POLICY_SCOPE)

# Widgets is not used here, but KWin::kwin names it in its link interface (KWinTargets.cmake:57)
# and CMake refuses to resolve the imported target without it. Gui is: the line carries a QColor.
# DBus is too: the tiler calls SetSelection on an object this registers on the session bus, which
# is the connection KWin already holds the name org.kde.KWin on.
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
