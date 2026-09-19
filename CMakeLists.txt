cmake_minimum_required(VERSION 3.8)
project(console-wla VERSION 1.0.1 LANGUAGES C)

include(GNUInstallDirs)

find_program(NPM_EXECUTABLE npm REQUIRED)
mark_as_advanced(NPM_EXECUTABLE)

if (WIN32)
  set(NPM_PREFIX "cmd" "/c")
endif ()

find_package(LibNetQ REQUIRED)

option(CONSOLE_INSTALL_SERVER "Install the console server" ON)
option(CONSOLE_INSTALL_MODULE "Install the console module" ON)
option(CONSOLE_INSTALL_ASSETS "Install console supporting assets" ON)

set(CONSOLE_BASE_URL "/" CACHE STRING "URL path prefix the console module is served under (a trailing slash is appended if missing)")
set(CONSOLE_ROOT_URL "${CONSOLE_BASE_URL}")
if(NOT CONSOLE_ROOT_URL MATCHES "/$")
  set(CONSOLE_ROOT_URL "${CONSOLE_ROOT_URL}/")
endif()

set(CONSOLE_SERVICE_URL "${CONSOLE_ROOT_URL}ws")
set(CONSOLE_ASSETS_DIR "${CMAKE_INSTALL_DATADIR}/${PROJECT_NAME}")

set(CONSOLE_DATAFILES
  config.h.in
  )

file(GLOB_RECURSE CONSOLE_TSXFILES
  "src/*.ts"
  "src/*.tsx"
  )

set(CONSOLE_DISTFILES
  dist/index.html
  dist/manifest.json
  )

add_custom_command(
  COMMAND ${NPM_PREFIX} "${NPM_EXECUTABLE}" install
  COMMAND ${NPM_PREFIX} "${NPM_EXECUTABLE}" run build --base-url=${CONSOLE_BASE_URL}
  DEPENDS package.json ${CONSOLE_TSXFILES}
  OUTPUT ${CONSOLE_DISTFILES}
  WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
  )

configure_file(config.h.in "${CMAKE_CURRENT_BINARY_DIR}/config.h" @ONLY)

source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES module.c ${CONSOLE_DATAFILES} ${CONSOLE_DISTFILES})
add_library(console_wla SHARED module.c ${CONSOLE_DATAFILES} ${CONSOLE_DISTFILES})
target_include_directories(console_wla PRIVATE "$<BUILD_INTERFACE:${CMAKE_CURRENT_BINARY_DIR}>")
target_link_libraries(console_wla PUBLIC LibNetQ::LibNetQ)
set_property(TARGET console_wla PROPERTY POSITION_INDEPENDENT_CODE ON)
set_target_properties(console_wla PROPERTIES PREFIX "" IMPORT_PREFIX "")

source_group(TREE "${CMAKE_CURRENT_SOURCE_DIR}" FILES server.c)
add_executable(console_server server.c)
target_link_libraries(console_server PRIVATE LibNetQ::LibNetQ)

if (CMAKE_C_COMPILER_ID MATCHES "^(GNU|Clang)$")
  target_link_options(console_server PRIVATE "-Wl,-rpath,$ORIGIN/../lib")
endif ()

if (CONSOLE_INSTALL_SERVER)
  install(TARGETS console_server
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif ()

if (CONSOLE_INSTALL_MODULE)
  install(TARGETS console_wla
    LIBRARY DESTINATION ${CMAKE_INSTALL_BINDIR}
    ARCHIVE DESTINATION ${CMAKE_INSTALL_LIBDIR}
    )
endif ()

if (CONSOLE_INSTALL_ASSETS)
  install(DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/dist/"
    DESTINATION "${CONSOLE_ASSETS_DIR}"
    )
endif ()
