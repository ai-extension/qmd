/**
 * Shared core for `qmd doc save` (CLI) and the `save_doc` MCP tool.
 *
 * Lists the collection's docs, lets the support model pick a target file +
 * append/create mode, then writes the content VERBATIM (never summarized) to a
 * path sanitized against the collection root.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import fastGlob from "fast-glob";
import { getCollection } from "../collections.js";
import { withLLMSession } from "../llm.js";
import { decidePlacement, slugify } from "./place-doc.js";

export interface SaveDocResult {
  collection: string;
  file: string; // relative path written
  mode: "append" | "create";
  bytes: number;
  indexed: boolean; // true if the collection is watched (auto-refreshes on read)
}

export class SaveDocError extends Error {}

/** Build "path — Title: first line" cues so the model has topical signal. */
async function listEnrichedFiles(root: string, pattern: string): Promise<string[]> {
  const files = await fastGlob(pattern || "**/*.md", {
    cwd: root,
    onlyFiles: true,
    dot: false,
  });
  return files.map((f) => {
    let cue = "";
    try {
      const text = readFileSync(join(root, f), "utf-8");
      const heading = text.match(/^#+\s*(.+)/m)?.[1]?.trim();
      const firstLine = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("#"));
      cue = [heading, firstLine].filter(Boolean).join(": ").slice(0, 100);
    } catch {
      /* unreadable — bare path */
    }
    return cue ? `${f} — ${cue}` : f;
  });
}

/**
 * Decide placement and write the content. Throws SaveDocError on bad input
 * (unknown collection, empty content).
 */
export async function saveDocToCollection(opts: {
  collectionName: string;
  key: string;
  content: string;
}): Promise<SaveDocResult> {
  const { collectionName, key, content } = opts;
  if (!content.trim()) throw new SaveDocError("No content to save.");

  const collection = getCollection(collectionName);
  if (!collection) {
    throw new SaveDocError(`Collection '${collectionName}' not found.`);
  }

  const root = resolve(collection.path);
  const existingFiles = await listEnrichedFiles(root, collection.pattern);

  const decision = await withLLMSession(async () =>
    decidePlacement({ key, content, existingFiles })
  );

  // Sanitize the chosen path against the collection root.
  let rel = decision.file.replace(/^[/\\]+/, "");
  let target = resolve(root, rel);
  const within = target === root || target.startsWith(root + "/");
  if (!within || rel.includes("..")) {
    rel = `${slugify(key)}.md`;
    target = resolve(root, rel);
  }

  // create→append if it already exists; append→create if it doesn't.
  const mode: "append" | "create" = existsSync(target) ? "append" : "create";

  mkdirSync(dirname(target), { recursive: true });
  if (mode === "create") {
    writeFileSync(target, `# ${key}\n\n${content.trimEnd()}\n`, "utf-8");
  } else {
    const prev = readFileSync(target, "utf-8").trimEnd();
    writeFileSync(target, `${prev}\n\n## ${key}\n\n${content.trimEnd()}\n`, "utf-8");
  }

  return {
    collection: collectionName,
    file: relative(root, target),
    mode,
    bytes: Buffer.byteLength(content, "utf-8"),
    indexed: collection.watch === true,
  };
}
