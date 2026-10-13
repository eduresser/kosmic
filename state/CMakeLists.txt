# SPDX-FileCopyrightText: 2026 Eduardo Ramon Resser <eduresser@gmail.com>
#
# SPDX-License-Identifier: GPL-3.0-only

# Unlike chordhold and outline, this links against no KDE library at all -- QtCore and QtDBus and
# nothing else. That is the point of it: it is the half of the applet's switch that has to keep
# working across a Plasma update, so it is built out of the one API in this module that promises
# binary compatibility. No ECM, no KF6, no KWin.
cmake_minimum_required(VERSION 3.20)
project(kosmic-stated VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 CONFIG REQUIRED COMPONENTS Core DBus)

include(GNUInstallDirs)

add_executable(kosmic-stated
    main.cpp
    tiling.cpp
)
target_link_libraries(kosmic-stated PRIVATE Qt6::Core Qt6::DBus)

install(TARGETS kosmic-stated RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

# The unit. Written with the full path of the binary it just installed, because a user unit in
# ~/.config has no PATH worth relying on.
#
# KOSMIC_SYSTEMD_USER_UNIT_DIR is overridden by install.sh for a per-user install: systemd reads
# ~/.config/systemd/user and ~/.local/share/systemd/user, and ~/.local/lib/systemd/user -- which is
# what the prefix would give -- is in neither list.
set(KOSMIC_STATED_EXE "${CMAKE_INSTALL_FULL_BINDIR}/kosmic-stated")
set(KOSMIC_SYSTEMD_USER_UNIT_DIR "${CMAKE_INSTALL_PREFIX}/lib/systemd/user"
    CACHE PATH "Where the kosmic-stated user unit is installed")
configure_file(kosmic-stated.service.in kosmic-stated.service @ONLY)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/kosmic-stated.service"
        DESTINATION "${KOSMIC_SYSTEMD_USER_UNIT_DIR}")
