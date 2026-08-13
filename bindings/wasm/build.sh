#!/usr/bin/env bash
#
# BrainDump WebAssembly build — PHASE 2. Not run today (emcc is not installed).
#
# Compiles the SAME core/src/*.cpp that node-gyp compiles for the desktop
# addon, plus bindings/wasm/bindings.cpp instead of bindings/napi/*.cpp.
# Nothing under core/ changes between the two targets — that is the point.
#
# Usage:  source /path/to/emsdk/emsdk_env.sh && bash bindings/wasm/build.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/bindings/wasm/out"
OUT_FILE="${OUT_DIR}/braindump.mjs"
CORE_SRC_DIR="${REPO_ROOT}/core/src"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc not found on PATH." >&2
  echo "  Install the Emscripten SDK, then run:" >&2
  echo "    source /path/to/emsdk/emsdk_env.sh" >&2
  echo "  See bindings/wasm/README.md." >&2
  exit 1
fi

if [ ! -d "${CORE_SRC_DIR}" ]; then
  echo "error: ${CORE_SRC_DIR} does not exist — nothing to compile." >&2
  exit 1
fi

# shellcheck disable=SC2207
CORE_SOURCES=($(find "${CORE_SRC_DIR}" -name '*.cpp' | sort))
if [ "${#CORE_SOURCES[@]}" -eq 0 ]; then
  echo "error: no .cpp files under ${CORE_SRC_DIR}." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

# -fexceptions: the core throws braindump::GraphError and the bindings rely on
#               it crossing into JS as an Error.
# -sMODULARIZE + -sEXPORT_ES6: importable from the Vite renderer bundle.
# -sALLOW_MEMORY_GROWTH: graphs are unbounded; note that growth invalidates any
#               retained typed_memory_view (see bindings.cpp).
emcc \
  -std=c++17 \
  -O3 \
  -fexceptions \
  -lembind \
  -I "${REPO_ROOT}/core/include" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createBrainDumpModule \
  -sALLOW_MEMORY_GROWTH=1 \
  -sENVIRONMENT=web,worker \
  -o "${OUT_FILE}" \
  "${CORE_SOURCES[@]}" \
  "${REPO_ROOT}/bindings/wasm/bindings.cpp"

echo "built ${OUT_FILE}"
