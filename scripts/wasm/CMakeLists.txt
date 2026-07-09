# Out-of-tree wasm build for the Box3D CORE library only.
#
# We deliberately do NOT `add_subdirectory(vendor/box3d)` (the upstream root project). Upstream's
# root CMakeLists.txt applies `-pthread -s USE_PTHREADS=1 -s ALLOW_MEMORY_GROWTH` directory-wide
# under `if (EMSCRIPTEN AND PROJECT_IS_TOP_LEVEL)`, *before* `add_subdirectory(src)` -- see
# vendor/box3d/CMakeLists.txt. That forces wasm shared-memory (SharedArrayBuffer), which we want to
# avoid for a single-threaded, static-hosting-friendly build.
#
# Instead we add_subdirectory() straight into vendor/box3d/src, which defines exactly one target
# (`box3d`, a static library) and reads a handful of variables that are normally set by the
# (skipped) upstream root: BOX3D_DISABLE_SIMD, BOX3D_DOUBLE_PRECISION, BOX3D_VALIDATE,
# BOX3D_COMPILE_WARNING_AS_ERROR, BOX3D_PROFILE. We set them ourselves below to mirror upstream's
# documented defaults (see knowledge/04-upstream-build.md).
#
# vendor/box3d is untouched by this file -- read-only vendor drop.

cmake_minimum_required(VERSION 3.22)

# VERSION matters: vendor/box3d/src/CMakeLists.txt calls write_basic_package_version_file() using
# ${PROJECT_VERSION} (the *current* project's version -- src/CMakeLists.txt has no project() of its
# own). Mirror upstream's own project() version (vendor/box3d/CMakeLists.txt) so that call succeeds.
project(box3d_wasm VERSION 0.1.0 LANGUAGES C)

if(NOT EMSCRIPTEN)
	message(FATAL_ERROR "This CMakeLists.txt must be configured with emcmake/emcc (Emscripten toolchain).")
endif()

# ---- Mirror upstream's core-lib options (src/CMakeLists.txt reads these) ----
# Defaults per knowledge/04-upstream-build.md: BOX3D_DISABLE_SIMD=OFF, BOX3D_DOUBLE_PRECISION=OFF,
# BOX3D_VALIDATE=ON, BOX3D_PROFILE=OFF, BOX3D_COMPILE_WARNING_AS_ERROR=OFF.
set(BOX3D_DISABLE_SIMD OFF)
set(BOX3D_DOUBLE_PRECISION OFF)
set(BOX3D_VALIDATE ON)
set(BOX3D_PROFILE OFF)
set(BOX3D_COMPILE_WARNING_AS_ERROR OFF)

set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)

# Upstream's root CMakeLists applies these SIMD flags directory-wide (src/CMakeLists.txt's own
# EMSCRIPTEN branch is a no-op and expects the parent to have set them -- see its comment "SSE2/wasm
# SIMD flags are set directory-wide in the top-level CMakeLists"). We are the parent here, so we set
# them ourselves. Emscripten maps SSE2 intrinsics (src/simd.h) onto wasm-simd128.
if(NOT BOX3D_DISABLE_SIMD)
	add_compile_options(-msimd128 -msse2)
endif()

# Deterministic math, matches upstream root (UNIX branch).
add_compile_options(-ffp-contract=off)

# NOTE: intentionally NOT adding -pthread / -sUSE_PTHREADS here. b3CreateScheduler() is only invoked
# when a b3WorldDef requests workerCount > 1; the default def (b3DefaultWorldDef(), workerCount == 0)
# takes physics_world.c's single-threaded path (b3DefaultAddTaskFcn, no scheduler, zero pthread_create
# calls). Emscripten's libc still declares pthread_mutex_t/sem_t/pthread_create etc. without -pthread,
# so src/timer.c's EMSCRIPTEN branch (pthread_mutex + sem_t + pthread_create for the worker-thread
# abstraction, only exercised when workerCount > 1) compiles and links fine as an unused/no-op-at-1-worker
# code path -- confirmed empirically by this build succeeding without shared-memory linker flags.

set(BOX3D_VENDOR_SRC "${CMAKE_CURRENT_SOURCE_DIR}/../../vendor/box3d/src")
set(BOX3D_VENDOR_BIN "${CMAKE_CURRENT_BINARY_DIR}/box3d-src")

add_subdirectory("${BOX3D_VENDOR_SRC}" "${BOX3D_VENDOR_BIN}")

# ---- Final linked artifact: a "no entry point" wasm module exposing the core lib's C API ----
#
# stub.c only anchors the executable target; binding.c (src/wasm-shim/, OUR code, not vendor/) is the
# P1 flattening shim -- see docs/loom/P1-binding-design.md. It is compiled and linked into the same
# module and does not touch vendor/box3d.
add_executable(box3d_core stub.c "${CMAKE_CURRENT_SOURCE_DIR}/../../src/wasm-shim/binding.c")
target_link_libraries(box3d_core PRIVATE box3d)

# Match the vendor lib's C standard (box3d/src/CMakeLists.txt requires C17 for _Static_assert and
# anonymous unions); binding.c also relies on C99+ compound literals and designated initializers.
set_target_properties(box3d_core PROPERTIES
	C_STANDARD 17
	C_STANDARD_REQUIRED YES
	OUTPUT_NAME "box3d"
	SUFFIX ".mjs"
	RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../../build/wasm"
)

target_link_options(box3d_core PRIVATE
	-msimd128
	-msse2
	--no-entry
	-sMODULARIZE=1
	-sEXPORT_ES6=1
	-sEXPORT_NAME=Box3D
	-sALLOW_MEMORY_GROWTH=1
	# Mitigation (not a fix -- growth itself is handled correctly by src/ts re-deriving HEAPF32/HEAPU32/
	# etc. from the live Module object on every call, verified by tests/memory-growth.test.ts): bump the
	# starting heap so a typical game session (car + 5 panels + destructible world's ~dozens of bodies/
	# shapes) rarely needs to grow at all, minimizing how often the classical (non-resizable-ArrayBuffer)
	# grow path -- which detaches every stale TypedArray view built over the old buffer -- gets exercised
	# in the first place. Default INITIAL_MEMORY (~16-17MB with our STACK_SIZE) was already observed to
	# be exceeded during ordinary scene construction (car + destructible world), forcing at least one
	# grow() per session even before any driving happened.
	-sINITIAL_MEMORY=67108864
	-sENVIRONMENT=web,node
	# WASM_BIGINT: our shim's b3js_* functions pass/return uint64_t handles (bit-cast id structs, see
	# src/wasm-shim/binding.c); this makes Emscripten marshal i64 params/returns as JS BigInt instead
	# of the legacy split-into-two-i32s ABI.
	-sWASM_BIGINT
	-sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPF32,HEAPU8,HEAP32,HEAPU32
	# 1MiB stack: comfortable headroom for the solver/broad-phase's stack-allocated scratch arrays
	# (Emscripten's default is only 64KiB).
	-sSTACK_SIZE=1048576
	"-sEXPORTED_FUNCTIONS=@${CMAKE_CURRENT_SOURCE_DIR}/../exports.json"
)
