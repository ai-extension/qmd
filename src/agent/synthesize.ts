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

function buildUserPrompt(input: SynthesizeInput): string {
  const parts: string[] = [`QUESTION: ${input.question}`, ""];

  parts.push("=== DOCUMENTATION EXCERPTS ===");
  if (input.docs.length === 0) {
    parts.push("(none retrieved)");
  } else {
    input.docs.forEach((d, i) => {
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
