# bindings/wasm — phase 2 scaffold

**Nothing here is built today.** `emcc` is not installed on the dev machine and
`npm run build:native` never touches this directory. This is the seam that keeps
the web port a port instead of a rewrite.

## The point

Two hosts, one core:

| | desktop (today) | web (phase 2) |
|---|---|---|
| compiler | `clang++` via node-gyp | `emcc` via `build.sh` |
| core sources | `core/src/*.cpp` | `core/src/*.cpp` — **identical** |
| binding layer | `bindings/napi/*.cpp` | `bindings/wasm/bindings.cpp` |
| output | `build/Release/braindump.node` | `bindings/wasm/out/braindump.mjs` + `.wasm` |

The only file that differs is the binding layer. `core/` never learns which host
it is running in — it depends on the C++17 standard library and nothing else,
which is non-negotiable rule 3 in `CLAUDE.md`.

`bindings/wasm/bindings.cpp` mirrors `NativeGraph` from
`shared/types/addon.ts` method for method, so the renderer can swap the addon
for the module behind one interface.

## Phase-2 checklist

1. **Install the SDK.**
   ```bash
   git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
   cd ~/emsdk && ./emsdk install latest && ./emsdk activate latest
   source ~/emsdk/emsdk_env.sh
   ```
2. **Build.**
   ```bash
   bash bindings/wasm/build.sh     # -> bindings/wasm/out/braindump.mjs
   ```
   `bindings/wasm/out/` is already gitignored.
3. **Write the JS wrapper.** embind has no default arguments, so every method in
   `bindings.cpp` takes all of its parameters explicitly. A thin wrapper applies
   the same defaults the N-API layer does (`pretty=false`, `weight=1`,
   `iterations=1`, `maxIterations=500`, `limit=20`, `seed=0`) and exposes the
   `BrainDumpCoreAddon` shape.
4. **Point the renderer at it.** The graph pane already reads
   `{ positions, energy, converged, iterations }` and caches `nodeOrder()` on
   `topologyVersion()`, so no renderer logic changes.

## Two gotchas to carry over

**`positions` is a view, not a copy.** The N-API layer copies the flat double
buffer into an `ArrayBuffer` once per tick. The wasm layer returns
`typed_memory_view` — genuinely zero-copy, but the view is invalidated by the
next tick and by `ALLOW_MEMORY_GROWTH`. Any caller that retains a frame must
`.slice()` it first.

**Objects are manually owned.** `createGraph()` and `Graph.fromJSON()` return
embind objects backed by heap allocations. JS must call `.delete()` on them, or
the wasm heap leaks. The N-API side has no such requirement — V8's GC finalizes
the wrapper.

## Exceptions

`build.sh` passes `-fexceptions` because the core throws `braindump::GraphError`
on malformed JSON, schema mismatch, and unknown ids. `bindings.cpp` normalizes
`GraphError` to `std::runtime_error` carrying the original message, matching
what the N-API layer does with `Napi::Error`. Dropping `-fexceptions` silently
turns every one of those into an abort — do not.
