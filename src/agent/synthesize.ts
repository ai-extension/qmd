/**
 * AI-phụ (support AI) synthesis.
 *
 * The main AI asks a question; qmd's local generate model does the legwork —
 * reading doc retrieval results and (optionally) code-graph output, then
 * distilling them into a compact, decision-ready brief. The main AI only ever
 * sees the brief, keeping its context small.
 *
 * This module is the logical boundary for the "support AI": it owns nothing but
 * the synthesis prompt and reuses qmd's existing local LLM (src/llm.ts).
 */

import { getDefaultLlamaCpp } from "../llm.js";

/** One retrieved document chunk fed into synthesis. */
export interface DocInput {
  displayPath: string;
  title: string;
  snippet: string;
  score: number;
}

/** Fields of a hybrid search result this module needs to build a snippet. */
export interface ResultLike {
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  score: number;
}

/**
 * Build a DocInput with a SUBSTANTIAL excerpt — not just the tiny best-matching
 * chunk, which often grabs only a heading and starves synthesis of the actual
 * content. Small docs are passed whole; large docs get a wide window centered on
 * the best chunk.
 */
export function toDocInput(r: ResultLike, maxChars = 2000): DocInput {
  let snippet: string;
  if (r.body && r.body.length <= maxChars) {
    snippet = r.body;
  } else if (r.body) {
    const start = Math.max(0, (r.bestChunkPos ?? 0) - Math.floor(maxChars / 4));
    snippet = r.body.slice(start, start + maxChars);
  } else {
    snippet = r.bestChunk ?? "";
  }
  return { displayPath: r.displayPath, title: r.title, snippet, score: r.score };
}

export interface SynthesizeInput {
  question: string;
  docs: DocInput[];
  /** Raw formatted output from `graph explore`, if the graph leg ran. */
  graphText?: string;
  graphName?: string;
}

const SYNTHESIS_SYSTEM = [
  "You are a support assistant for a primary AI agent. You are given a QUESTION",
  "plus raw retrieval material: documentation excerpts and (optionally) code-graph",
  "output (functions, files, call paths). Distill it into a compact brief the",
  "primary agent can act on. You do the reading; it does the deciding.",
  "",
  "Answer the SPECIFIC question asked — lead with the direct answer. The excerpts",
  "are ranked by a search score but the top one may be off-topic; use whichever",
  "excerpt actually addresses the question and IGNORE tangential platform overviews.",
  "Never pad the summary with general descriptions the question didn't ask for.",
  "",
  "Write the brief in this exact markdown shape:",
  "## Summary",
  "<2-5 sentences answering the question from the material. If the material is",
  "insufficient, say so plainly.>",
  "## Sources",
  "<bullet list of the doc paths you used, most relevant first: `- path — why>`",
  "## Code",
  "<only if code-graph material is present: bullet the relevant functions/files",
  "as `- symbol (file:line) — role`. Omit this whole section otherwise.>",
  "",
  "Rules: ground every claim in the supplied material — never invent paths,",
  "symbols, or facts. Be terse. No preamble, no closing remarks.",
].join("\n");

/**
 * Reorder docs so those whose path/title share words with the question come
 * first. The reranker can bury the on-topic doc (e.g. its best chunk was just a
 * heading), and the small synthesis model anchors heavily on the FIRST excerpt
 * — so a cheap lexical title-match boost markedly improves the answer.
 * Stable: ties keep their original (score) order.
 */
