# Magistral

A local-first context builder for organizing human and LLM knowledge. Write in
cells, wrap a concept in `[[brackets]]`, and the graph is the by-product — not a
schema you design first.

C++17 core, Electron/TypeScript shell, and your own local Claude CLI. Your notes
stay on your disk.

---

## What makes it different

**It never talks to the network.** There is no `fetch`, no HTTP client, no
WebSocket, no telemetry, no analytics and no crash reporting anywhere in this
codebase. The only process it starts is the `claude` CLI you already have
installed, and the only files it reads are the ones in the vault you point it at.

**It rides your subscription, not metered API credits.**
`app/main/claude/env.ts` strips `ANTHROPIC_API_KEY` and friends from the child
environment before spawning the CLI. If that key leaks through, the CLI quietly
bills the API instead of using your logged-in session, with no visible
difference in the output — so it is a pure function with a dedicated unit test
rather than three lines inlined at the spawn site.

**The renderer is treated as untrusted.** `contextIsolation` on,
`nodeIntegration` off, `sandbox` on, `webSecurity` on, and no remote content is
ever loaded. Every IPC payload is validated at the boundary in
`app/main/guards.ts`. The spawned CLI is given `--allowedTools "Read" "Grep"
"Glob"` with `--add-dir` scoped to the knowledge and vault directories, and is
never passed `--dangerously-skip-permissions`.

**Nothing is inferred in the background.** Nodes come from wikilinks you typed
or from the Extract Concepts action you clicked. No CLI process is ever spawned
without a click.

## Requirements

- The [Claude CLI](https://docs.claude.com/en/docs/claude-code), logged in
- Node.js 20+ and a C++17 toolchain, to build from source

## Build from source

```bash
npm install
npm run verify     # C++ core tests, typecheck, and the TypeScript suite
npm run dev        # run it
npm run dist       # package an installer into release/
```

## Knowledge packs

Magistral can slice a reference corpus into each request, budgeted by token
count and selected by keyword against what you are working on
(`app/main/claude/packs.ts`).

**No corpus ships with this repository.** `resources/knowledge/` contains only
`_system/`, the instruction wording for each action. Point the app at your own
vault and supply your own material; with no `index.json` present the packs
degrade to whatever you have provided, which is a logged warning rather than an
error.

## Layout

| Path | What lives there |
|---|---|
| `core/` | Pure C++17 graph core. No Node headers, no V8, no N-API — the reason a web port is a port and not a rewrite. |
| `bindings/` | Thin N-API shell around the core. |
| `app/main/` | Electron main process: vault I/O, IPC guards, the Claude bridge. |
| `app/renderer/` | React UI — editor, graph canvas, chat. |
| `shared/types/` | Contracts shared across the boundary. Changing one changes another module's compile. |

`CLAUDE.md` carries the architectural non-negotiables and is worth reading
before a first change.

## License

MIT — see [LICENSE](LICENSE).
