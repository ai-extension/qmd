/**
 * `qmd doc save` — store content into a docs collection, with the support AI
 * deciding the file/location.
 *
 *   qmd doc save --collection <n> --key "<key>" "<content>"
 *   qmd doc save --collection <n> --key "<key>" -        # content from stdin
 *
 * The primary AI supplies content + key; qmd's model picks the target file and
 * append/create mode; the content is written VERBATIM (never summarized).
 */

import { getCollection } from "../collections.js";
import { saveDocToCollection, SaveDocError } from "../agent/save-doc.js";

interface DocValues {
  collection?: string | string[];
  key?: string;
  json?: boolean;
  [k: string]: unknown;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

export async function runDocCommand(
  args: string[],
  values: DocValues
): Promise<void> {
  const sub = args[0];
  if (sub !== "save") {
    fail('Usage: qmd doc save --collection <n> --key "<key>" "<content>"');
  }

  const collectionName = Array.isArray(values.collection)
    ? values.collection[0]
    : values.collection;
  if (!collectionName) fail("Missing --collection <name>");
  const key = values.key;
  if (!key) fail("Missing --key <key>");

  // Content: positional, or stdin when "-" / empty.
  const rest = args.slice(1);
  let content = rest.join(" ");
  if (content.trim() === "-" || content.trim() === "") {
    content = await readStdin();
  }
  if (!content.trim()) fail("No content to save (pass as an argument or via stdin).");

  let result;
  try {
    result = await saveDocToCollection({ collectionName, key, content });
  } catch (err) {
    if (err instanceof SaveDocError) fail(err.message);
    throw err;
  }

  if (values.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.error(`${result.mode === "create" ? "Created" : "Appended to"} ${collectionName}/${result.file}`);
  const collection = getCollection(collectionName);
  if (collection && !collection.watch) {
    console.error("Note: collection is not watched — run 'qmd update' + 'qmd embed' to make it searchable.");
  }
}