function orderByTopicMatch(question: string, docs: DocInput[]): DocInput[] {
  const qTokens = new Set(
    question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2)
  );
  if (qTokens.size === 0) return docs;
  const score = (d: DocInput): number => {
    const hay = `${d.displayPath} ${d.title}`.toLowerCase();
    let n = 0;
    for (const t of qTokens) if (hay.includes(t)) n++;
    return n;
  };
  return docs
    .map((d, i) => ({ d, i, s: score(d) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.d);
}

function buildUserPrompt(input: SynthesizeInput): string {
  const parts: string[] = [`QUESTION: ${input.question}`, ""];

  const ordered = orderByTopicMatch(input.question, input.docs);
  parts.push("=== DOCUMENTATION EXCERPTS ===");
  if (ordered.length === 0) {
    parts.push("(none retrieved)");
  } else {
    ordered.forEach((d, i) => {
      parts.push(
        `[${i + 1}] ${d.displayPath} (score ${d.score.toFixed(3)})` +
          (d.title ? ` — ${d.title}` : "")
      );
      parts.push(d.snippet.trim());
      parts.push("");
    });
  }

  if (input.graphText && input.graphText.trim()) {
    parts.push("");
    parts.push(`=== CODE GRAPH (${input.graphName ?? "graph"}) ===`);
    parts.push(input.graphText.trim());
  }

  return parts.join("\n");
}

export interface Brief {
  question: string;
  brief: string;
  usedGraph: boolean;
}

/**
 * Run the support-AI synthesis. Returns the brief text (markdown). Falls back to
 * a minimal stitched brief if the local model is unavailable or errors, so `ask`
 * never hard-fails just because generation didn't run.
 */
export async function synthesizeBrief(input: SynthesizeInput): Promise<Brief> {
  const usedGraph = Boolean(input.graphText && input.graphText.trim());
  // generate() has no systemPrompt parameter, so the task instructions are
  // prepended inline to the user material.
  const prompt = `${SYNTHESIS_SYSTEM}\n\n${buildUserPrompt(input)}`;

  try {
    const llm = getDefaultLlamaCpp();
    const result = await llm.generate(prompt, {
      maxTokens: 900,
      temperature: 0.3,
    });
    const text = result?.text?.trim();
    if (text) return { question: input.question, brief: text, usedGraph };
  } catch {
    // fall through to the deterministic fallback
  }

  return {
    question: input.question,
    brief: fallbackBrief(input),
    usedGraph,
  };
}

/**
 * Extractive brief — NO generation. Cuts and concatenates the relevant excerpts
 * verbatim (most on-topic doc first) plus any graph output. Zero hallucination,
 * the synthesis model never runs. Use when fidelity/speed matter more than prose.
 */
export function extractBrief(input: SynthesizeInput): Brief {
  const usedGraph = Boolean(input.graphText && input.graphText.trim());
  const ordered = orderByTopicMatch(input.question, input.docs);
  const lines: string[] = [`# ${input.question}`, "", "## Matches"];
  if (ordered.length === 0) {
    lines.push("(no documentation matched)");
  } else {
    for (const d of ordered) {
      lines.push("", `### ${d.displayPath}${d.title ? ` — ${d.title}` : ""} (score ${d.score.toFixed(3)})`);
      lines.push(d.snippet.trim());
    }
  }
  if (usedGraph) {
    lines.push("", `## Code (${input.graphName ?? "graph"})`, "```", input.graphText!.trim(), "```");
  }
  return { question: input.question, brief: lines.join("\n"), usedGraph };
}

/**
 * Model-SELECTED extractive brief. The model picks the most relevant passages
 * but quotes are VERBATIM: candidates are numbered, the model returns only the
 * indices, and we re-emit the exact source text for those indices — so the
 * model decides relevance without any chance to paraphrase. Falls back to plain
 * extraction if the model is unavailable or returns no usable indices.
 */
export async function selectBrief(input: SynthesizeInput, maxQuotes = 6): Promise<Brief> {
  const usedGraph = Boolean(input.graphText && input.graphText.trim());
  const ordered = orderByTopicMatch(input.question, input.docs);

  // Build numbered candidate passages (paragraph-level), capped for prompt size.
  const candidates: { path: string; text: string }[] = [];
  for (const d of ordered) {
    for (const para of d.snippet.split(/\n\s*\n/)) {
      const text = para.trim();
      if (text.length >= 15) candidates.push({ path: d.displayPath, text });
      if (candidates.length >= 40) break;
    }
    if (candidates.length >= 40) break;
  }

  if (candidates.length === 0) {
    return { question: input.question, brief: fallbackBrief(input), usedGraph };
  }

  const numbered = candidates
    .map((c, i) => `[${i + 1}] (${c.path}) ${c.text.replace(/\s+/g, " ").slice(0, 300)}`)
    .join("\n");
  const prompt =
    "Select the passages that best answer the QUESTION. Reply with ONLY their " +
    "numbers, most relevant first, comma-separated (e.g. 3, 1, 7). No other text.\n\n" +
    `QUESTION: ${input.question}\n\nPASSAGES:\n${numbered}`;

  let picks: number[] = [];
  try {
    const llm = getDefaultLlamaCpp();
    const result = await llm.generate(prompt, { maxTokens: 40, temperature: 0 });
    picks = (result?.text ?? "")
      .match(/\d+/g)
      ?.map((n) => parseInt(n, 10))
      .filter((n) => n >= 1 && n <= candidates.length) ?? [];
  } catch {
    /* fall through to fallback below */
  }
  // Dedupe preserving order; cap.
  picks = [...new Set(picks)].slice(0, maxQuotes);
  if (picks.length === 0) {
    return { question: input.question, brief: extractBrief(input).brief, usedGraph };
  }

  const lines: string[] = [`# ${input.question}`, "", "## Relevant excerpts (verbatim, model-selected)"];
  for (const n of picks) {
    const c = candidates[n - 1]!;
    lines.push("", c.text, `— ${c.path}`);
  }
  if (usedGraph) {
    lines.push("", `## Code (${input.graphName ?? "graph"})`, "```", input.graphText!.trim(), "```");
  }
  return { question: input.question, brief: lines.join("\n"), usedGraph };
}

/** Deterministic brief when the LLM can't run — just lists what was found. */
function fallbackBrief(input: SynthesizeInput): string {
  const lines: string[] = ["## Summary", "(synthesis model unavailable — raw matches below)", "", "## Sources"];
  if (input.docs.length === 0) {
    lines.push("- (no documentation matched)");
  } else {
    for (const d of input.docs) {
      lines.push(`- ${d.displayPath} (score ${d.score.toFixed(3)})`);
    }
  }
  if (input.graphText && input.graphText.trim()) {
    lines.push("", "## Code", "```", input.graphText.trim(), "```");
  }
  return lines.join("\n");
}
