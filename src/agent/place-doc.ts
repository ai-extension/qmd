/**
 * AI-phụ doc placement.
 *
 * The primary AI hands over content + a key; the support model decides WHICH
 * file in the collection it belongs in (an existing one, or a new one) and
 * whether to append or create. The content itself is written VERBATIM by the
 * caller — this module only decides location, never rewrites the text.
 */

import { getDefaultLlamaCpp } from "../llm.js";

export interface PlacementInput {
  key: string;
  content: string;
  /** Existing .md files in the collection, relative paths. */
  existingFiles: string[];
}

export interface Placement {
  /** Relative .md path within the collection. */
  file: string;
  mode: "append" | "create";
}

const PLACE_SYSTEM = [
  "You file documentation. Given a KEY (short topic), the CONTENT to store, and",
  "the list of EXISTING files in a docs collection, decide where the content",
  "belongs. Prefer appending to the most topically-related existing file; create",
  "a new file only when nothing fits.",
  "",
  "Reply in EXACTLY this format, nothing else:",
  "FILE: <relative path ending in .md>",
  "MODE: append | create",
  "",
  "Each EXISTING entry is `path — topic`; FILE must be just the path part",
  "(before the —), used verbatim, when appending. FILE must be a relative path",
  "(no leading /, no ..). For a new file pick a short kebab-case name related to",
  "the KEY. Do not output the content or any commentary.",
].join("\n");

/** kebab-case slug from the key, for the fallback filename. */
export function slugify(key: string): string {
  const s = key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  return s || "note";
}

function parseDecision(text: string): Placement | null {
  const fileMatch = text.match(/FILE:\s*(.+)/i);
  const modeMatch = text.match(/MODE:\s*(append|create)/i);
  if (!fileMatch) return null;
  let file = fileMatch[1]!.trim();
  // If the model echoed the enriched "path — topic" line, keep only the path.
  file = file.split(/\s+[—-]\s+/)[0]!.trim().replace(/^["'`]|["'`]$/g, "");
  if (!file) return null;
  if (!file.toLowerCase().endsWith(".md")) file += ".md";
  const mode = (modeMatch?.[1]?.toLowerCase() as "append" | "create") ?? "create";
  return { file, mode };
}

/**
 * Decide placement via the local model. Falls back to a new kebab-case file
 * derived from the key if the model is unavailable or returns garbage. Returned
 * paths are NOT yet safety-validated — the caller sanitizes against the
 * collection root.
 */
export async function decidePlacement(input: PlacementInput): Promise<Placement> {
  const fileList = input.existingFiles.length
    ? input.existingFiles.map((f) => `- ${f}`).join("\n")
    : "(none yet)";
  const preview = input.content.slice(0, 1200);
  const prompt =
    `${PLACE_SYSTEM}\n\n` +
    `KEY: ${input.key}\n\n` +
    `EXISTING FILES:\n${fileList}\n\n` +
    `CONTENT:\n${preview}`;

  try {
    const llm = getDefaultLlamaCpp();
    const result = await llm.generate(prompt, { maxTokens: 60, temperature: 0.1 });
    const decision = result?.text ? parseDecision(result.text) : null;
    if (decision) return decision;
  } catch {
    // fall through
  }
  return { file: `${slugify(input.key)}.md`, mode: "create" };
}
