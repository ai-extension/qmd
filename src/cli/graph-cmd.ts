/**
 * `qmd graph ...` — thin wrapper over the vendored codegraph engine.
 *
 * qmd owns a registry of named graphs (config `graphs:`); the engine owns the
 * actual index DB (in an external store dir via CODEGRAPH_STORE). Query
 * subcommands are pure passthrough: we resolve the named graph, point the
 * engine at its repo + store, and stream its output verbatim.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  addGraph,
  getGraph,
  listGraphs,
  removeGraph,
} from "../collections.js";
import { GraphNotBuiltError, streamGraph } from "../graph-adapter.js";

/** Subcommands that take a registered graph (via --name) and pass through. */
const PASSTHROUGH = new Set([
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

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function printUsage(): void {
  console.log("Usage: qmd graph <command> [options]");
  console.log("");
  console.log("Setup:");
  console.log("  add <repo> <store> --name <n>   Index <repo>; DB stored in <store>");
  console.log("  list                            List registered graphs");
  console.log("  remove <n>                      Remove a graph from the registry");
  console.log("");
  console.log("Query (require --name <n>):");
  console.log("  query <search>     Search symbols by name");
  console.log("  explore <query>    Relevant source + call paths");
  console.log("  node <symbol>      One symbol's source + caller/callee trail");
  console.log("  callers <symbol>   Functions calling a symbol");
  console.log("  callees <symbol>   Functions a symbol calls");
  console.log("  impact <symbol>    Code affected by changing a symbol");
  console.log("  files              File structure from the index");
  console.log("  status             Index status/stats");
  console.log("  sync               Incremental re-index");
  console.log("");
  console.log("Options: --name <n> (which graph), --json, -n <num>, --force");
}

interface GraphCliValues {
  name?: string;
  force?: boolean;
  json?: boolean;
  n?: string;
  [k: string]: unknown;
}

export async function runGraphCommand(
  args: string[],
  values: GraphCliValues
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);

  if (!sub || sub === "help") {
    printUsage();
    process.exit(sub ? 0 : 1);
  }

  try {
    if (sub === "add") {
      await handleAdd(rest, values);
      return;
    }
    if (sub === "list") {
      handleList(Boolean(values.json));
      return;
    }
    if (sub === "remove" || sub === "rm") {
      handleRemove(rest[0]);
      return;
    }
    if (PASSTHROUGH.has(sub)) {
      await handlePassthrough(sub, rest, values);
      return;
    }
    fail(`Unknown graph subcommand: ${sub}\nRun 'qmd graph help'.`);
  } catch (err) {
    if (err instanceof GraphNotBuiltError) fail(err.message);
    throw err;
  }
}

async function handleAdd(rest: string[], values: GraphCliValues): Promise<void> {
  const name = values.name;
  const repoArg = rest[0];
  const storeArg = rest[1];
  if (!name || !repoArg || !storeArg) {
    fail("Usage: qmd graph add <repo> <store> --name <n>");
  }
  const repo = resolve(repoArg);
  const store = resolve(storeArg);
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    fail(`Repo path is not a directory: ${repo}`);
  }
  const alreadyIndexed = existsSync(join(store, "codegraph.db"));
  if (getGraph(name) && alreadyIndexed && !values.force) {
    fail(`Graph '${name}' already exists. Use --force to re-index.`);
  }

  console.error(`Indexing ${repo} → store ${store} (graph '${name}')...`);
  // First time: `init` creates the store DB and builds the index.
  // Re-index: `index --force` rebuilds an existing store.
  const sub = alreadyIndexed ? "index" : "init";
  const subArgs = alreadyIndexed ? [repo, "--force"] : [repo];
  const code = await streamGraph(sub, subArgs, { store });
  if (code !== 0) fail(`graph ${sub} failed (exit ${code})`);

  addGraph(name, { repo, store, db: join(store, "codegraph.db") });
  console.error(`Registered graph '${name}'.`);
}

function handleList(json: boolean): void {
  const graphs = listGraphs();
  if (json) {
    console.log(JSON.stringify(graphs, null, 2));
    return;
  }
  if (graphs.length === 0) {
    console.log("No graphs registered. Add one with: qmd graph add <repo> <store> --name <n>");
    return;
  }
  for (const g of graphs) {
    console.log(`${g.name}`);
    console.log(`  repo:  ${g.repo}`);
    console.log(`  store: ${g.store}`);
  }
}

function handleRemove(name: string | undefined): void {
  if (!name) fail("Usage: qmd graph remove <name>");
  if (removeGraph(name)) {
    console.error(`Removed graph '${name}' from registry. (Store dir left on disk.)`);
  } else {
    fail(`Graph '${name}' not found.`);
  }
}

async function handlePassthrough(
  sub: string,
  rest: string[],
  values: GraphCliValues
): Promise<void> {
  const name = values.name;
  if (!name) fail(`'qmd graph ${sub}' requires --name <graph>`);
  const graph = getGraph(name);
  if (!graph) fail(`Graph '${name}' not found. Run 'qmd graph list'.`);

  // Pass the engine its project root via --path, plus user args and flags.
  const passArgs = [...rest, "--path", graph.repo];
  if (values.json) passArgs.push("--json");
  if (values.n) passArgs.push("--limit", String(values.n));

  const code = await streamGraph(sub, passArgs, { store: graph.store });
  if (code !== 0) process.exit(code);
}
