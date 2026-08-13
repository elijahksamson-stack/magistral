# BrainDump

Local-first knowledge-graph workstation. C++ core, Electron/TypeScript shell, local Codex CLI.

Desktop first. Web platform is phase 2 — see "Phase 2 seams" below.

## Non-negotiables

1. **The Codex CLI rides the subscription, never API credits.**
   `app/main/Codex/bridge.ts` MUST strip every key in `STRIPPED_ENV_KEYS`
   (`shared/types/Codex.ts`) from the child environment before spawning.
   If `ANTHROPIC_API_KEY` survives into the child, the CLI silently bills the API.
   This has a dedicated unit test. Do not weaken it.

2. **Never pass `--dangerously-skip-permissions`.** The spawned CLI gets
   `--allowedTools "Read" "Grep" "Glob"` and `--add-dir` scoped to the knowledge
   and vault directories only.

3. **`core/` is pure C++17 with zero platform dependencies.** No Node headers, no
   V8, no Emscripten, no N-API. Bindings are thin shells *around* the core. This
   discipline is the entire reason the web phase is a port and not a rewrite —
   the same source compiles to WASM via Emscripten.

4. **The graph is built explicitly.** Nodes come from `[[wikilinks]]` the author
   typed, or from the ✦ Extract Concepts action they clicked. Nothing is inferred
   in the background. No CLI process is ever spawned without a click.

5. **`shared/types/*.ts` are contracts.** Changing one changes another module's
   compile. Coordinate before editing; never edit one to paper over a local
   mismatch.

## Layout

| Path | Owner | Contents |
|---|---|---|
| `shared/` | contracts | Types + JSON schema. The interfaces every module builds against. |
| `core/` | C++ | Graph model, Barnes–Hut layout, algorithms, canonical serializer, link index |
| `bindings/napi/` | C++ | N-API addon wrapping `core/` |
| `bindings/wasm/` | C++ | Emscripten target — scaffolded, built in phase 2 |
| `app/main/` | TS | Window lifecycle, IPC, vault file storage, Codex CLI bridge |
| `app/preload/` | TS | `contextBridge` surface |
| `app/renderer/editor/` | TS | Cell list, CodeMirror 6, `[[wikilink]]` decorations, ✦ menu |
| `app/renderer/graph/` | TS | Canvas 2D renderer, pan/zoom/drag/pin |
| `app/renderer/export/` | TS | YAML outline + interactive HTML export |
| `app/renderer/chat/` | TS | Graph-aware chat pane |
| `resources/knowledge/` | data | 45 bundled corpus files + generated index |

## Commands

```bash
npm run test:core     # compile + run the C++ doctest suite
npm run typecheck     # tsc --noEmit
npm run test          # vitest
npm run verify        # all three, in order
npm run dev           # electron-vite dev
npm run dist          # -> release/BrainDump-0.1.0.dmg
```

Two build directories, deliberately separate:
- `build/` — node-gyp native output (`build/Release/braindump.node`)
- `release/` — electron-builder artifacts

## Running the app

```bash
# 1. rebuild the addon only if C++ changed since the last one
[ "$(ls -t build/Release/braindump.node core/src/*.cpp \
      core/include/braindump/*.hpp bindings/napi/*.cpp | head -1)" \
  = build/Release/braindump.node ] || npm run build:native

# 2. launch (never exits — run it in the background and tail the log)
npm run dev
```

`npm run dev` does main + preload + renderer and opens the window. It does
**not** build the addon — that is the separate node-gyp step above, and a stale
`braindump.node` is the usual reason a fresh clone or a C++ edit fails at boot.

The addon is Node-API (`NAPI_VERSION=8` in `binding.gyp`), so it is ABI-stable
across Node and Electron: the node-gyp output loads in Electron as-is. Reach for
`npm run rebuild:electron` only if you actually see a `NODE_MODULE_VERSION`
mismatch — it is a fallback, not part of the normal loop.

**Startup is confirmed by two lines in the dev log, not by looking at a window:**

```
INFO addon: native core loaded {"path":".../build/Release/braindump.node","version":"0.1.0"}
INFO ipc: registered 39 IPC channels
```

Missing the first line means the addon is stale or absent — go back to step 1.
The renderer serves on `http://localhost:5173`; `lsof -ti:5173` and
`ps aux | grep BrainDump/node_modules/electron` both confirm a live app.

Do not verify with AppleScript/`screencapture`. The Electron process exposes its
AX window to System Events only intermittently, so a failed `window 1` query is
noise, not a launch failure. The log lines are the signal.

## Toolchain notes

`cmake` and `emcc` are NOT installed on the dev machine. The native build uses
**node-gyp** (bundled with npm). Emscripten is a phase-2 install.
Target arch: `darwin-x64`.

Vendored single-headers (do not hand-edit):
- `core/include/nlohmann/json.hpp` — nlohmann/json 3.12, include as `<nlohmann/json.hpp>`
- `core/tests/vendor/doctest.h` — doctest 2.5.0, include as `"doctest.h"`

Verified compiling together with:
`clang++ -std=c++17 -Icore/include -Icore/tests/vendor`

## The C++ public header is a contract

`core/include/braindump/braindump.hpp` is the ONLY surface `bindings/` compiles
against. It depends on the C++17 standard library and nothing else. Implement it
in `core/src/`; put private headers there too, never in the public include dir.

## The bundled corpus

`resources/knowledge/` holds 45 files copied into this project — real files, not
symlinks, no external references. Losing the originals must not break the app.

- `mindset/` (5) — reasoning frames applied to every ✦ invocation
- `sectors/` (39, 11 GICS sectors) — 45–69 KB each, so they are indexed and
  injected at **section** level, never whole-file
- `macroman/` (1) — macro desk conventions

`index.json` maps sector → section → byte range. The bridge slices only the
sections a request actually needs, under `PACK_TOKEN_BUDGET`.

## Phase 2 seams

Two places built now so the web port is mechanical:
- `bindings/wasm/` — same core, Emscripten target
- `app/main/vault.ts` — storage behind an adapter interface; swap files for a DB

## Style

Follows the user's global rules: immutable data, KISS/DRY/YAGNI, files 200–400
lines (800 hard max), functions under 50 lines, early returns over deep nesting,
named constants over magic numbers, explicit error handling with no silent
swallowing.
