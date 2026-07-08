#!/usr/bin/env bash
# Reproducible, single-threaded wasm-simd ES-module build of the Box3D core physics library.
#
# Builds ONLY vendor/box3d/src (the box3d target) via an out-of-tree CMake project
# (scripts/wasm/CMakeLists.txt) that bypasses upstream's root CMakeLists.txt -- and with it, the
# root's `-pthread -sUSE_PTHREADS=1` branch that would force wasm shared memory / SharedArrayBuffer.
# See scripts/wasm/CMakeLists.txt for the detailed rationale.
#
# Output: build/wasm/box3d.mjs + build/wasm/box3d.wasm (gitignored build artifacts).
#
# Usage: scripts/build-wasm.sh
# Idempotent: safe to re-run; exits 0 on success.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

VENDOR_DIR="$REPO_ROOT/vendor/box3d"
WASM_SRC_DIR="$REPO_ROOT/scripts/wasm"
BUILD_DIR="$REPO_ROOT/build/wasm-cmake"
OUT_DIR="$REPO_ROOT/build/wasm"

log() { printf '[build-wasm] %s\n' "$*" >&2; }
die() { printf '[build-wasm] ERROR: %s\n' "$*" >&2; exit 1; }

# ---- 0. Sanity checks ----

if [[ ! -d "$VENDOR_DIR/src" ]]; then
	die "vendor/box3d/src not found. Expected a read-only clone of https://github.com/erincatto/box3d
  at commit 52f1a254. Restore it with:
    git clone https://github.com/erincatto/box3d.git vendor/box3d && cd vendor/box3d && git checkout 52f1a254"
fi

# ---- 1. Toolchain: cmake + emcc ----
#
# Preferred: Homebrew (brew install cmake emscripten). Falls back to a hint about emsdk if brew's
# emscripten is not usable -- this script does not auto-install emsdk itself (that's a much bigger,
# stateful install into $HOME); if you've already got emsdk set up, `source
# /path/to/emsdk/emsdk_env.sh` before running this script and it will pick up that emcc/cmake.

if ! command -v cmake >/dev/null 2>&1; then
	die "cmake not found on PATH. Install it, e.g.:
    brew install cmake
  or (emsdk provides its own cmake too):
    git clone https://github.com/emscripten-core/emsdk ~/emsdk && cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest && source ~/emsdk/emsdk_env.sh"
fi

if ! command -v emcc >/dev/null 2>&1; then
	die "emcc not found on PATH. Install it, e.g.:
    brew install emscripten
  and verify with: emcc --version
  If Homebrew's emscripten fails to build this project, fall back to emsdk:
    git clone https://github.com/emscripten-core/emsdk ~/emsdk
    cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
    source ~/emsdk/emsdk_env.sh
  then re-run this script (source emsdk_env.sh in your shell first)."
fi

if ! command -v emcmake >/dev/null 2>&1; then
	die "emcmake not found on PATH (should ship alongside emcc). Check your Emscripten install."
fi

log "cmake: $(cmake --version | head -1)"
log "emcc:  $(emcc --version | head -1)"

# ---- 2. Configure ----

mkdir -p "$BUILD_DIR" "$OUT_DIR"

log "configuring (emcmake cmake) -> $BUILD_DIR"
emcmake cmake -S "$WASM_SRC_DIR" -B "$BUILD_DIR" \
	-DCMAKE_BUILD_TYPE=Release \
	>&2

# ---- 3. Build ----

log "building -> $OUT_DIR"
cmake --build "$BUILD_DIR" --config Release -- -j"$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" >&2

[[ -f "$OUT_DIR/box3d.mjs" ]] || die "expected output $OUT_DIR/box3d.mjs was not produced"
[[ -f "$OUT_DIR/box3d.wasm" ]] || die "expected output $OUT_DIR/box3d.wasm was not produced"

log "built: $OUT_DIR/box3d.mjs ($(wc -c < "$OUT_DIR/box3d.mjs") bytes), $OUT_DIR/box3d.wasm ($(wc -c < "$OUT_DIR/box3d.wasm") bytes)"

# ---- 4. Verify single-threadedness ----
#
# The loader JS must not gate on SharedArrayBuffer / cross-origin isolation. A pthreads-enabled
# Emscripten build unconditionally references `SharedArrayBuffer` (worker bootstrap, PThread
# support) in the glue JS; a single-threaded build should not.

if grep -q 'SharedArrayBuffer' "$OUT_DIR/box3d.mjs"; then
	die "box3d.mjs references SharedArrayBuffer -- this build is not single-threaded as required."
fi
log "verified: box3d.mjs does not reference SharedArrayBuffer"

# ---- 5. Smoke test (plain node, no --experimental flags) ----

log "running smoke test"
node "$REPO_ROOT/scripts/smoke-wasm.mjs"

log "done."
