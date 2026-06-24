/**
 * Adapter for the vendored codegraph engine (graph/).
 *
 * qmd never exposes the `codegraph` binary on PATH — it spawns the engine's
 * compiled CLI by absolute path, with telemetry disabled, and only ever invokes
 * the data subcommands (no install/daemon/upgrade/prompt-hook). This keeps the
 * graph engine a "dumb" indexer/query backend behind `qmd graph ...`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Subcommands qmd is allowed to invoke. Anything self-registering is excluded. */
const ALLOWED_SUBCOMMANDS = new Set([
  "init",
  "index",
  "sync",
  "status",
  "query",
  "explore",
  "node",
  "callers",
  "callees",
  "impact",
  "files",
]);

/**
 * The Node executable to spawn the engine with. The graph engine requires
 * Node (web-tree-sitter + node-sqlite); it cannot run under Bun. qmd's CLI runs
 * under Node in production (process.execPath = node), but when qmd is run under
 * Bun (dev), process.execPath is Bun — so fall back to `node` from PATH.
 * Override with QMD_GRAPH_NODE.
 */
function nodeExecutable(): string {
  const override = process.env.QMD_GRAPH_NODE?.trim();
  if (override) return override;
  const exec = process.execPath;
  return /bun/i.test(exec) ? "node" : exec;
}

let _graphBin: string | null | undefined;

/**
 * Locate the compiled graph CLI (graph/dist/bin/codegraph.js).
 * Override with QMD_GRAPH_BIN. Returns null if not built yet.
 */
export function resolveGraphBin(): string | null {
  if (_graphBin !== undefined) return _graphBin;

  const override = process.env.QMD_GRAPH_BIN?.trim();
  if (override) {
    _graphBin = existsSync(override) ? override : null;
    return _graphBin;
  }

  // Walk up from this module looking for graph/dist/bin/codegraph.js
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = resolve(current, "graph", "dist", "bin", "codegraph.js");
    if (existsSync(candidate)) {
      _graphBin = candidate;
      return _graphBin;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  _graphBin = null;
  return _graphBin;
}

/** Error thrown when the graph engine has not been built. */
export class GraphNotBuiltError extends Error {
  constructor() {
    super(
      "graph engine is not built. Run:\n  cd graph && npm install && npm run build"
    );
    this.name = "GraphNotBuiltError";
  }
}

export interface GraphRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Spawn the graph CLI with a whitelisted subcommand. Telemetry is force-disabled.
 * Resolves with captured output regardless of exit code (callers inspect `code`).
 */
export function runGraph(
  subcommand: string,
  args: string[] = [],
  opts: { cwd?: string; store?: string } = {}
): Promise<GraphRunResult> {
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`graph subcommand not allowed: ${subcommand}`);
  }
  const bin = resolveGraphBin();
  if (!bin) throw new GraphNotBuiltError();

  return new Promise((resolvePromise, reject) => {
    const child = spawn(nodeExecutable(), [bin, subcommand, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        // Kill the phone-home: the engine runs purely as a local backend.
        DO_NOT_TRACK: "1",
        CODEGRAPH_TELEMETRY: "0",
        // Relocate the index DB to an external store dir (patched into the
        // engine's directory.ts) so the indexed repo stays clean.
        ...(opts.store ? { CODEGRAPH_STORE: opts.store } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      resolvePromise({ code: code ?? 0, stdout, stderr })
    );
  });
}

/**
 * Spawn a whitelisted subcommand with inherited stdio, streaming the engine's
 * formatted output straight to the user's terminal. Used for passthrough
 * commands (query/explore/status/...). Resolves with the exit code.
 */
export function streamGraph(
  subcommand: string,
  args: string[] = [],
  opts: { cwd?: string; store?: string } = {}
): Promise<number> {
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`graph subcommand not allowed: ${subcommand}`);
  }
  const bin = resolveGraphBin();
  if (!bin) throw new GraphNotBuiltError();

  return new Promise((resolvePromise, reject) => {
    const child = spawn(nodeExecutable(), [bin, subcommand, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        DO_NOT_TRACK: "1",
        CODEGRAPH_TELEMETRY: "0",
        ...(opts.store ? { CODEGRAPH_STORE: opts.store } : {}),
      },
      // stdin ignored so the engine never blocks on an interactive prompt;
      // stdout/stderr stream the engine's formatted output to the terminal.
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 0));
  });
}

/** Run a subcommand expecting --json output; parse and return it. */
export async function runGraphJson<T = unknown>(
  subcommand: string,
  args: string[] = [],
  opts: { cwd?: string; store?: string } = {}
): Promise<T> {
  const res = await runGraph(subcommand, [...args, "--json"], opts);
  if (res.code !== 0) {
    throw new Error(
      `graph ${subcommand} failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`
    );
  }
  try {
    return JSON.parse(res.stdout) as T;
  } catch {
    throw new Error(
      `graph ${subcommand} did not return valid JSON:\n${res.stdout.slice(0, 500)}`
    );
  }
}
