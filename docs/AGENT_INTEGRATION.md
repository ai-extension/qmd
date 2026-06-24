# QMD as an AI-agent backend — integration progress & plan

Goal: turn qmd into a backend for a **primary AI** (Claude, etc.) that connects
via MCP/CLI. qmd's local model acts as a **support AI (AI phụ)** that does the
legwork — retrieval, synthesis, deciding where to save docs — while the primary
AI only thinks and decides.

Two engines, two DBs:
- **Docs** → qmd's own `index.sqlite` (FTS5 + sqlite-vec).
- **Code graph** → vendored `graph/` engine (codegraph), its own DB in an
  external store dir.

---

## Architecture decisions (locked)

- **codegraph is vendored under `graph/`, not merged into `src/`.** It builds
  separately (tsc + wasm copy) and is a self-contained engine.
- **Subprocess, not library import.** qmd spawns the engine's CLI by absolute
  path; whitelisted data subcommands only. Decouples runtimes/DBs/failures.
- **`codegraph` is never on PATH and has no back door.** Enforced by: not
  linking the bin + adapter whitelist (`ALLOWED_SUBCOMMANDS`) + telemetry off
  (`DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`). We did NOT delete its 2136-line
  CLI (too risky / breaks on upstream update).
- **AI phụ = a module inside qmd (`src/agent/`), not a separate package and not
  a monorepo.** It reuses `src/llm.ts` (the `generate` model). No code dup with
  `graph/` because the graph engine has no LLM.
- **External graph store** chosen over in-repo `.codegraph/`: we patched the
  engine to honor `CODEGRAPH_STORE` (absolute path) so the indexed repo stays
  clean and all graphs live in one place.

## Runtime constraints (important)

- **graph engine requires Node ≥22.5** (`node:sqlite`, no wasm fallback in
  v1.0.1). Default node is now set to 22 via `nvm alias default 22`
  (v22.23.1). A fresh terminal uses node 22.
- The adapter spawns the engine with a Node binary, falling back to `node` if
  qmd itself runs under Bun. Override with `QMD_GRAPH_NODE`.
- LLM needs **`QMD_LLAMA_GPU=false`** on this Mac (Metal bug
  `ggml_metal_cpy_tensor_async`); already in the user's `.zshrc`.

---

## DONE

### P0 — graph wrapper + registry  ✅ tested
- `src/graph-adapter.ts` — spawn engine (`runGraph` captured, `streamGraph`
  inherit, `runGraphJson`). Whitelist, telemetry off, `CODEGRAPH_STORE` env,
  `nodeExecutable()` (Bun→node fallback), `resolveGraphBin()` (walks up for
  `graph/dist/bin/codegraph.js`; override `QMD_GRAPH_BIN`).
- `src/cli/graph-cmd.ts` — `qmd graph`:
  - `add <repo> <store> --name <n>` — `init` first time / `index --force` re-index; registers in config.
  - `list`, `remove|rm <n>`.
  - passthrough: `query explore node callers callees impact files status sync`
    (require `--name`; engine gets `--path <repo>` + store env; `--json`, `-n` forwarded).
- `src/collections.ts` — `GraphConfig`, `graphs:` registry + `getGraph`,
  `listGraphs`, `addGraph`, `removeGraph`, `NamedGraph`.
- `graph/src/directory.ts` — **patch**: `codeGraphStoreOverride()` +
  `getCodeGraphDir()` honors absolute `CODEGRAPH_STORE`.
- CLI: `case "graph"` in `src/cli/qmd.ts` switch.
- Verified: add (DB lands in store, repo stays clean), list, `callers` passthrough.

### P2 — `qmd ask` combined + AI phụ  ✅ tested
- `src/agent/synthesize.ts` — `synthesizeBrief({question, docs, graphText})`
  → markdown brief `## Summary / ## Sources / ## Code`. Uses
  `getDefaultLlamaCpp().generate()`. System instructions are prepended INLINE to
  the prompt (generate() has no systemPrompt param). Deterministic fallback if
  the model errors.
- `src/cli/ask-cmd.ts` — `qmd ask "<q>" [--graph] [--graph-name <n>] [-c <coll>] [--json]`.
  Doc leg = `hybridQuery` (inside `withLLMSession`); graph leg = `runGraph("explore", …)`
  captured text. Resolves sole graph if `--graph-name` omitted.
- CLI: `case "ask"`; parse options `graph` (bool) + `graph-name` (string) added.
- Verified: docs-only and `--graph` (brief listed functions/files/lines from the call path).

---

## TODO (next sessions)

### P3 — `qmd doc save` (AI phụ decides placement)
- Command: `qmd doc save --key "<key>" --collection <n> "<content>"`.
- Flow: primary AI supplies content + key; AI phụ reads the collection's doc
  tree + key → picks target file + section → writes md (append/create) → reindex.
- Keep it narrow & safe (sandbox model from earlier discussion): a single
  `write_note`-style path, write VERBATIM (no summarizing), prefer append/create
  over blanket overwrite; for true edits use find/replace (see chat). Put the
  writable collection under git for undo. Reuse `getDefaultLlamaCpp().generate()`
  for the placement decision.

### P4 — MCP tools for the primary AI
- Expose in `src/mcp/server.ts`: `ask` (combined brief), `graph_query`/`graph_explore`
  (namespaced `graph_*`), `save_doc`. Plus existing search/get.
- Reuse `runAskCommand`/adapter/synthesize logic (extract shared fns if needed).
- Mirror the existing tool registration pattern (`server.registerTool`). The
  search tool already takes a `collections` filter; add a `graphs`/`graph` arg.

---

## Build / test cheatsheet

```sh
# qmd (tsc → dist). NEVER `bun build --compile`.
npm run build

# graph engine (separate)
cd graph && npm install && npm run build   # needs Node ≥22.5

# run from source
QMD_LLAMA_GPU=false bun src/cli/qmd.ts ask "…" --graph --graph-name <n>

# env for graph when qmd runs under Bun / non-22 node:
export QMD_GRAPH_BIN="$PWD/graph/dist/bin/codegraph.js"
export QMD_GRAPH_NODE="$(nvm which 22)"
```

Config file: `~/.config/qmd/index.yml` (collections, models, `graphs:`).
Expansion model was changed to `hf:Qwen/Qwen2.5-1.5B-Instruct-GGUF/qwen2.5-1.5b-instruct-q4_k_m.gguf`;
its prompt lives in `src/llm.ts` `expandQuery()` (now has a system prompt + grammar).
