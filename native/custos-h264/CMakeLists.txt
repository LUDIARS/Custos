cmake_minimum_required(VERSION 3.20)
project(custos_h264 CXX)

# Unity に置く DLL は VC ランタイムの有無に左右されないよう静的リンクにする。
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(custos_h264_core STATIC
    src/annexb.cpp
    src/d3d_nv12_uploader.cpp
    src/mf_h264_encoder.cpp)
target_include_directories(custos_h264_core PUBLIC include src)
target_compile_definitions(custos_h264_core PUBLIC WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE)
target_compile_options(custos_h264_core PUBLIC /W4 /utf-8)
target_link_libraries(custos_h264_core PUBLIC mfplat mfuuid mf d3d11 dxgi ole32 oleaut32)

add_library(custos_h264 SHARED src/custos_h264.cpp)
target_link_libraries(custos_h264 PRIVATE custos_h264_core)

add_executable(custos_h264_test tests/encode_test.cpp)
target_link_libraries(custos_h264_test PRIVATE custos_h264 custos_h264_core)
