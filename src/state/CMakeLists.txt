# Qt only, deliberately: it must survive Plasma updates, so it avoids KDE libraries without binary compatibility.
cmake_minimum_required(VERSION 3.20)
project(kosmic-stated VERSION ${KOSMIC_VERSION} LANGUAGES CXX)

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
target_compile_definitions(kosmic-stated PRIVATE KOSMIC_VERSION="${PROJECT_VERSION}")

install(TARGETS kosmic-stated RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})

# Full path: a user unit has no reliable PATH. install.sh overrides the unit dir per user, since
# systemd does not read ~/.local/lib/systemd/user.
set(KOSMIC_STATED_EXE "${CMAKE_INSTALL_FULL_BINDIR}/kosmic-stated")
set(KOSMIC_SYSTEMD_USER_UNIT_DIR "${CMAKE_INSTALL_PREFIX}/lib/systemd/user"
    CACHE PATH "Where the kosmic-stated user unit is installed")
configure_file(kosmic-stated.service.in kosmic-stated.service @ONLY)
install(FILES "${CMAKE_CURRENT_BINARY_DIR}/kosmic-stated.service"
        DESTINATION "${KOSMIC_SYSTEMD_USER_UNIT_DIR}")
