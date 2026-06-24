/**
 * `qmd ask "<question>"` — the combined retrieval + synthesis command.
 *
 * Runs doc retrieval (hybrid + rerank) and, with --graph, code-graph explore,
 * then hands both to the support AI (src/agent) which returns a compact brief
 * for the primary agent. The primary agent decides; qmd does the legwork.
 *
 *   qmd ask "<q>" [--graph] [--graph-name <n>] [-c <collection>] [--json]
 */

import { listGraphs, getGraph } from "../collections.js";
import { runGraph, GraphNotBuiltError } from "../graph-adapter.js";
import { withLLMSession } from "../llm.js";
import { hybridQuery, type Store } from "../store.js";
import { synthesizeBrief, extractBrief, selectBrief, toDocInput } from "../agent/synthesize.js";

interface AskValues {
  graph?: boolean;
  "graph-name"?: string;
  collection?: string | string[];
  json?: boolean;
  n?: string;
  "no-rerank"?: boolean;
  "no-expansion"?: boolean;
  extract?: boolean;
  select?: boolean;
  [k: string]: unknown;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Resolve which graph to use: explicit --graph-name, else the sole registered one. */
function resolveGraphName(values: AskValues): string {
  const explicit = values["graph-name"];
  if (explicit) return explicit;
  const all = listGraphs();
  if (all.length === 0) fail("No graphs registered. Add one with: qmd graph add <repo> <store> --name <n>");
  if (all.length === 1) return all[0]!.name;
  fail("Multiple graphs registered — pass --graph-name <n> to pick one.");
}

export async function runAskCommand(
  store: Store,
  args: string[],
  values: AskValues
): Promise<void> {
  const question = args.join(" ").trim();
  if (!question) {
    fail('Usage: qmd ask "<question>" [--graph] [--graph-name <n>] [-c <collection>] [--json]');
  }

  const collection = Array.isArray(values.collection)
    ? values.collection[0]
    : values.collection;
  const limit = values.n ? Math.max(1, parseInt(String(values.n), 10) || 5) : 5;

  // --- Graph leg (optional) — capture explore's formatted text for the brief.
  let graphText: string | undefined;
  let graphName: string | undefined;
  if (values.graph) {
    graphName = resolveGraphName(values);
    const graph = getGraph(graphName);
    if (!graph) fail(`Graph '${graphName}' not found. Run 'qmd graph list'.`);
    try {
      const res = await runGraph("explore", [question, "--path", graph.repo], {
        store: graph.store,
      });
      if (res.code === 0) {
        graphText = res.stdout;
      } else {
        console.error(`(graph explore failed (exit ${res.code}); continuing with docs only)`);
      }
    } catch (err) {
      if (err instanceof GraphNotBuiltError) fail(err.message);
      throw err;
    }
  }

  // --- Doc leg + synthesis (inside an LLM session for embed/rerank/generate).
  const brief = await withLLMSession(async () => {
    const results = await hybridQuery(store, question, {
      collection,
      limit,
      skipRerank: values["no-rerank"] === true,
      skipExpansion: values["no-expansion"] === true,
    });
    // extract = tight window, no model. select/synthesis = wider context.
    const docs = results.map((r) => toDocInput(r, values.extract ? 600 : 2000));
    const synthInput = { question, docs, graphText, graphName };
    if (values.select) return selectBrief(synthInput);   // model picks, verbatim
    if (values.extract) return extractBrief(synthInput); // no model, verbatim
    return synthesizeBrief(synthInput);                  // model rewrites
  });

  if (values.json) {
    console.log(JSON.stringify(brief, null, 2));
  } else {
    console.log(brief.brief);
  }
}
