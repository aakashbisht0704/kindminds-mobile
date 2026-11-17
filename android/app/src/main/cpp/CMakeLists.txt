cmake_minimum_required(VERSION 3.22)

# Keep the React Native default app setup (appmodules / new architecture).
# The Cactus bridge lives in a subdirectory so appmodules' *.cpp glob does not
# absorb it. Keeping the engine out of appmodules matters: appmodules is loaded
# at React startup, and a fault in the third-party engine must not take the
# whole app down before a model is ever needed.
project(appmodules)
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# Cactus 4.1 loads the single-file .cact models. The archive is arm64-only;
# the lite x86_64 build still gets a tiny library, but it never has a model.
if(ANDROID_ABI STREQUAL "arm64-v8a")
  add_library(cactus STATIC IMPORTED)
  set_target_properties(cactus PROPERTIES
    IMPORTED_LOCATION "${CMAKE_CURRENT_SOURCE_DIR}/libcactus.a")

  add_library(cactusbridge SHARED cactus/cactus_bridge.cpp)
  target_include_directories(cactusbridge PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}"
    "${CMAKE_CURRENT_SOURCE_DIR}/cactus")
  target_compile_options(cactusbridge PRIVATE -fexceptions -frtti -fvisibility=hidden)
  target_link_options(cactusbridge PRIVATE -Wl,--exclude-libs,ALL)
  target_link_libraries(cactusbridge cactus android log c++_shared)
else()
  add_library(cactusbridge SHARED cactus/dummy.cpp)
endif()
